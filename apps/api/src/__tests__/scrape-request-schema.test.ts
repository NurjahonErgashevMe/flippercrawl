import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "fs";
import path from "path";
import { scrapeRequestSchema } from "../controllers/v2/types";

describe("scrapeRequestSchema (json + systemPrompt)", () => {
  it("parses fixture scrape-request-cian.json including systemPrompt on json format", () => {
    const raw = readFileSync(
      path.join(__dirname, "fixtures/scrape-request-cian.json"),
      "utf8",
    );
    const body = JSON.parse(raw);
    const parsed = scrapeRequestSchema.parse(body);

    const jsonFmt = parsed.formats?.find(
      f =>
        typeof f === "object" && f !== null && "type" in f && f.type === "json",
    ) as { type: "json"; schema?: unknown; systemPrompt?: string } | undefined;

    expect(jsonFmt?.type).toBe("json");
    expect(jsonFmt?.systemPrompt).toContain("экстрактор");
    expect(jsonFmt?.schema).toBeDefined();
  });
});
