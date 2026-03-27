import {
  OPENROUTER_DEFAULT_PROVIDER,
  withOpenRouterProviderRouting,
} from "../openrouter-provider-fetch";

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
    expect(parsed.provider).toEqual({ ...OPENROUTER_DEFAULT_PROVIDER });
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
