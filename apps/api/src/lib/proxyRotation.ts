import { fetch, Agent } from "undici";
import type { Logger } from "winston";
import { config } from "../config";
import {
  hasPrimaryProxyPool,
  hasProxyFallback,
  resetProxyDispatchers,
  runWithProxySlot,
  type ProxySlot,
} from "../scraper/scrapeURL/engines/utils/safeFetch";

const directAgent = new Agent({
  connect: { rejectUnauthorized: true },
});

function collectErrorMessages(err: unknown): string {
  const parts: string[] = [];
  const walk = (e: unknown): void => {
    if (e == null) return;
    if (e instanceof Error) {
      parts.push(e.message);
      walk((e as { cause?: unknown }).cause);
    } else {
      parts.push(String(e));
    }
  };
  walk(err);
  return parts.join(" | ");
}

/** HTTP-код ответа прокси на CONNECT (не 200): 407, 522, 502… */
export function parseProxyTunnelHttpStatus(err: unknown): number | undefined {
  const m = collectErrorMessages(err).match(
    /Proxy response \((\d+)\) !== 200 when HTTP Tunneling/i,
  );
  if (!m) return undefined;
  return parseInt(m[1], 10);
}

/** Имеет смысл перейти на следующий endpoint из PROXY_SERVER_LIST(_FILE). */
export function shouldRetryFetchWithAlternatePoolEndpoint(
  err: unknown,
): boolean {
  return parseProxyTunnelHttpStatus(err) !== undefined;
}

let rotationQueue: Promise<void> = Promise.resolve();
let lastRotationTime = 0;

let fallbackRotationQueue: Promise<void> = Promise.resolve();
let lastFallbackRotationTime = 0;

function proxyRotationEnabled(): boolean {
  const url = config.PROXY_ROTATION_URL?.trim();
  return !!(hasPrimaryProxyPool() && url);
}

function fallbackProxyRotationEnabled(): boolean {
  const url = config.PROXY_FALLBACK_ROTATION_URL?.trim();
  return !!(hasProxyFallback() && url);
}

function parseRotationStatuses(): number[] {
  return config.PROXY_ROTATION_STATUSES.split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n));
}

/** Повторять запрос при этих HTTP-кодах (после сброса / смены IP). */
function shouldRetryHttpForProxy(status: number): boolean {
  if (!hasPrimaryProxyPool()) return false;
  return parseRotationStatuses().includes(status);
}

function postDelayMs(): number {
  return config.PROXY_ROTATION_POST_DELAY_MS;
}

async function callRotationUrl(
  log: Logger,
  rotationUrl: string,
  ctx: { reason: string; statusCode?: number; label: string },
): Promise<void> {
  log.info(`${ctx.label}: requesting IP rotation`, {
    reason: ctx.reason,
    statusCode: ctx.statusCode,
  });

  try {
    const res = await fetch(rotationUrl, {
      dispatcher: directAgent,
      redirect: "follow",
    });
    if (!res.ok) {
      log.warn(`${ctx.label}: rotation endpoint returned non-OK`, {
        status: res.status,
      });
    }
  } catch (e) {
    log.warn(`${ctx.label}: rotation endpoint request failed`, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Запрос смены IP у провайдера основного прокси (без прокси), сброс slot 0,
 * пауза перед следующим запросом. Вызовы сериализуются (cooldown).
 */
async function rotatePrimaryProxyAndReset(
  log: Logger,
  ctx: { reason: string; statusCode?: number },
): Promise<void> {
  const rotationUrl = config.PROXY_ROTATION_URL?.trim();
  if (!rotationUrl || !hasPrimaryProxyPool()) return;

  const cooldown = config.PROXY_ROTATION_COOLDOWN_MS;
  const postDelay = postDelayMs();

  rotationQueue = rotationQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, cooldown - (now - lastRotationTime));
    if (wait > 0) {
      await new Promise<void>(r => setTimeout(r, wait));
    }

    await callRotationUrl(log, rotationUrl, {
      ...ctx,
      label: "Primary proxy",
    });

    await resetProxyDispatchers(0);
    lastRotationTime = Date.now();

    if (postDelay > 0) {
      await new Promise<void>(r => setTimeout(r, postDelay));
    }
  });

  await rotationQueue;
}

