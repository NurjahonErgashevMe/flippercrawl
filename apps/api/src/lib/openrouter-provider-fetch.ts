/**
 * OpenRouter: поле `provider` в теле POST /v1/chat/completions (маршрутизация, квантизация).
 * @ai-sdk/openai его не передаёт — добавляем через обёртку fetch.
 * @see docs/PROVIDER_ROUTING.md
 */
import { config } from "../config";

function parseCsvList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

export function buildOpenRouterProviderPreferences(): {
  order?: string[];
  quantizations?: string[];
  allow_fallbacks: boolean;
} {
  const order = parseCsvList(config.OPENROUTER_PROVIDER_ORDER);
  const quantizations = parseCsvList(config.OPENROUTER_PROVIDER_QUANTIZATIONS);
  return {
    ...(order ? { order } : {}),
    ...(quantizations ? { quantizations } : {}),
    allow_fallbacks: config.OPENROUTER_PROVIDER_ALLOW_FALLBACKS !== false,
  };
}

/**
 * gpt-oss на DeepInfra: reasoning обязателен (`effort: "none"` → 400).
 * Cohere/Gemini: ответ в `content`, reasoning отключаем.
 */
export function openRouterReasoningPolicyForModel(model: string | undefined): {
  effort: string;
} {
  const id = (model ?? "").toLowerCase();
  if (id.includes("gpt-oss")) {
    return { effort: "low" };
  }
  return { effort: "none" };
}

function applyOpenRouterRequestPolicy(body: Record<string, unknown>): void {
  body.provider = buildOpenRouterProviderPreferences();
  const model = typeof body.model === "string" ? body.model : undefined;
  body.reasoning = openRouterReasoningPolicyForModel(model);
  delete body.reasoning_effort;
}

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
      applyOpenRouterRequestPolicy(body);
      return innerFetch(input, {
        ...init,
        body: JSON.stringify(body),
      });
    } catch {
      return innerFetch(input, init);
    }
  };
}
