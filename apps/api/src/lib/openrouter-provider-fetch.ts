/**
 * OpenRouter: поле `provider` в теле POST /v1/chat/completions (маршрутизация, квантизация).
 * @ai-sdk/openai его не передаёт — добавляем через обёртку fetch.
 * @see docs/PROVIDER_ROUTING.md
 */
export const OPENROUTER_DEFAULT_PROVIDER = {
  order: ["deepinfra"] as const,
  quantizations: ["bf16"] as const,
  allow_fallbacks: false,
  /** Только провайдеры, поддерживающие все параметры запроса (в т.ч. structured outputs). */
  require_parameters: true,
} as const;

export function withOpenRouterProviderRouting(
  innerFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (init?.body == null || typeof init.body !== "string") {
      return innerFetch(input, init);
    }
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : "";
    if (!urlStr.includes("/chat/completions")) {
      return innerFetch(input, init);
    }
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      body.provider = { ...OPENROUTER_DEFAULT_PROVIDER };
      /** OpenRouter: отключить reasoning/thinking, ответ в `content`, не в `reasoning`. @see docs reasoning-tokens */
      body.reasoning = { effort: "none" };
      delete body.reasoning_effort;
      return innerFetch(input, {
        ...init,
        body: JSON.stringify(body),
      });
    } catch {
      return innerFetch(input, init);
    }
  };
}
