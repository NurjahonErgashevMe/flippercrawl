import {
  looksLikeAntiBotPage,
  withDefaultBrowserHeaders,
} from "../browserHeaders";

describe("looksLikeAntiBotPage", () => {
  it("detects Yandex SmartCaptcha", () => {
    const body =
      "<html><title>captcha</title>Подтвердите, что запросы отправляли вы, а не робот</html>";
    expect(looksLikeAntiBotPage(body, "https://www.cian.ru/")).toBe(true);
  });

  it("does not flag large pages with incidental captcha word in JSON-LD", () => {
    const body =
      '{"@type":"WebPage","description":"learn about captcha technology"}'.repeat(
        5000,
      );
    expect(looksLikeAntiBotPage(body, "https://www.cian.ru/")).toBe(false);
  });
});

describe("withDefaultBrowserHeaders", () => {
  it("fills missing defaults without overwriting user headers", () => {
    const out = withDefaultBrowserHeaders({ Cookie: "session=1" });
    expect(out.Cookie).toBe("session=1");
    expect(out["User-Agent"]).toContain("Chrome");
    expect(out["Accept-Language"]).toContain("ru-RU");
  });
});
