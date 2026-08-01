import { createHmac, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { config } from "./config.js";
import { getOrCreateUser, mutateStore, readStore } from "./store.js";
import type { UserRecord } from "./types.js";

const SESSION_COOKIE = "jadges_session";
const MAX_BODY_SIZE = 32 * 1024;
const MAX_HIDDEN_BADGES = 100;
const VALID_BADGE_KEY = /^(?:staff|nitro|custom:[a-z0-9-]{1,100}|discord:[a-z0-9._:-]{1,180})$/i;

interface VisibilityUser extends UserRecord {
  hiddenBadgeKeys?: string[];
}

let installed = false;

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret)
    .update(value)
    .digest("base64url");
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return undefined;

  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return undefined;

  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { kind?: unknown; userId?: unknown; expiresAt?: unknown };
    if (
      payload.kind !== "session"
      || typeof payload.userId !== "string"
      || !/^\d{15,22}$/.test(payload.userId)
      || typeof payload.expiresAt !== "number"
      || payload.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return payload.userId;
  } catch {
    return undefined;
  }
}

function normalizeHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((key): key is string => typeof key === "string")
      .map((key) => key.trim())
      .filter((key) => VALID_BADGE_KEY.test(key)),
  )].slice(0, MAX_HIDDEN_BADGES);
}

function hiddenForUser(user: UserRecord | undefined): string[] {
  return normalizeHidden((user as VisibilityUser | undefined)?.hiddenBadgeKeys);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
  cors = false,
): void {
  const content = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": content.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(cors ? { "access-control-allow-origin": "*" } : {}),
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
}

async function handlePrivateVisibility(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const userId = sessionUserId(request);
  if (!userId) {
    sendJson(request, response, 401, { error: "Login required" });
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const data = await readStore();
    sendJson(request, response, 200, {
      hidden: hiddenForUser(data.users[userId]),
    });
    return;
  }

  if (request.method !== "POST") {
    sendJson(request, response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJson(request) as {
      key?: unknown;
      hidden?: unknown;
      keys?: unknown;
    };

    let saved: string[] = [];
    await mutateStore((data) => {
      const user = getOrCreateUser(data, userId) as VisibilityUser;
      const current = new Set(hiddenForUser(user));

      if (body.keys !== undefined) {
        saved = normalizeHidden(body.keys);
      } else {
        if (typeof body.key !== "string" || !VALID_BADGE_KEY.test(body.key.trim())) {
          throw new Error("Invalid badge key");
        }
        if (typeof body.hidden !== "boolean") {
          throw new Error("Invalid visibility state");
        }
        const key = body.key.trim();
        if (body.hidden) current.add(key);
        else current.delete(key);
        saved = [...current].slice(0, MAX_HIDDEN_BADGES);
      }

      if (saved.length > 0) user.hiddenBadgeKeys = saved;
      else delete user.hiddenBadgeKeys;
    });

    sendJson(request, response, 200, { hidden: saved });
  } catch (error) {
    sendJson(request, response, 400, {
      error: error instanceof Error ? error.message : "Invalid visibility settings",
    });
  }
}

async function handlePublicVisibility(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(request, response, 405, { error: "Method not allowed" }, true);
    return;
  }

  const data = await readStore();
  const result: Record<string, string[]> = {};
  for (const [userId, user] of Object.entries(data.users)) {
    const hidden = hiddenForUser(user);
    if (hidden.length > 0) result[userId] = hidden;
  }
  sendJson(request, response, 200, result, true);
}

async function handleVisibilityRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);
  if (url.pathname === "/api/badge-visibility") {
    await handlePrivateVisibility(request, response);
    return true;
  }
  if (url.pathname === "/visibility.json") {
    await handlePublicVisibility(request, response);
    return true;
  }
  return false;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleVisibilityRequest(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges visibility integration error:", error);
        if (response.headersSent) response.destroy();
        else sendJson(request, response, 500, { error: "Could not load badge visibility" });
      });
  };
}

export function installVisibilityIntegration(): void {
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
