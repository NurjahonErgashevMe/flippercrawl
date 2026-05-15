import {
  buildOpenRouterProviderPreferences,
  openRouterReasoningPolicyForModel,
  withOpenRouterProviderRouting,
} from "../openrouter-provider-fetch";

describe("buildOpenRouterProviderPreferences", () => {
  it("includes deepinfra order and bf16 quantization from config defaults", () => {
    const prefs = buildOpenRouterProviderPreferences();
    expect(prefs.order).toEqual(["deepinfra"]);
    expect(prefs.quantizations).toEqual(["bf16"]);
    expect(prefs.allow_fallbacks).toBe(true);
  });
});

describe("openRouterReasoningPolicyForModel", () => {
  it("uses low reasoning for gpt-oss (DeepInfra requires it)", () => {
    expect(openRouterReasoningPolicyForModel("openai/gpt-oss-20b")).toEqual({
      effort: "low",
    });
  });

  it("disables reasoning for Cohere", () => {
    expect(
      openRouterReasoningPolicyForModel("cohere/command-r7b-12-2024"),
    ).toEqual({ effort: "none" });
  });
});

describe("withOpenRouterProviderRouting", () => {
  it("injects provider into chat/completions JSON body", async () => {
    let capturedBody: string | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const wrapped = withOpenRouterProviderRouting(mockFetch);
    await wrapped("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "x/y",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.provider).toEqual(buildOpenRouterProviderPreferences());
    expect(parsed.reasoning).toEqual({ effort: "none" });
  });

  it("strips reasoning_effort so OpenRouter uses reasoning.effort only", async () => {
    let capturedBody: string | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response("{}", { status: 200 });
    };
    const wrapped = withOpenRouterProviderRouting(mockFetch);
    await wrapped("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "x",
        messages: [],
        reasoning_effort: "low",
      }),
    });
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.reasoning_effort).toBeUndefined();
    expect(parsed.reasoning).toEqual({ effort: "none" });
  });

  it("does not inject provider for URLs without chat/completions", async () => {
    let capturedBody: string | undefined;
    const original = JSON.stringify({ a: 1 });
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response("{}", { status: 200 });
    };
    const wrapped = withOpenRouterProviderRouting(mockFetch);
    await wrapped("https://openrouter.ai/api/v1/models", {
      method: "POST",
      body: original,
    });
    expect(capturedBody).toBe(original);
  });
});
