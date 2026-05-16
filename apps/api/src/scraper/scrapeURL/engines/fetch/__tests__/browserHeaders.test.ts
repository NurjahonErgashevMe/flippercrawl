import {
  looksLikeAntiBotPage,
  withDefaultBrowserHeaders,
} from "../browserHeaders";
import {
  browserProfileCount,
  browserProfileForPoolIndex,
} from "../browserProfiles";

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

describe("browserProfileForPoolIndex", () => {
  it("returns a profile with UA and preset for any index", () => {
    const profile = browserProfileForPoolIndex(0);
    expect(profile.headers["User-Agent"]).toBeDefined();
    expect(profile.preset).toMatch(/chrome|firefox/);
  });

  it("rotates across pool indices (different IPs get different UAs)", () => {
    const count = browserProfileCount();
    expect(count).toBeGreaterThan(1);
    const seenUserAgents = new Set(
      Array.from(
        { length: count },
        (_, i) => browserProfileForPoolIndex(i).headers["User-Agent"],
      ),
    );
    expect(seenUserAgents.size).toBe(count);
  });

  it("is deterministic per pool index (same retry → same profile)", () => {
    expect(browserProfileForPoolIndex(42)).toEqual(
      browserProfileForPoolIndex(42),
    );
  });
});
