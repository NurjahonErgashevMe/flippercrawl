import { fetch, Agent } from "undici";
import type { Logger } from "winston";
import { config } from "../config";
import { resetProxyDispatchers } from "../scraper/scrapeURL/engines/utils/safeFetch";

const directAgent = new Agent({
  connect: { rejectUnauthorized: true },
});

let rotationQueue: Promise<void> = Promise.resolve();
let lastRotationTime = 0;

function proxyRotationEnabled(): boolean {
  const url = config.PROXY_ROTATION_URL?.trim();
  return !!(config.PROXY_SERVER && url);
}

function parseRotationStatuses(): number[] {
  return config.PROXY_ROTATION_STATUSES.split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n));
}

/** Повторять запрос при этих HTTP-кодах (после сброса / смены IP). */
function shouldRetryHttpForProxy(status: number): boolean {
  if (!config.PROXY_SERVER) return false;
  return parseRotationStatuses().includes(status);
}

function postDelayMs(): number {
  return config.PROXY_ROTATION_POST_DELAY_MS;
}

/**
 * Запрос смены IP у провайдера (без прокси), сброс исходящих undici-диспетчеров,
 * пауза перед следующим запросом. Вызовы сериализуются (cooldown).
 */
async function rotateProxyAndResetDispatchers(
  log: Logger,
  ctx: { reason: string; statusCode?: number },
): Promise<void> {
  const rotationUrl = config.PROXY_ROTATION_URL?.trim();
  if (!rotationUrl || !config.PROXY_SERVER) return;

  const cooldown = config.PROXY_ROTATION_COOLDOWN_MS;
  const postDelay = postDelayMs();

  rotationQueue = rotationQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, cooldown - (now - lastRotationTime));
    if (wait > 0) {
      await new Promise<void>(r => setTimeout(r, wait));
    }

    log.info("Mobile proxy: requesting IP rotation", {
      reason: ctx.reason,
      statusCode: ctx.statusCode,
    });

    try {
      const res = await fetch(rotationUrl, {
        dispatcher: directAgent,
        redirect: "follow",
      });
      if (!res.ok) {
        log.warn("Mobile proxy: rotation endpoint returned non-OK", {
          status: res.status,
        });
      }
    } catch (e) {
      log.warn("Mobile proxy: rotation endpoint request failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    await resetProxyDispatchers();
    lastRotationTime = Date.now();

    if (postDelay > 0) {
      await new Promise<void>(r => setTimeout(r, postDelay));
    }
  });

  await rotationQueue;
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
): Promise<void> {
  if (!config.PROXY_SERVER) return;

  log.warn("Proxy: transport error, resetting connections", {
    error: err instanceof Error ? err.message : String(err),
  });

  if (
    proxyRotationEnabled() &&
    config.PROXY_ROTATION_ON_TRANSPORT_ERROR !== false
  ) {
    await rotateProxyAndResetDispatchers(log, { reason: "transport_error" });
  } else {
    await resetProxyDispatchers();
    const d = postDelayMs();
    if (d > 0) {
      await new Promise<void>(r => setTimeout(r, d));
    }
  }
}

/**
 * Выполняет fetch с повтором после 403/429 (сброс или смена IP) и после обрыва соединения с прокси.
 */
export async function executeFetchWithProxyRotation(
  log: Logger,
  exec: () => Promise<import("undici").Response>,
): Promise<import("undici").Response> {
  const maxAttempts = config.PROXY_SERVER
    ? config.PROXY_ROTATION_MAX_ATTEMPTS
    : 1;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await exec();

      if (shouldRetryHttpForProxy(res.status) && attempt < maxAttempts - 1) {
        await res.arrayBuffer().catch(() => {});
        if (proxyRotationEnabled()) {
          await rotateProxyAndResetDispatchers(log, {
            reason: "http_status",
            statusCode: res.status,
          });
        } else {
          log.warn("HTTP status suggests retry; resetting proxy dispatcher", {
            status: res.status,
          });
          await resetProxyDispatchers();
          const d = postDelayMs();
          if (d > 0) {
            await new Promise<void>(r => setTimeout(r, d));
          }
        }
        continue;
      }

      return res;
    } catch (e) {
      lastError = e;
      if (
        !config.PROXY_SERVER ||
        !isProxyTransportError(e) ||
        attempt >= maxAttempts - 1
      ) {
        throw e;
      }
      await recoverAfterProxyTransportFailure(log, e);
    }
  }

  if (lastError) throw lastError;
  throw new Error("executeFetchWithProxyRotation: exhausted attempts");
}
