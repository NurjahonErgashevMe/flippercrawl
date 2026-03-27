import type { Socket } from "net";
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

/** Для scrape/fetch: выбор слота прокси (0 — основной, 1 — резерв). Вне ALS всегда 0 (webhook, search). */
export function runWithProxySlot<T>(slot: ProxySlot, fn: () => T): T {
  return proxySlotAls.run(slot, fn);
}

export function hasProxyFallback(): boolean {
  return (
    !!config.PROXY_SERVER?.trim() && !!config.PROXY_SERVER_FALLBACK?.trim()
  );
}

function resolveActiveSlot(): ProxySlot {
  const s = proxySlotAls.getStore();
  if (s === 1 && hasProxyFallback()) return 1;
  return 0;
}

function proxyUriForSlot(slot: ProxySlot): string | undefined {
  const raw =
    slot === 0
      ? config.PROXY_SERVER?.trim()
      : config.PROXY_SERVER_FALLBACK?.trim();
  if (!raw) return undefined;
  return raw.includes("://") ? raw : "http://" + raw;
}

function proxyAuthForSlot(slot: ProxySlot): {
  username?: string;
  password?: string;
} {
  if (slot === 0) {
    return {
      username: config.PROXY_USERNAME,
      password: config.PROXY_PASSWORD,
    };
  }
  return {
    username: config.PROXY_USERNAME_FALLBACK,
    password: config.PROXY_PASSWORD_FALLBACK,
  };
}

function createBaseAgentForSlot(
  slot: ProxySlot,
  skipTlsVerification: boolean,
): undici.Dispatcher {
  const uri = proxyUriForSlot(slot);
  const { username, password } = proxyAuthForSlot(slot);

  const baseAgent = uri
    ? new undici.ProxyAgent({
        uri,
        token: username
          ? `Basic ${Buffer.from(username + ":" + (password ?? "")).toString("base64")}`
          : undefined,
        requestTls: {
          rejectUnauthorized: !skipTlsVerification,
        },
      })
    : new undici.Agent({
        connect: {
          rejectUnauthorized: !skipTlsVerification,
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

function makeQuadForSlot(slot: ProxySlot): DispatcherQuad {
  const baseSecure = createBaseAgentForSlot(slot, false);
  const jar = new CookieJar();
  const secure = baseSecure.compose(cookie({ jar: jar }));
  attachSecurityCheck(secure);

  const baseSecureSkip = createBaseAgentForSlot(slot, true);
  const jarSkip = new CookieJar();
  const secureSkipTls = baseSecureSkip.compose(cookie({ jar: jarSkip }));
  attachSecurityCheck(secureSkipTls);

  const noCookies = createBaseAgentForSlot(slot, false);
  attachSecurityCheck(noCookies);

  const noCookiesSkipTls = createBaseAgentForSlot(slot, true);
  attachSecurityCheck(noCookiesSkipTls);

  return { secure, secureSkipTls, noCookies, noCookiesSkipTls };
}

function rebuildAllDispatchers() {
  primaryQuad = makeQuadForSlot(0);
  fallbackQuad = hasProxyFallback() ? makeQuadForSlot(1) : null;
}

let primaryQuad: DispatcherQuad;
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
  return primaryQuad;
}

/** После смены IP / сброса — закрыть пулы для указанного слота (или обоих) и пересобрать агенты. */
export async function resetProxyDispatchers(
  slot: ProxySlot | "all" = "all",
): Promise<void> {
  if (!config.PROXY_SERVER) return;

  if (!hasProxyFallback()) {
    await closeQuad(primaryQuad);
    rebuildAllDispatchers();
    return;
  }

  if (slot === "all") {
    await closeQuad(primaryQuad);
    if (fallbackQuad) await closeQuad(fallbackQuad);
    rebuildAllDispatchers();
    return;
  }

  if (slot === 0) {
    await closeQuad(primaryQuad);
    primaryQuad = makeQuadForSlot(0);
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

// Use this for webhook delivery to avoid sending empty cookie headers
export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
) => {
  const slot = resolveActiveSlot();
  const q = quadForResolvedSlot(slot);
  return skipTlsVerification ? q.noCookiesSkipTls : q.noCookies;
};
