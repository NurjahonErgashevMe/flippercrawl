import {
  normalizeCianDateString,
  normalizeCianListingExtract,
  normalizePriceHistory,
} from "./cianExtractNormalize";

describe("normalizeCianDateString", () => {
  it("parses Russian short month", () => {
    expect(normalizeCianDateString("21 фев 2026")).toBe("2026-02-21");
    expect(normalizeCianDateString("11 мая 2026")).toBe("2026-05-11");
    expect(normalizeCianDateString("27 мар 2026")).toBe("2026-03-27");
    expect(normalizeCianDateString("1 мар 2026")).toBe("2026-03-01");
  });

  it("keeps ISO dates", () => {
    expect(normalizeCianDateString("2026-02-21")).toBe("2026-02-21");
  });

  it("parses dotted dates", () => {
    expect(normalizeCianDateString("18.03.2026")).toBe("2026-03-18");
  });
});

describe("normalizePriceHistory", () => {
  it("sorts chronologically and recalculates change fields", () => {
    const out = normalizePriceHistory([
      { date: "11 мая 2026", price: 36400000 },
      { date: "21 фев 2026", price: 39500000 },
      { date: "22 фев 2026", price: 39990000 },
    ]);

    expect(out[0].date).toBe("2026-02-21");
    expect(out[0].change_type).toBe("initial");
    expect(out[0].change_amount).toBe(0);
    expect(out[1].date).toBe("2026-02-22");
    expect(out[1].change_type).toBe("increase");
    expect(out[1].change_amount).toBe(490000);
    expect(out[2].date).toBe("2026-05-11");
    expect(out[2].change_type).toBe("decrease");
    expect(out[2].change_amount).toBe(3590000);
  });
});

describe("normalizeCianListingExtract", () => {
  it("normalizes price_history on listing object", () => {
    const out = normalizeCianListingExtract({
      cian_id: "1",
      price_history: [{ date: "21 фев 2026", price: 100 }],
    });
    expect(out.price_history[0].date).toBe("2026-02-21");
  });
});
