/**
 * Профили браузера для обхода anti-bot: User-Agent, Accept-Language,
 * sec-ch-ua и совместимый curl-impersonate preset.
 * Cian.ru запоминает связку IP + UA + headers — ротация на каждый
 * узел прокси-пула снижает шанс получить 302 на капчу.
 */

import type { CurlImpersonatePreset } from "./curlImpersonateFetch";

type BrowserProfile = {
  preset: CurlImpersonatePreset;
  headers: Record<string, string>;
};

const PROFILES: BrowserProfile[] = [
  {
    preset: "chrome-116",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "sec-ch-ua":
        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  },
  {
    preset: "chrome-116",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "sec-ch-ua":
        '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    },
  },
  {
    preset: "chrome-110",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "sec-ch-ua":
        '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Accept-Language": "ru,en-US;q=0.9,en;q=0.8",
    },
  },
  {
    preset: "firefox-117",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
      "Accept-Language": "ru-RU,ru;q=0.8,en-US;q=0.5,en;q=0.3",
    },
  },
  {
    preset: "firefox-109",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
    },
  },
  {
    preset: "chrome-116",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "sec-ch-ua":
        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8",
    },
  },
];

/** Pseudorandom-but-deterministic profile per pool index, so retries vary. */
export function browserProfileForPoolIndex(poolIdx: number): BrowserProfile {
  const i = ((poolIdx % PROFILES.length) + PROFILES.length) % PROFILES.length;
  return PROFILES[i];
}

export function browserProfileCount(): number {
  return PROFILES.length;
}
