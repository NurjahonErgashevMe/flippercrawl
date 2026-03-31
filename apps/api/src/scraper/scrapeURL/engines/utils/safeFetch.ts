import type { Socket } from "net";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { AsyncLocalStorage } from "async_hooks";
import { config } from "../../../../config";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { interceptors } from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import IPAddr from "ipaddr.js";

export class InsecureConnectionError extends Error {
  constructor() {
    super("Connection violated security rules.");
  }
}

export function isIPPrivate(address: string): boolean {
  if (!IPAddr.isValid(address)) return false;

  const addr = IPAddr.parse(address);
  return addr.range() !== "unicast";
}

export type ProxySlot = 0 | 1;

const proxySlotAls = new AsyncLocalStorage<ProxySlot>();

const primaryProxyPoolIndexAls = new AsyncLocalStorage<number>();

export function runWithProxySlot<T>(slot: ProxySlot, fn: () => T): T {
  return proxySlotAls.run(slot, fn);
}

export function runWithPrimaryProxyPoolIndex<T>(index: number, fn: () => T): T {
  const n = getPrimaryProxyEndpoints().length;
  const idx = n > 0 ? ((index % n) + n) % n : 0;
  return primaryProxyPoolIndexAls.run(idx, fn);
}

// ─── Proxy pool entry ────────────────────────────────────────────────
interface ProxyEntry {
  hostPort: string;
  username?: string;
  password?: string;
}

/**
 * Формат файла (по строке):
 *   host:port:user:password   — пароль может содержать `:` и спецсимволы
 *   host:port                 — креды берутся из PROXY_USERNAME / PROXY_PASSWORD
 *   # комментарий
 */
function parseEntriesFromFile(filePath: string): ProxyEntry[] {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, "utf8");
  const out: ProxyEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx1 = t.indexOf(":");
    if (idx1 === -1) continue;
    const idx2 = t.indexOf(":", idx1 + 1);
    if (idx2 === -1) {
      out.push({ hostPort: t });
      continue;
    }
    const hostPort = t.slice(0, idx2);
    const rest = t.slice(idx2 + 1);
    const idx3 = rest.indexOf(":");
    if (idx3 === -1) {
      out.push({ hostPort, username: rest || undefined });
    } else {
      const user = rest.slice(0, idx3);
      const pass = rest.slice(idx3 + 1);
      out.push({
        hostPort,
        username: user || undefined,
        password: pass || undefined,
      });
    }
  }
  return out;
}

let cachedPool: ProxyEntry[] | null = null;

function loadPrimaryPool(): ProxyEntry[] {
  if (cachedPool !== null) return cachedPool;

  const file = config.PROXY_SERVER_LIST_FILE?.trim();
  if (file) {
    const entries = parseEntriesFromFile(file);
    if (entries.length > 0) {
      cachedPool = entries;
      const sample = entries[0];
      console.log(
        `[safeFetch] Loaded ${entries.length} proxy entries from ${file}. ` +
          `Sample: hostPort=${sample.hostPort}, user=${sample.username ?? "(env)"}, ` +
          `pass=${sample.password ? sample.password.slice(0, 3) + "***" : "(env)"}`,
      );
      return cachedPool;
    }
    console.warn(
      `[safeFetch] PROXY_SERVER_LIST_FILE="${file}" — file empty or not found`,
    );
  }

  const list = config.PROXY_SERVER_LIST?.trim();
  if (list) {
    cachedPool = list
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(hp => ({ hostPort: hp }));
    return cachedPool;
  }

  const single = config.PROXY_SERVER?.trim();
  cachedPool = single ? [{ hostPort: single }] : [];
  return cachedPool;
}

export function getPrimaryProxyEndpoints(): string[] {
  return loadPrimaryPool().map(e => e.hostPort);
}

/** Для логов: только hostname, без порта/кредов. */
export function redactProxyEndpointForLog(hostPort: string): string {
  const t = hostPort.trim();
  if (!t) return "(none)";
  try {
    const base = t.includes("://") ? t : "http://" + t;
    const u = new URL(base);
    return `${u.hostname}:***`;
  } catch {
    return "(unparsed-proxy)";
  }
}

