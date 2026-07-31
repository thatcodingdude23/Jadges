import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { publicNitroPreset } from "./presets.js";
import { publicImageUrl } from "./storage.js";
import { readStore } from "./store.js";
import type {
  BadgeRecord,
  PublicBadge,
  PublicNitroPreset,
  UserRecord,
} from "./types.js";

const allowedFile = /^[0-9a-f-]+\.(?:png|jpg|webp|gif|apng)$/i;

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function requestOrigin(request: http.IncomingMessage): string {
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

function legacyNitroPreset(badges: BadgeRecord[]): PublicNitroPreset | undefined {
  let selected: BadgeRecord | undefined;

  for (const badge of badges) {
    if (badge.pending || !badge.nitroPreset) continue;

    const selectedTime = Date.parse(selected?.approvedAt || selected?.createdAt || "");
    const badgeTime = Date.parse(badge.approvedAt || badge.createdAt);

    if (!selected || !Number.isFinite(selectedTime) || badgeTime >= selectedTime) {
      selected = badge;
    }
  }

  if (!selected?.nitroPreset) return undefined;

  return publicNitroPreset(
    selected.nitroPreset,
    selected.approvedAt || selected.createdAt,
  );
}

function activeNitroPreset(user: UserRecord): PublicNitroPreset | undefined {
  if (user.nitro && !user.nitro.pending) {
    return publicNitroPreset(
      user.nitro.preset,
      user.nitro.approvedAt || user.nitro.createdAt,
    );
  }

  return legacyNitroPreset(user.badges);
}

function toPublicBadge(badge: BadgeRecord, origin: string): PublicBadge {
  return {
    name: badge.name,
    tooltip: badge.name,
    badge: publicImageUrl(badge.filename, origin),
    pending: false,
    createdAt: badge.createdAt,
  };
}

function publicBadgesForUser(user: UserRecord, origin: string): PublicBadge[] {
  const badges = user.badges
    .filter((badge) => !badge.pending)
    .map((badge) => toPublicBadge(badge, origin));

  const nitro = activeNitroPreset(user);
  if (nitro) {
    badges.unshift({
      name: `Nitro ${nitro.label}`,
      tooltip: `Subscriber since ${nitro.subscriberSince}`,
      badge: "",
      pending: false,
      nitro,
    });
  }

  return badges;
}

async function serveImage(
  response: http.ServerResponse,
  filename: string,
): Promise<void> {
  if (!allowedFile.test(filename)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const fullPath = path.join(config.imagesDir, filename);
  try {
    const file = await stat(fullPath);
    if (!file.isFile()) throw new Error("Not a file");

    const extension = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".apng": "image/apng",
    };

    response.writeHead(200, {
      "content-type": contentTypes[extension] || "application/octet-stream",
      "content-length": file.size,
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(fullPath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

export function startServer(): http.Server {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", config.publicUrl);
      const origin = requestOrigin(request);

      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "Jadges" });
        return;
      }

      if (url.pathname === "/badges.json") {
        const data = await readStore();
        const result: Record<string, PublicBadge[]> = {};

        for (const [userId, user] of Object.entries(data.users)) {
          const badges = publicBadgesForUser(user, origin);
          if (badges.length > 0) result[userId] = badges;
        }

        sendJson(response, 200, result);
        return;
      }

      if (url.pathname.startsWith("/users/")) {
        const userId = url.pathname.slice("/users/".length);
        if (!/^\d{15,22}$/.test(userId)) {
          sendJson(response, 400, { error: "Invalid Discord user ID" });
          return;
        }

        const data = await readStore();
        const user = data.users[userId] ?? { blocked: false, badges: [] };
        sendJson(response, 200, publicBadgesForUser(user, origin));
        return;
      }

      if (url.pathname.startsWith("/badges/")) {
        const filename = decodeURIComponent(url.pathname.slice("/badges/".length));
        await serveImage(response, filename);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      console.error("HTTP error:", error);
      sendJson(response, 500, { error: "Internal server error" });
    }
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`HTTP server listening on 0.0.0.0:${config.port}`);
  });
  return server;
}
