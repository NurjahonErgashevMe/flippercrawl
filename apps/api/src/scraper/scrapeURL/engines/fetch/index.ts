import * as undici from "undici";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { SSLError } from "../../error";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import {
  getPrimaryProxyEndpoints,
  getSecureDispatcher,
  hasPrimaryProxyPool,
  InsecureConnectionError,
  primaryProxyPoolIndexForJobId,
  redactProxyEndpointForLog,
  runWithPrimaryProxyPoolIndex,
} from "../utils/safeFetch";
import { MockState, saveMock } from "../../lib/mock";
import { TextDecoder } from "util";
import {
  executeFetchWithProxyRotation,
  parseProxyTunnelHttpStatus,
  shouldRetryFetchWithAlternatePoolEndpoint,
} from "../../../../lib/proxyRotation";

export async function scrapeURLWithFetch(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const mockOptions = {
    url: meta.rewrittenUrl ?? meta.url,

    // irrelevant
    method: "GET",
    ignoreResponse: false,
    ignoreFailure: false,
    tryCount: 1,
  };

  let response:
    | {
        url: string;
        body: string;
        status: number;
        headers: [string, string][];
      }
    | undefined;

  if (meta.mock !== null) {
    const makeRequestTypeId = (
      request: MockState["requests"][number]["options"],
    ) => request.url + ";" + request.method;

    const thisId = makeRequestTypeId(mockOptions);
    const matchingMocks = meta.mock.requests
      .filter(x => makeRequestTypeId(x.options) === thisId)
      .sort((a, b) => a.time - b.time);
    const nextI = meta.mock.tracker[thisId] ?? 0;
    meta.mock.tracker[thisId] = nextI + 1;

    if (!matchingMocks[nextI]) {
      throw new Error("Failed to mock request -- no mock targets found.");
    }

    response = {
      ...matchingMocks[nextI].result,
    };
  } else {
    const flog = meta.logger.child({ method: "scrapeURLWithFetch" });
    const endpoints = getPrimaryProxyEndpoints();
    const poolN = Math.max(1, endpoints.length);
    const maxRounds =
      poolN <= 1 ? 1 : Math.min(poolN, config.PROXY_POOL_MAX_ENDPOINT_TRIES);
    const start = primaryProxyPoolIndexForJobId(meta.id);

    let targetHost = "";
    try {
      targetHost = new URL(meta.rewrittenUrl ?? meta.url).hostname;
    } catch {
      targetHost = "(bad-url)";
    }

    let lastError: unknown;
    for (let r = 0; r < maxRounds; r++) {
      const poolIdx = (start + r) % poolN;
      const proxyHint = redactProxyEndpointForLog(endpoints[poolIdx] ?? "");
      try {
        flog.info(
          `[scrape.pipeline] Отправка HTTP GET через прокси → ${targetHost} (узел пула ${poolIdx + 1}/${poolN}, ${proxyHint})`,
          {
            phase: "fetch_request",
            targetHost,
            proxyPoolIndex: poolIdx,
            proxyPoolSize: poolN,
            proxyEndpoint: proxyHint,
          },
        );

        const x = await runWithPrimaryProxyPoolIndex(poolIdx, () =>
          executeFetchWithProxyRotation(flog, () =>
            undici.fetch(meta.rewrittenUrl ?? meta.url, {
              dispatcher: getSecureDispatcher(meta.options.skipTlsVerification),
              redirect: "follow",
              headers: meta.options.headers,
              signal: meta.abort.asSignal(),
            }),
          ),
        );

        const buf = Buffer.from(await x.arrayBuffer());
        let text = buf.toString("utf8");
        const charset = (text.match(
          /<meta\b[^>]*charset\s*=\s*["']?([^"'\s\/>]+)/i,
        ) ?? [])[1];
        try {
          if (charset) {
            text = new TextDecoder(charset.trim()).decode(buf);
          }
        } catch (error) {
          meta.logger.warn("Failed to re-parse with correct charset", {
            charset,
            error,
          });
        }

        const finalUrlHost = (() => {
          try {
            return new URL(x.url).hostname;
          } catch {
            return "";
          }
        })();

        flog.info(
          `[scrape.pipeline] Ответ страницы получен: HTTP ${x.status}, HTML/тело ${text.length} симв., финальный хост ${finalUrlHost || "—"}`,
          {
            phase: "fetch_ok",
            targetHost,
            proxyPoolIndex: poolIdx,
            proxyPoolSize: poolN,
            proxyEndpoint: proxyHint,
            httpStatus: x.status,
            responseBodyChars: text.length,
            finalUrlHost,
          },
        );

        response = {
          url: x.url,
          body: text,
          status: x.status,
          headers: [...x.headers],
        };

        if (meta.mock === null) {
          await saveMock(mockOptions, response);
        }
        break;
      } catch (error) {
        lastError = error;
        const tryNextEndpoint =
          poolN > 1 &&
          r < maxRounds - 1 &&
          shouldRetryFetchWithAlternatePoolEndpoint(error);
        if (tryNextEndpoint) {
          const tun = parseProxyTunnelHttpStatus(error);
          flog.warn(
            `[scrape.pipeline] Ошибка туннеля прокси${tun != null ? ` (HTTP ${tun})` : ""} — пробуем следующий узел пула (${(poolIdx + 1) % poolN})`,
            {
              phase: "fetch_retry_next_proxy",
              targetHost,
              poolIndex: poolIdx,
              nextPoolIndex: (poolIdx + 1) % poolN,
              proxyTunnelHttpStatus: tun,
            },
          );
          continue;
        }
        if (
          error instanceof TypeError &&
          error.cause instanceof InsecureConnectionError
        ) {
          throw error.cause;
        } else if (
          error instanceof Error &&
          error.message === "fetch failed" &&
          error.cause &&
          (error.cause as any).code === "CERT_HAS_EXPIRED"
        ) {
          throw new SSLError(meta.options.skipTlsVerification);
        } else {
          throw error;
        }
      }
    }

    if (response === undefined) {
      throw lastError ?? new Error("fetch: no response after proxy attempts");
    }
  }

  if (!response) {
    throw new Error("fetch: internal error, response unset");
  }

  await specialtyScrapeCheck(
    meta.logger.child({ method: "scrapeURLWithFetch/specialtyScrapeCheck" }),
    Object.fromEntries(response.headers as any),
  );

  return {
    url: response.url,
    html: response.body,
    statusCode: response.status,
    contentType:
      (response.headers.find(x => x[0].toLowerCase() === "content-type") ??
        [])[1] ?? undefined,

    proxyUsed: "basic",
  };
}

/**
 * Время на движок fetch до waterfall: при прокси и ретраях должно покрывать
 * (узлы пула × PROXY_ROTATION_MAX_ATTEMPTS × connect + паузы), иначе обрыв по 15s при живых ретраях.
 */
export function fetchMaxReasonableTime(_meta: Meta): number {
  if (!hasPrimaryProxyPool()) {
    return 15_000;
  }
  const poolN = Math.max(1, getPrimaryProxyEndpoints().length);
  const maxRounds =
    poolN <= 1 ? 1 : Math.min(poolN, config.PROXY_POOL_MAX_ENDPOINT_TRIES);
  const attempts = config.PROXY_ROTATION_MAX_ATTEMPTS;
  const perAttemptMs =
    config.SCRAPE_FETCH_CONNECT_TIMEOUT_MS +
    config.PROXY_ROTATION_POST_DELAY_MS +
    5_000;
  const estimated = maxRounds * attempts * perAttemptMs + 25_000;
  return Math.min(600_000, Math.max(90_000, estimated));
}