export function primaryProxyPoolIndexForJobId(jobId: string): number {
  const pool = loadPrimaryPool();
  if (pool.length <= 1) return 0;
  let h = 0;
  for (let i = 0; i < jobId.length; i++) {
    h = (h * 31 + jobId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % pool.length;
}

export function hasPrimaryProxyPool(): boolean {
  return loadPrimaryPool().length > 0;
}

export function hasProxyFallback(): boolean {
  return hasPrimaryProxyPool() && !!config.PROXY_SERVER_FALLBACK?.trim();
}

function resolveActiveSlot(): ProxySlot {
  const s = proxySlotAls.getStore();
  if (s === 1 && hasProxyFallback()) return 1;
  return 0;
}

function resolvePrimaryPoolIndex(): number {
  const pool = loadPrimaryPool();
  if (pool.length === 0) return 0;
  const stored = primaryProxyPoolIndexAls.getStore();
  if (stored !== undefined) {
    return ((stored % pool.length) + pool.length) % pool.length;
  }
  return 0;
}

function authForPoolEntry(entry: ProxyEntry): {
  username?: string;
  password?: string;
} {
  return {
    username: entry.username ?? config.PROXY_USERNAME,
    password: entry.password ?? config.PROXY_PASSWORD,
  };
}

function fallbackProxyUriRaw(): string | undefined {
  return config.PROXY_SERVER_FALLBACK?.trim();
}

function fallbackProxyAuth(): { username?: string; password?: string } {
  return {
    username: config.PROXY_USERNAME_FALLBACK,
    password: config.PROXY_PASSWORD_FALLBACK,
  };
}

let agentCreationLogged = 0;

/**
 * URI без userinfo + Basic для CONNECT. В undici заголовок из URL ставится только
 * если truthy и username, и password; иначе 407. Явный `token` совпадает с curl -U.
 */
function proxyUriAndToken(
  hostPort: string,
  auth: { username?: string; password?: string },
): { uri: string; token?: string } {
  const base = hostPort.includes("://") ? hostPort : "http://" + hostPort;
  const u = new URL(base);
  const fromUrlUser = u.username ? decodeURIComponent(u.username) : "";
  const fromUrlPass = u.password ? decodeURIComponent(u.password) : "";
  u.username = "";
  u.password = "";
  const uri = u.toString().replace(/\/$/, "");

  const username = auth.username ?? (fromUrlUser || undefined);
  const password =
    auth.password !== undefined
      ? auth.password
      : fromUrlPass !== ""
        ? fromUrlPass
        : undefined;

  if (username !== undefined && username !== "") {
    return {
      uri,
      token: `Basic ${Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64")}`,
    };
  }
  return { uri };
}

function createBaseAgentForHostPort(
  hostPort: string | undefined,
  skipTlsVerification: boolean,
  auth: { username?: string; password?: string },
): undici.Dispatcher {
  const connectMs = config.SCRAPE_FETCH_CONNECT_TIMEOUT_MS;

  if (!hostPort) {
    return new undici.Agent({
      connect: {
        rejectUnauthorized: !skipTlsVerification,
        timeout: connectMs,
      },
    }).compose(interceptors.redirect({ maxRedirections: 5000 }));
  }

  const { uri, token } = proxyUriAndToken(hostPort, auth);

  if (agentCreationLogged < 3) {
    agentCreationLogged++;
    const safe = token
      ? `${auth.username ?? "?"}:${(auth.password ?? "").slice(0, 4)}***`
      : "(no auth)";
    console.log(
      `[safeFetch] Creating ProxyAgent: uri=${uri}, auth=${safe}, connectTimeoutMs=${connectMs}`,
    );
  }

  const baseAgent = new undici.ProxyAgent({
    uri,
    ...(token ? { token } : {}),
    connectTimeout: connectMs,
    proxyTls: { timeout: connectMs },
    requestTls: {
      rejectUnauthorized: !skipTlsVerification,
      timeout: connectMs,
    },
  });

  return baseAgent.compose(interceptors.redirect({ maxRedirections: 5000 }));
}

function attachSecurityCheck(agent: undici.Dispatcher) {
  agent.on("connect", (_, targets) => {
    const client: undici.Client = targets.slice(-1)[0] as undici.Client;
    const socketSymbol = Object.getOwnPropertySymbols(client).find(
      x => x.description === "socket",
    )!;
    const socket: Socket | TLSSocket = (client as any)[socketSymbol];

    if (
      socket.remoteAddress &&
      isIPPrivate(socket.remoteAddress) &&
      config.ALLOW_LOCAL_WEBHOOKS !== true
    ) {
      socket.destroy(new InsecureConnectionError());
    }
  });
}

type DispatcherQuad = {
  secure: undici.Dispatcher;
  secureSkipTls: undici.Dispatcher;
  noCookies: undici.Dispatcher;
  noCookiesSkipTls: undici.Dispatcher;
};

function makeQuadForPoolEntry(entry: ProxyEntry): DispatcherQuad {
  const auth = authForPoolEntry(entry);

  const baseSecure = createBaseAgentForHostPort(entry.hostPort, false, auth);
  const jar = new CookieJar();
  const secure = baseSecure.compose(cookie({ jar }));
  attachSecurityCheck(secure);

  const baseSecureSkip = createBaseAgentForHostPort(entry.hostPort, true, auth);
  const jarSkip = new CookieJar();
  const secureSkipTls = baseSecureSkip.compose(cookie({ jar: jarSkip }));
  attachSecurityCheck(secureSkipTls);

  const noCookies = createBaseAgentForHostPort(entry.hostPort, false, auth);
  attachSecurityCheck(noCookies);

  const noCookiesSkipTls = createBaseAgentForHostPort(
    entry.hostPort,
    true,
    auth,
  );
  attachSecurityCheck(noCookiesSkipTls);

  return { secure, secureSkipTls, noCookies, noCookiesSkipTls };
}

function makeQuadForSlot(slot: ProxySlot): DispatcherQuad {
  if (slot === 0) {
    const pool = loadPrimaryPool();
    const entry = pool[resolvePrimaryPoolIndex()] ?? pool[0];
    if (entry) return makeQuadForPoolEntry(entry);
  }

  const raw = fallbackProxyUriRaw();
  return makeQuadForPoolEntry({
    hostPort: raw ?? "",
    ...fallbackProxyAuth(),
  });
}

function rebuildAllDispatchers() {
  const pool = loadPrimaryPool();
  if (pool.length === 0) {
    primaryPoolQuads = [makeQuadForPoolEntry({ hostPort: "" })];
  } else {
    primaryPoolQuads = pool.map(entry => makeQuadForPoolEntry(entry));
  }
  fallbackQuad = hasProxyFallback() ? makeQuadForSlot(1) : null;
}

let primaryPoolQuads: DispatcherQuad[];
let fallbackQuad: DispatcherQuad | null = null;

rebuildAllDispatchers();

async function closeDispatcher(d: undici.Dispatcher) {
  try {
    await d.close();
  } catch {
    // ignore
  }
}

async function closeQuad(q: DispatcherQuad) {
  await Promise.all([
    closeDispatcher(q.secure),
    closeDispatcher(q.secureSkipTls),
    closeDispatcher(q.noCookies),
    closeDispatcher(q.noCookiesSkipTls),
  ]);
}

function quadForResolvedSlot(slot: ProxySlot): DispatcherQuad {
  if (slot === 1 && fallbackQuad) return fallbackQuad;
  const pool = loadPrimaryPool();
  const idx = pool.length > 0 ? resolvePrimaryPoolIndex() : 0;
  return primaryPoolQuads[idx] ?? primaryPoolQuads[0];
}

export async function resetProxyDispatchers(
  slot: ProxySlot | "all" = "all",
): Promise<void> {
  if (!hasPrimaryProxyPool()) return;

  if (!hasProxyFallback()) {
    if (slot === "all" || slot === 0) {
      await Promise.all(primaryPoolQuads.map(q => closeQuad(q)));
    }
    rebuildAllDispatchers();
    return;
  }

  if (slot === "all") {
    await Promise.all(primaryPoolQuads.map(q => closeQuad(q)));
    if (fallbackQuad) await closeQuad(fallbackQuad);
    rebuildAllDispatchers();
    return;
  }

  if (slot === 0) {
    await Promise.all(primaryPoolQuads.map(q => closeQuad(q)));
    const pool = loadPrimaryPool();
    primaryPoolQuads =
      pool.length === 0
        ? [makeQuadForPoolEntry({ hostPort: "" })]
        : pool.map(entry => makeQuadForPoolEntry(entry));
  } else {
    if (fallbackQuad) await closeQuad(fallbackQuad);
    fallbackQuad = makeQuadForSlot(1);
  }
}

export const getSecureDispatcher = (skipTlsVerification: boolean = false) => {
  const slot = resolveActiveSlot();
  const q = quadForResolvedSlot(slot);
  return skipTlsVerification ? q.secureSkipTls : q.secure;
};

export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
) => {
  const slot = resolveActiveSlot();
  const q = quadForResolvedSlot(slot);
  return skipTlsVerification ? q.noCookiesSkipTls : q.noCookies;
};