async function rotateFallbackProxyAndReset(
  log: Logger,
  ctx: { reason: string; statusCode?: number },
): Promise<void> {
  const rotationUrl = config.PROXY_FALLBACK_ROTATION_URL?.trim();
  if (!rotationUrl) return;

  const cooldown = config.PROXY_ROTATION_COOLDOWN_MS;
  const postDelay = postDelayMs();

  fallbackRotationQueue = fallbackRotationQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, cooldown - (now - lastFallbackRotationTime));
    if (wait > 0) {
      await new Promise<void>(r => setTimeout(r, wait));
    }

    await callRotationUrl(log, rotationUrl, {
      ...ctx,
      label: "Fallback proxy",
    });

    await resetProxyDispatchers(1);
    lastFallbackRotationTime = Date.now();

    if (postDelay > 0) {
      await new Promise<void>(r => setTimeout(r, postDelay));
    }
  });

  await fallbackRotationQueue;
}

function isProxyTransportError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (e: unknown): boolean => {
    if (e == null || seen.has(e)) return false;
    seen.add(e);
    const ex = e as any;
    const code = ex?.code ?? ex?.errno;
    if (
      typeof code === "string" &&
      [
        "ECONNRESET",
        "EPIPE",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENETUNREACH",
        "EAI_AGAIN",
        "ENOTFOUND",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_RESPONSE",
      ].includes(code)
    ) {
      return true;
    }
    const msg = String(ex?.message ?? "");
    if (
      /ECONNRESET|socket hang up|other side closed|ECONNREFUSED|ETIMEDOUT|Connect Timeout|Headers Timeout|Body Timeout|fetch failed/i.test(
        msg,
      )
    ) {
      return true;
    }
    return walk(ex?.cause);
  };
  return walk(err);
}

async function recoverAfterProxyTransportFailure(
  log: Logger,
  err: unknown,
  slot: ProxySlot,
): Promise<void> {
  if (!hasPrimaryProxyPool()) return;

  log.warn("Proxy: transport error, resetting connections", {
    slot,
    proxyTunnelHttpStatus: parseProxyTunnelHttpStatus(err),
    error: err instanceof Error ? err.message : String(err),
  });

  if (slot === 1) {
    if (fallbackProxyRotationEnabled()) {
      await rotateFallbackProxyAndReset(log, { reason: "transport_error" });
    } else {
      await resetProxyDispatchers(1);
      const d = postDelayMs();
      if (d > 0) {
        await new Promise<void>(r => setTimeout(r, d));
      }
    }
    return;
  }

  if (
    proxyRotationEnabled() &&
    config.PROXY_ROTATION_ON_TRANSPORT_ERROR !== false
  ) {
    await rotatePrimaryProxyAndReset(log, { reason: "transport_error" });
  } else {
    await resetProxyDispatchers(0);
    const d = postDelayMs();
    if (d > 0) {
      await new Promise<void>(r => setTimeout(r, d));
    }
  }
}

