import { CurlImpersonate } from "node-curl-impersonate";
import { config } from "../../../../config";

export type CurlImpersonatePreset =
  | "chrome-110"
  | "chrome-116"
  | "firefox-109"
  | "firefox-117";

type CurlFetchResult = {
  status: number;
  body: string;
  url: string;
  headers: [string, string][];
};

export function shouldUseCurlImpersonateFetch(): boolean {
  return (
    config.USE_CURL_IMPERSONATE_FETCH === true &&
    (process.platform === "linux" || process.platform === "darwin")
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function fetchWithCurlImpersonate(
  url: string,
  headers: Record<string, string>,
  opts: {
    proxyUrl?: string;
    preset?: CurlImpersonatePreset;
    timeoutMs: number;
  },
): Promise<CurlFetchResult> {
  const preset = (opts.preset ??
    config.CURL_IMPERSONATE_PRESET) as CurlImpersonatePreset;
  const maxTime = Math.max(1, Math.ceil(opts.timeoutMs / 1000));

  const flags: string[] = [
    "-L",
    "--silent",
    "--show-error",
    "--max-time",
    String(maxTime),
  ];
  // Preset sets en-US by default; override only if caller didn't pass one.
  const callerLanguage = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === "accept-language",
  );
  if (!callerLanguage) {
    flags.push(
      `-H ${shellQuote("Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7")}`,
    );
  }
  if (opts.proxyUrl) {
    flags.push("-x", shellQuote(opts.proxyUrl));
  }

  const requestHeaders: Record<string, string> = {
    ...headers,
    Accept:
      headers.Accept ??
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  };

  const client = new CurlImpersonate(url, {
    method: "GET",
    impersonate: preset,
    headers: requestHeaders,
    flags,
  });

  const res = await client.makeRequest();
  if (res.statusCode === undefined) {
    throw new Error(
      "curl-impersonate: could not parse HTTP status from verbose output",
    );
  }

  const headerEntries: [string, string][] = Object.entries(
    res.responseHeaders ?? {},
  ).map(([k, v]) => [k, String(v)]);

  return {
    status: res.statusCode,
    body: res.response ?? "",
    url,
    headers: headerEntries,
  };
}
