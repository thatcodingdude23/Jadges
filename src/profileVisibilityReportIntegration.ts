import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { config } from "./config.js";
import { getOrCreateUser, mutateStore } from "./store.js";
import type { UserRecord } from "./types.js";

const MAX_BODY_SIZE = 32 * 1024;
const MAX_VISIBLE_BADGES = 100;
const VALID_BADGE_KEY = /^(?:staff|nitro|custom:[a-z0-9-]{1,100}|discord:[a-z0-9._:-]{1,180})$/i;

interface ProfileVisibilityUser extends UserRecord {
  profileVisibleBadgeKeys?: string[];
  profileVisibilityReportedAt?: string;
}

let installed = false;

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((key): key is string => typeof key === "string")
      .map((key) => key.trim())
      .filter((key) => VALID_BADGE_KEY.test(key)),
  )].slice(0, MAX_VISIBLE_BADGES);
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
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function handleReport(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    });
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJson(request) as {
      userId?: unknown;
      visibleKeys?: unknown;
    };
    if (typeof body.userId !== "string" || !/^\d{15,22}$/.test(body.userId)) {
      throw new Error("Invalid Discord user ID");
    }
    if (!Array.isArray(body.visibleKeys)) {
      throw new Error("Invalid visible badge list");
    }

    const visibleKeys = normalizeKeys(body.visibleKeys);
    const reportedAt = new Date().toISOString();
    await mutateStore((data) => {
      const user = getOrCreateUser(data, body.userId as string) as ProfileVisibilityUser;
      user.profileVisibleBadgeKeys = visibleKeys;
      user.profileVisibilityReportedAt = reportedAt;
    });

    sendJson(response, 200, { ok: true, visibleKeys, reportedAt });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid profile visibility report",
    });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);
  if (url.pathname !== "/api/profile-visible-badges") return false;
  await handleReport(request, response);
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleRequest(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges profile visibility report error:", error);
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: "Could not save profile visibility" });
      });
  };
}

export function installProfileVisibilityReportIntegration(): void {
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
