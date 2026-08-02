import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { setObservedNativeBadges } from "./nativeStore.js";
import type { NativeBadgeObservation } from "./types.js";

const MAX_BODY_SIZE = 48 * 1024;
const MAX_BADGES = 25;

let installed = false;

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

function cleanBadge(
  value: unknown,
  updatedAt: string,
): NativeBadgeObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const badge = value as { key?: unknown; name?: unknown; image?: unknown };
  const key = typeof badge.key === "string" ? badge.key.trim().toLowerCase() : "";
  const name = typeof badge.name === "string" ? badge.name.trim().slice(0, 100) : "";
  const image = typeof badge.image === "string" ? badge.image.trim().slice(0, 600) : "";

  if (!/^discord:[a-z0-9][a-z0-9._:-]{0,180}$/.test(key)) return undefined;
  if (!name) return undefined;

  try {
    const url = new URL(image);
    if (url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }

  return { key, name, image, updatedAt };
}

async function handleNativeInventory(
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
      badges?: unknown;
      authoritative?: unknown;
    };
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!/^\d{15,22}$/.test(userId)) throw new Error("Invalid Discord user ID");
    if (!Array.isArray(body.badges) || body.badges.length > MAX_BADGES) {
      throw new Error("Invalid native badge list");
    }

    const updatedAt = new Date().toISOString();
    const unique = new Map<string, NativeBadgeObservation>();
    for (const value of body.badges) {
      const badge = cleanBadge(value, updatedAt);
      if (!badge || unique.has(badge.key)) continue;
      unique.set(badge.key, badge);
    }

    const authoritative = body.authoritative === true;
    await setObservedNativeBadges(userId, [...unique.values()], authoritative);
    sendJson(response, 200, {
      ok: true,
      count: unique.size,
      authoritative,
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", "https://jadges.local");
  if (url.pathname !== "/api/native-badges") return false;
  await handleNativeInventory(request, response);
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleRequest(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges native inventory integration error:", error);
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: "Could not save native badges" });
      });
  };
}

export function installNativeInventoryIntegration(): void {
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