async function recoverAfterHttpRetryable(
  log: Logger,
  slot: ProxySlot,
  statusCode: number,
  primaryRotationUsed: boolean,
  primaryPlainResetDone: boolean,
): Promise<{
  primaryRotationUsed: boolean;
  primaryPlainResetDone: boolean;
  slot: ProxySlot;
}> {
  if (slot === 0) {
    if (proxyRotationEnabled() && !primaryRotationUsed) {
      await rotatePrimaryProxyAndReset(log, {
        reason: "http_status",
        statusCode,
      });
      return {
        primaryRotationUsed: true,
        primaryPlainResetDone,
        slot: 0,
      };
    }
    if (
      hasProxyFallback() &&
      !proxyRotationEnabled() &&
      !primaryPlainResetDone
    ) {
      log.warn(
        "HTTP status on primary; resetting connections before fallback",
        {
          status: statusCode,
        },
      );
      await resetProxyDispatchers(0);
      const d = postDelayMs();
      if (d > 0) {
        await new Promise<void>(r => setTimeout(r, d));
      }
      return {
        primaryRotationUsed,
        primaryPlainResetDone: true,
        slot: 0,
      };
    }
    if (hasProxyFallback()) {
      log.info("Proxy: switching to fallback after primary retries exhausted", {
        statusCode,
      });
      await resetProxyDispatchers(1);
      const d = postDelayMs();
      if (d > 0) {
        await new Promise<void>(r => setTimeout(r, d));
      }
      return {
        primaryRotationUsed,
        primaryPlainResetDone,
        slot: 1,
      };
    }
    log.warn("HTTP status suggests retry; resetting primary proxy dispatcher", {
      status: statusCode,
    });
    await resetProxyDispatchers(0);
    const d = postDelayMs();
    if (d > 0) {
      await new Promise<void>(r => setTimeout(r, d));
    }
    return {
      primaryRotationUsed,
      primaryPlainResetDone,
      slot: 0,
    };
  }

  if (fallbackProxyRotationEnabled()) {
    await rotateFallbackProxyAndReset(log, {
      reason: "http_status",
      statusCode,
    });
  } else {
    log.warn("HTTP status on fallback; resetting fallback connections", {
      status: statusCode,
    });
    await resetProxyDispatchers(1);
    const d = postDelayMs();
    if (d > 0) {
      await new Promise<void>(r => setTimeout(r, d));
    }
  }
  return {
    primaryRotationUsed,
    primaryPlainResetDone,
    slot: 1,
  };
}

/**
 * Выполняет fetch с повтором после 403/429 и обрывов: сначала основной прокси
 * (с API ротации при необходимости), затем резервный провайдер.
 */
export async function executeFetchWithProxyRotation(
  log: Logger,
  exec: () => Promise<import("undici").Response>,
): Promise<import("undici").Response> {
  const maxAttempts = hasPrimaryProxyPool()
    ? config.PROXY_ROTATION_MAX_ATTEMPTS
    : 1;

  let lastError: unknown;
  let slot: ProxySlot = 0;
  let primaryRotationUsed = false;
  let primaryPlainResetDone = false;
  let transportFailuresOnPrimary = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await runWithProxySlot(slot, () => exec());

      if (slot === 0) {
        transportFailuresOnPrimary = 0;
      }

      if (shouldRetryHttpForProxy(res.status) && attempt < maxAttempts - 1) {
        await res.arrayBuffer().catch(() => {});
        const next = await recoverAfterHttpRetryable(
          log,
          slot,
          res.status,
          primaryRotationUsed,
          primaryPlainResetDone,
        );
        primaryRotationUsed = next.primaryRotationUsed;
        primaryPlainResetDone = next.primaryPlainResetDone;
        slot = next.slot;
        continue;
      }

      return res;
    } catch (e) {
      lastError = e;
      if (
        !hasPrimaryProxyPool() ||
        !isProxyTransportError(e) ||
        attempt >= maxAttempts - 1
      ) {
        throw e;
      }

      if (slot === 0) {
        transportFailuresOnPrimary += 1;
        if (hasProxyFallback() && transportFailuresOnPrimary >= 2) {
          log.warn(
            "Proxy: repeated transport errors on primary, trying fallback",
            {
              error: e instanceof Error ? e.message : String(e),
            },
          );
          slot = 1;
          transportFailuresOnPrimary = 0;
          await resetProxyDispatchers(1);
          const d = postDelayMs();
          if (d > 0) {
            await new Promise<void>(r => setTimeout(r, d));
          }
          continue;
        }
        await recoverAfterProxyTransportFailure(log, e, 0);
      } else {
        await recoverAfterProxyTransportFailure(log, e, 1);
      }
    }
  }

  if (lastError) throw lastError;
  throw new Error("executeFetchWithProxyRotation: exhausted attempts");
}
