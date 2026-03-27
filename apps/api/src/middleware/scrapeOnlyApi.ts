import type { RequestHandler } from "express";
import { config } from "../config";

function normalizePath(url: string): string {
  const p = url.split("?")[0];
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p || "/";
}

/**
 * Разрешённые маршруты при API_SCRAPE_ONLY: только scrape (+ batch scrape + статусы), health.
 */
function isAllowedScrapeOnlyApi(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const p = normalizePath(pathname);

  if (m === "OPTIONS") return true;

  if (m === "GET" && (p === "/" || p === "/e2e-test")) return true;
  if (m === "GET" && p.startsWith("/v0/health/")) return true;

  if (m === "POST" && p === "/v0/scrape") return true;

  if (m === "POST" && (p === "/v1/scrape" || p === "/v2/scrape")) return true;
  if (m === "POST" && (p === "/v1/batch/scrape" || p === "/v2/batch/scrape"))
    return true;

  if (m === "GET" && /^\/v1\/scrape\/[^/]+$/.test(p)) return true;
  if (m === "GET" && /^\/v1\/batch\/scrape\/[^/]+$/.test(p)) return true;
  if (m === "GET" && /^\/v1\/batch\/scrape\/[^/]+\/errors$/.test(p))
    return true;

  if (
    m === "GET" &&
    /^\/v2\/scrape\/[^/]+$/.test(p) &&
    !p.includes("/interact")
  )
    return true;
  if (m === "GET" && /^\/v2\/batch\/scrape\/[^/]+$/.test(p)) return true;
  if (m === "DELETE" && /^\/v2\/batch\/scrape\/[^/]+$/.test(p)) return true;
  if (m === "GET" && /^\/v2\/batch\/scrape\/[^/]+\/errors$/.test(p))
    return true;

  return false;
}

export const scrapeOnlyApiGuard: RequestHandler = (req, res, next) => {
  if (!config.API_SCRAPE_ONLY) {
    return next();
  }
  const path = req.originalUrl ?? req.url;
  if (isAllowedScrapeOnlyApi(req.method, path)) {
    return next();
  }
  res.status(404).json({
    success: false,
    error: "Not found (API_SCRAPE_ONLY: only scrape endpoints are enabled)",
  });
};
