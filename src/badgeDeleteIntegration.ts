import { createHmac, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { mutateStore } from "./store.js";
import type { UserRecord } from "./types.js";

const SESSION_COOKIE = "jadges_session";
const MAX_BODY_SIZE = 16 * 1024;
const CUSTOM_BADGE_KEY = /^custom:([0-9a-f-]{1,100})$/i;

interface DeleteUser extends UserRecord {
  hiddenBadgeKeys?: string[];
  profileVisibleBadgeKeys?: string[];
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
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function removeSavedKey(user: DeleteUser, key: string): void {
  if (Array.isArray(user.badgeOrder)) {
    user.badgeOrder = user.badgeOrder.filter((item) => item !== key);
    if (user.badgeOrder.length === 0) delete user.badgeOrder;
  }
  if (Array.isArray(user.hiddenBadgeKeys)) {
    user.hiddenBadgeKeys = user.hiddenBadgeKeys.filter((item) => item !== key);
    if (user.hiddenBadgeKeys.length === 0) delete user.hiddenBadgeKeys;
  }
  if (Array.isArray(user.profileVisibleBadgeKeys)) {
    user.profileVisibleBadgeKeys = user.profileVisibleBadgeKeys.filter((item) => item !== key);
  }
}

async function deleteBadge(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const userId = sessionUserId(request);
  if (!userId) {
    sendJson(response, 401, { error: "Login required" });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const suppliedOrigin = request.headers.origin?.replace(/\/$/, "");
  const expectedOrigin = config.publicUrl.replace(/\/$/, "");
  if (suppliedOrigin && suppliedOrigin !== expectedOrigin) {
    sendJson(response, 403, { error: "Origin check failed" });
    return;
  }

  try {
    const body = await readJson(request) as { key?: unknown };
    if (typeof body.key !== "string") throw new Error("Invalid badge key");
    const key = body.key.trim();
    const customMatch = key.match(CUSTOM_BADGE_KEY);
    if (!customMatch && key !== "nitro") {
      throw new Error("That badge cannot be deleted from the website");
    }

    let removedFilename: string | undefined;
    let removedName = "badge";

    await mutateStore((data) => {
      const user = data.users[userId] as DeleteUser | undefined;
      if (!user) throw new Error("Badge not found");

      if (customMatch) {
        const badgeId = customMatch[1]!;
        const index = user.badges.findIndex((badge) => badge.id === badgeId);
        if (index === -1) throw new Error("Badge not found");
        const [badge] = user.badges.splice(index, 1);
        if (!badge) throw new Error("Badge not found");
        removedFilename = badge.filename;
        removedName = badge.name;
      } else {
        const hadNitro = Boolean(user.nitro || user.pendingNitro)
          || user.badges.some((badge) => Boolean(badge.nitroPreset));
        if (!hadNitro) throw new Error("Nitro badge not found");
        delete user.nitro;
        delete user.pendingNitro;
        for (const badge of user.badges) delete badge.nitroPreset;
        removedName = "Nitro badge";
      }

      removeSavedKey(user, key);
    });

    if (removedFilename && path.basename(removedFilename) === removedFilename) {
      await rm(path.join(config.imagesDir, removedFilename), { force: true })
        .catch((error) => {
          console.warn(`Could not remove deleted badge image ${removedFilename}:`, error);
        });
    }

    sendJson(response, 200, { ok: true, key, name: removedName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete badge";
    sendJson(response, message.includes("not found") ? 404 : 400, { error: message });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);
  if (url.pathname !== "/api/delete-badge") return false;
  await deleteBadge(request, response);
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleRequest(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges badge deletion integration error:", error);
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: "Could not delete badge" });
      });
  };
}

export function installBadgeDeleteIntegration(): void {
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
