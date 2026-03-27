import { Identity, idmux, scrapeRaw, scrapeTimeout } from "./lib";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";

describeIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
  "V2 json format with systemPrompt",
  () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "v2-json-system-prompt",
        concurrency: 100,
        credits: 1000000,
      });
    });

    it(
      "accepts systemPrompt in json format and returns structured json",
      async () => {
        const response = await scrapeRaw(
          {
            url: TEST_SUITE_WEBSITE,
            formats: [
              "markdown",
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    page_title: { type: "string", description: "Title" },
                  },
                  required: ["page_title"],
                },
                systemPrompt:
                  "You extract a short page title. Reply with JSON only.",
              },
            ],
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        const json = response.body.data?.json;
        expect(json).toBeDefined();
        expect(json).toEqual(
          expect.objectContaining({
            page_title: expect.any(String),
          }),
        );
      },
      scrapeTimeout + 60000,
    );

    it(
      "should still accept json format with prompt (no systemPrompt)",
      async () => {
        const response = await scrapeRaw(
          {
            url: TEST_SUITE_WEBSITE,
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                },
                prompt: "Extract the title",
              },
            ],
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
      },
      scrapeTimeout + 30000,
    );
  },
);
