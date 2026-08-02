import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import {
  canAccessAdminPanel,
  handleAdminRequest,
} from "./adminPanel.js";
import { config } from "./config.js";
import { handleWebsiteRequest } from "./website.js";
import type { UserRecord } from "./types.js";

const SESSION_COOKIE = "jadges_session";
const STAFF_ROLE_ID = "1532572957778645082";
const ADMIN_ROLE_ID = "1531693475181887580";
const ROLE_CACHE_MS = 60_000;
const WEBSITE_STATE_MS = 10 * 60 * 1000;

type StaffAccess = "staff" | "admin" | "none";
type SignedIdentityPayload = SessionPayload | TicketPayload;

interface SessionPayload {
  kind: "session";
  userId: string;
  expiresAt: number;
}

interface TicketPayload {
  kind: "ticket";
  userId: string;
  expiresAt: number;
  nonce: string;
}

interface WebsiteStatePayload {
  kind: "website-state";
  expiresAt: number;
  nonce: string;
}

interface RoleCacheEntry {
  access: StaffAccess;
  checkedAt: number;
}

const roleCache = new Map<string, RoleCacheEntry>();
let installed = false;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeaderValue(request.headers.host);

  if (host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
    const protocol = forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : "https";
    return `${protocol}://${host}`;
  }
  return config.publicUrl;
}

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret)
    .update(value)
    .digest("base64url");
}

function signWebsiteState(payload: WebsiteStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signature(body)}`;
}

function verifyIdentityPayload<T extends SignedIdentityPayload>(
  token: string | undefined,
  kind: T["kind"],
): T | undefined {
  if (!token) return undefined;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return undefined;

  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(suppliedSignature);
  if (
    expected.length !== supplied.length
    || !timingSafeEqual(expected, supplied)
  ) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SignedIdentityPayload;
    if (
      payload.kind !== kind
      || payload.expiresAt <= Date.now()
      || !/^\d{15,22}$/.test(payload.userId)
    ) {
      return undefined;
    }
    return payload as T;
  } catch {
    return undefined;
  }
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const cookie = (request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const raw = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return undefined;

  try {
    return verifyIdentityPayload<SessionPayload>(
      decodeURIComponent(raw),
      "session",
    )?.userId;
  } catch {
    return undefined;
  }
}

function matchingRearrangeSession(
  request: IncomingMessage,
  url: URL,
): boolean {
  const sessionId = sessionUserId(request);
  const ticket = verifyIdentityPayload<TicketPayload>(
    url.searchParams.get("ticket") || undefined,
    "ticket",
  );
  return Boolean(sessionId && ticket && sessionId === ticket.userId);
}

async function refreshUserAccess(userId: string): Promise<void> {
  const cached = roleCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < ROLE_CACHE_MS) return;

  if (!config.guildId) {
    roleCache.set(userId, { access: "none", checkedAt: Date.now() });
    return;
  }

  try {
    const response = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(userId)}`,
      {
        headers: {
          authorization: `Bot ${config.discordToken}`,
          "user-agent": "Jadges/1.0",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (response.status === 404) {
      roleCache.set(userId, { access: "none", checkedAt: Date.now() });
      return;
    }
    if (!response.ok) {
      throw new Error(`Discord returned HTTP ${response.status}`);
    }

    const member = await response.json() as { roles?: unknown };
    const roles = Array.isArray(member.roles)
      ? member.roles.filter((role): role is string => typeof role === "string")
      : [];
    const access: StaffAccess = roles.includes(ADMIN_ROLE_ID)
      ? "admin"
      : roles.includes(STAFF_ROLE_ID)
        ? "staff"
        : "none";
    roleCache.set(userId, { access, checkedAt: Date.now() });
  } catch (error) {
    console.warn(`Could not refresh website staff access for ${userId}:`, error);
    if (!cached) {
      roleCache.set(userId, { access: "none", checkedAt: Date.now() });
    }
  }
}

