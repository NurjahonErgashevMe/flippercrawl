/** Одна строка истории цены (как в JSON-extract Cian). */
type PriceHistoryEntry = {
  date?: string;
  price?: number;
  change_amount?: number;
  change_type?: "initial" | "increase" | "decrease";
};

const RU_MONTH_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ["янв", 1],
  ["фев", 2],
  ["мар", 3],
  ["апр", 4],
  ["май", 5],
  ["мая", 5],
  ["июн", 6],
  ["июл", 7],
  ["авг", 8],
  ["сен", 9],
  ["окт", 10],
  ["ноя", 11],
  ["дек", 12],
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function monthFromRussianToken(token: string): number | undefined {
  const k = token.toLowerCase().replace(/\./g, "").trim();
  for (const [prefix, month] of RU_MONTH_PREFIXES) {
    if (k === prefix || k.startsWith(prefix)) return month;
  }
  return undefined;
}

/** «21 фев 2026», «11 мая 2026», «18.03.2026» → `2026-02-21`. Уже ISO — без изменений. */
export function normalizeCianDateString(date: string): string | null {
  const t = date.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const dotted = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    const day = parseInt(dotted[1], 10);
    const month = parseInt(dotted[2], 10);
    const year = parseInt(dotted[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }

  const ru = t.match(/^(\d{1,2})\s+([а-яёa-z]+)\s+(\d{4})$/i);
  if (ru) {
    const day = parseInt(ru[1], 10);
    const year = parseInt(ru[3], 10);
    const month = monthFromRussianToken(ru[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }

  return null;
}

function parseIsoDateKey(iso: string): number {
  const [y, m, d] = iso.split("-").map(x => parseInt(x, 10));
  return y * 10000 + m * 100 + d;
}

/** Сортировка по дате (старые → новые) и пересчёт change_amount / change_type. */
export function normalizePriceHistory(
  items: PriceHistoryEntry[],
): PriceHistoryEntry[] {
  const normalized: PriceHistoryEntry[] = [];

  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const price =
      typeof row.price === "number"
        ? row.price
        : typeof row.price === "string"
          ? parseInt(row.price, 10)
          : undefined;
    if (price === undefined || Number.isNaN(price)) continue;

    let date = typeof row.date === "string" ? row.date.trim() : "";
    if (date) {
      const iso = normalizeCianDateString(date);
      if (iso) date = iso;
    }

    normalized.push({
      ...row,
      date: date || row.date,
      price,
    });
  }

  normalized.sort((a, b) => {
    const da = a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : "";
    const db = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "";
    if (da && db) return parseIsoDateKey(da) - parseIsoDateKey(db);
    return 0;
  });

  for (let i = 0; i < normalized.length; i++) {
    const cur = normalized[i];
    const prev = i > 0 ? normalized[i - 1] : undefined;
    if (!prev || prev.price === undefined || cur.price === undefined) {
      cur.change_type = "initial";
      cur.change_amount = 0;
      continue;
    }
    const delta = cur.price - prev.price;
    cur.change_amount = Math.abs(delta);
    if (delta > 0) cur.change_type = "increase";
    else if (delta < 0) cur.change_type = "decrease";
    else cur.change_type = "initial";
  }

  return normalized;
}

/** Постобработка JSON-extract для карточек Cian (даты истории цены и дельты). */
export function normalizeCianListingExtract<T extends Record<string, unknown>>(
  data: T,
): T {
  if (!data || typeof data !== "object") return data;
  const history = data.price_history;
  if (!Array.isArray(history) || history.length === 0) return data;

  return {
    ...data,
    price_history: normalizePriceHistory(history as PriceHistoryEntry[]),
  };
}
