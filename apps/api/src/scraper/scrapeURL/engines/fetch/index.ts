import * as undici from "undici";
import type { Logger } from "winston";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { SSLError } from "../../error";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import {
  buildProxyUrlForPoolIndex,
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
import {
  looksLikeAntiBotPage,
  withDefaultBrowserHeaders,
} from "./browserHeaders";
import { browserProfileForPoolIndex } from "./browserProfiles";
import {
  fetchWithCurlImpersonate,
  shouldUseCurlImpersonateFetch,
} from "./curlImpersonateFetch";

type FetchClient = "undici" | "curl-impersonate";

type PageFetchResult = {
  status: number;
  text: string;
  finalUrl: string;
  headers: [string, string][];
  fetchClient: FetchClient;
};

function decodeHtmlBody(buf: Buffer, meta: Meta): string {
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
  return text;
}

async function fetchPageWithCurlOrUndici(
  meta: Meta,
  flog: Logger,
  poolIdx: number,
  pageUrl: string,
  requestHeaders: Record<string, string>,
): Promise<PageFetchResult> {
  const profile = browserProfileForPoolIndex(poolIdx);
  const headersWithProfile: Record<string, string> = {
    ...profile.headers,
    ...requestHeaders,
  };

  if (shouldUseCurlImpersonateFetch()) {
    try {
      const proxyUrl = buildProxyUrlForPoolIndex(poolIdx);
      const curlRes = await fetchWithCurlImpersonate(
        pageUrl,
        headersWithProfile,
        {
          proxyUrl,
          preset: profile.preset,
          timeoutMs: config.SCRAPE_FETCH_CONNECT_TIMEOUT_MS,
        },
      );
      return {
        status: curlRes.status,
        text: decodeHtmlBody(Buffer.from(curlRes.body, "utf8"), meta),
        finalUrl: curlRes.url,
        headers: curlRes.headers,
        fetchClient: "curl-impersonate",
      };
    } catch (curlErr) {
      flog.warn(
        "[scrape.pipeline] curl-impersonate failed, falling back to undici",
        {
          phase: "fetch_curl_fallback",
          proxyPoolIndex: poolIdx,
          error: curlErr instanceof Error ? curlErr.message : String(curlErr),
        },
      );
    }
  }

  const x = await runWithPrimaryProxyPoolIndex(poolIdx, () =>
    executeFetchWithProxyRotation(flog, () =>
      undici.fetch(pageUrl, {
        dispatcher: getSecureDispatcher(meta.options.skipTlsVerification),
        redirect: "follow",
        headers: headersWithProfile,
        signal: meta.abort.asSignal(),
      }),
    ),
  );

  const buf = Buffer.from(await x.arrayBuffer());
  return {
    status: x.status,
    text: decodeHtmlBody(buf, meta),
    finalUrl: x.url,
    headers: [...x.headers],
    fetchClient: "undici",
  };
}

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
    const requestHeaders = withDefaultBrowserHeaders(meta.options.headers);
    const endpoints = getPrimaryProxyEndpoints();
    const poolN = Math.max(1, endpoints.length);
    const maxRounds =
      poolN <= 1 ? 1 : Math.min(poolN, config.PROXY_POOL_MAX_ENDPOINT_TRIES);
    const start = primaryProxyPoolIndexForJobId(meta.id);
    const pageUrl = meta.rewrittenUrl ?? meta.url;

    let targetHost = "";
    try {
      targetHost = new URL(pageUrl).hostname;
    } catch {
      targetHost = "(bad-url)";
    }

    let lastError: unknown;
    for (let r = 0; r < maxRounds; r++) {
      const poolIdx = (start + r) % poolN;
      const proxyHint = redactProxyEndpointForLog(endpoints[poolIdx] ?? "");

      try {
        flog.info(
          `[scrape.pipeline] Отправка HTTP GET → ${targetHost} (узел пула ${poolIdx + 1}/${poolN}, ${proxyHint})`,
          {
            phase: "fetch_request",
            targetHost,
            proxyPoolIndex: poolIdx,
            proxyPoolSize: poolN,
            proxyEndpoint: proxyHint,
            curlImpersonateEnabled: shouldUseCurlImpersonateFetch(),
          },
        );

        const {
          status,
          text,
          finalUrl,
          headers: responseHeaders,
          fetchClient,
        } = await fetchPageWithCurlOrUndici(
          meta,
          flog,
          poolIdx,
          pageUrl,
          requestHeaders,
        );

        const finalUrlHost = (() => {
          try {
            return new URL(finalUrl).hostname;
          } catch {
            return "";
          }
        })();

        flog.info(
          `[scrape.pipeline] Ответ страницы получен: HTTP ${status}, HTML/тело ${text.length} симв., финальный хост ${finalUrlHost || "—"}`,
          {
            phase: "fetch_ok",
            fetchClient,
            targetHost,
            proxyPoolIndex: poolIdx,
            proxyPoolSize: poolN,
            proxyEndpoint: proxyHint,
            httpStatus: status,
            responseBodyChars: text.length,
            finalUrlHost,
          },
        );

        if (looksLikeAntiBotPage(text, finalUrl)) {
          const tryNextEndpoint = poolN > 1 && r < maxRounds - 1;
          flog.warn(
            `[scrape.pipeline] Обнаружена anti-bot/captcha страница (HTTP ${status})${tryNextEndpoint ? " — пробуем следующий узел пула" : ""}`,
            {
              phase: "fetch_antibot_detected",
              fetchClient,
              targetHost,
              proxyPoolIndex: poolIdx,
              proxyPoolSize: poolN,
              proxyEndpoint: proxyHint,
              httpStatus: status,
              finalUrlHost,
              tryNextEndpoint,
            },
          );
          if (tryNextEndpoint) {
            continue;
          }
          throw new Error(
            "fetch: anti-bot/captcha page received from upstream while using proxy pool",
          );
        }

        response = {
          url: finalUrl,
          body: text,
          status,
          headers: responseHeaders,
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
            `[scrape.pipeline] Ошибка туннеля/транспорта прокси${tun != null ? ` (HTTP ${tun})` : ""} — пробуем следующий узел пула (${(poolIdx + 1) % poolN})`,
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
  const curlMultiplier = shouldUseCurlImpersonateFetch() ? 1.35 : 1;
  const estimated =
    maxRounds * attempts * perAttemptMs * curlMultiplier + 25_000;
  return Math.min(600_000, Math.max(90_000, estimated));
}