function resolveStaffBadge(
  userId: string,
  user: UserRecord,
): "staff" | "admin" | undefined {
  const access = roleCache.get(userId)?.access;
  if (access === "admin" && user.staffBadgeMode === "admin") return "admin";
  if (access === "admin" || access === "staff") return "staff";
  return undefined;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  response.end();
}

function startWebsiteLogin(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.method !== "GET") return false;
  if (sessionUserId(request)) {
    redirect(response, "/dashboard");
    return true;
  }
  if (!config.discordClientSecret) return false;

  const state = signWebsiteState({
    kind: "website-state",
    expiresAt: Date.now() + WEBSITE_STATE_MS,
    nonce: randomBytes(12).toString("hex"),
  });
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set(
    "redirect_uri",
    `${config.publicUrl}/oauth/callback`,
  );
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "consent");
  redirect(response, authorize.toString());
  return true;
}

function installAdminDashboardLink(response: ServerResponse): void {
  const originalEnd = response.end.bind(response);
  let ended = false;

  response.end = ((
    chunk?: any,
    encoding?: any,
    callback?: any,
  ): ServerResponse => {
    if (ended) return response;
    ended = true;

    if (
      chunk === undefined
      || response.statusCode < 200
      || response.statusCode >= 300
    ) {
      originalEnd(chunk, encoding, callback);
      return response;
    }

    const body = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString("utf8")
        : String(chunk);

    const marker = `</nav>
      <div class="sidebar-spacer">`;
    const adminLink = `<a class="nav-link" href="/admin"><svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5-3.2 8.7-8 10-4.8-1.3-8-5-8-10V6l8-3Z"/><path d="M9.5 12.2 11.2 14l3.7-4"/></svg>Admin Panel</a>
      </nav>
      <div class="sidebar-spacer">`;

    originalEnd(
      body.includes(marker) ? body.replace(marker, adminLink) : body,
      "utf8",
      callback,
    );
    return response;
  }) as typeof response.end;
}

function wrap(listener: RequestListener): RequestListener {
  return (request: IncomingMessage, response: ServerResponse) => {
    const run = async (): Promise<void> => {
      const url = new URL(request.url || "/", config.publicUrl);

      if (url.pathname === "/login" && startWebsiteLogin(request, response)) {
        return;
      }

      if (
        url.pathname === "/rearrange"
        && matchingRearrangeSession(request, url)
      ) {
        redirect(response, "/dashboard");
        return;
      }

      if (await handleAdminRequest(request, response, url)) {
        return;
      }

      if (
        url.pathname === "/dashboard"
        || url.pathname === "/api/dashboard"
      ) {
        const userId = sessionUserId(request);
        if (userId) {
          await refreshUserAccess(userId);
          if (
            url.pathname === "/dashboard"
            && await canAccessAdminPanel(userId)
          ) {
            installAdminDashboardLink(response);
          }
        }
      }

      const handled = await handleWebsiteRequest(
        request,
        response,
        url,
        requestOrigin(request),
        resolveStaffBadge,
      );
      if (!handled) listener(request, response);
    };

    void run().catch((error) => {
      console.error("Jadges website request failed:", error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "Website request failed" }));
    });
  };
}

export function installWebsiteIntegration(): void {
  if (installed) return;
  installed = true;

  const mutable = http as typeof http & {
    createServer: (...args: any[]) => http.Server;
  };
  const original = mutable.createServer.bind(http) as (...args: any[]) => http.Server;

  mutable.createServer = ((...args: any[]): http.Server => {
    const listenerIndex = typeof args[0] === "function"
      ? 0
      : typeof args[1] === "function"
        ? 1
        : -1;
    if (listenerIndex !== -1) {
      args[listenerIndex] = wrap(args[listenerIndex] as RequestListener);
    }
    return original(...args);
  }) as typeof http.createServer;
}
