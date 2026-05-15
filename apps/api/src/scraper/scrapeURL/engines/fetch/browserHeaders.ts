/** Strong anti-bot / captcha signals (avoid bare "captcha" in large JSON-LD pages). */
export function looksLikeAntiBotPage(body: string, finalUrl: string): boolean {
  const sample = body.slice(0, 80_000);
  const haystack = `${finalUrl}\n${sample}`.toLowerCase();

  if (haystack.includes("подтвердите, что запросы отправляли вы")) {
    return true;
  }
  if (
    haystack.includes("yandex smartcaptcha") ||
    haystack.includes("support/smart-captcha")
  ) {
    return true;
  }
  if (
    haystack.includes("are you a robot") ||
    haystack.includes("verify you are human")
  ) {
    return true;
  }
  if (
    /smartcaptcha|smart-captcha|captcha-form|challenge-form|cf-challenge|hcaptcha|g-recaptcha/.test(
      haystack,
    )
  ) {
    return true;
  }
  return false;
}

export function withDefaultBrowserHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const defaults: Array<[string, string]> = [
    [
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ],
    [
      "Accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    ],
    ["Accept-Language", "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"],
    ["Cache-Control", "no-cache"],
    ["Pragma", "no-cache"],
  ];

  const merged: Record<string, string> = { ...(headers ?? {}) };
  const existingLower = new Set(
    Object.keys(merged).map(key => key.trim().toLowerCase()),
  );
  for (const [key, value] of defaults) {
    if (!existingLower.has(key.toLowerCase())) {
      merged[key] = value;
    }
  }
  return merged;
}
