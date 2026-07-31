import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { isNitroPreset, NITRO_PRESETS, publicNitroPreset } from "./presets.js";
import { handleRearrangeRequest } from "./rearrange.js";
import { publicImageUrl } from "./storage.js";
import { readStore } from "./store.js";
import type {
  BadgeRecord,
  NitroPreset,
  PublicBadge,
  PublicNitroPreset,
  UserRecord,
} from "./types.js";

const allowedFile = /^[0-9a-f-]+\.(?:png|jpg|webp|gif|apng)$/i;
const nitroIconCache = new Map<NitroPreset, Buffer>();
const JAYCORD_STAFF_ROLE_ID = "1532572957778645082";
const JAYCORD_ADMIN_ROLE_ID = "1531693475181887580";
const JAYCORD_STAFF_BADGE_NAME = "Jaycord Staff";
const JAYCORD_ADMIN_BADGE_NAME = "Jaycord Admin";
const STAFF_SYNC_INTERVAL = 60_000;
const MAX_REMOTE_IMAGE_SIZE = 2 * 1024 * 1024;

let jaycordStaffUserIds = new Set<string>();
let jaycordAdminUserIds = new Set<string>();
let staffSyncPromise: Promise<void> | undefined;
let lastStaffSyncAt = 0;

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

function mobileNitroIconUrl(origin: string, preset: NitroPreset): string {
  return `${origin.replace(/\/$/, "")}/nitro-icons/${preset}.png`;
}

async function refreshJaycordStaffMembers(): Promise<void> {
  if (!config.guildId) {
    if (lastStaffSyncAt === 0) {
      console.warn(
        "GUILD_ID is not configured, so the automatic Jaycord Staff badge cannot sync.",
      );
    }
    lastStaffSyncAt = Date.now();
    return;
  }

  const nextStaffUserIds = new Set<string>();
  const nextAdminUserIds = new Set<string>();
  let after: string | undefined;

  while (true) {
    const endpoint = new URL(
      `https://discord.com/api/v10/guilds/${config.guildId}/members`,
    );
    endpoint.searchParams.set("limit", "1000");
    if (after) endpoint.searchParams.set("after", after);

    const remote = await fetch(endpoint, {
      headers: {
        authorization: `Bot ${config.discordToken}`,
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!remote.ok) {
      const details = await remote.text().catch(() => "");
      throw new Error(
        `Discord member sync returned HTTP ${remote.status}${details ? `: ${details}` : ""}`,
      );
    }

    const members = await remote.json() as Array<{
      user?: { id?: string };
      roles?: string[];
    }>;

    if (!Array.isArray(members)) {
      throw new TypeError("Discord member sync returned invalid data");
    }

    for (const member of members) {
      const userId = member.user?.id;
      if (!userId || !Array.isArray(member.roles)) continue;

      if (member.roles.includes(JAYCORD_STAFF_ROLE_ID)) {
        nextStaffUserIds.add(userId);
      }
      if (member.roles.includes(JAYCORD_ADMIN_ROLE_ID)) {
        nextAdminUserIds.add(userId);
      }
    }

    if (members.length < 1000) break;

    const finalUserId = members.at(-1)?.user?.id;
    if (!finalUserId || finalUserId === after) break;
    after = finalUserId;
  }

  jaycordStaffUserIds = nextStaffUserIds;
  jaycordAdminUserIds = nextAdminUserIds;
  lastStaffSyncAt = Date.now();
  console.log(
    `Synced ${jaycordStaffUserIds.size} Jaycord Staff and ${jaycordAdminUserIds.size} Jaycord Admin role holders.`,
  );
}

async function ensureJaycordStaffMembersFresh(): Promise<void> {
  if (Date.now() - lastStaffSyncAt < STAFF_SYNC_INTERVAL) return;

  if (!staffSyncPromise) {
    staffSyncPromise = refreshJaycordStaffMembers()
      .catch((error) => {
        console.error("Could not sync the Jaycord Staff role:", error);
      })
      .finally(() => {
        staffSyncPromise = undefined;
      });
  }

  await staffSyncPromise;
}


type SystemStaffBadge = "staff" | "admin";

function systemStaffBadgeForUser(
  userId: string,
  user: UserRecord,
): SystemStaffBadge | undefined {
  const hasAdminRole = jaycordAdminUserIds.has(userId);
  const hasDefaultAccess = jaycordStaffUserIds.has(userId) || hasAdminRole;
  if (!hasDefaultAccess) return undefined;

  if (user.staffBadgeMode === "admin" && hasAdminRole) return "admin";
  return "staff";
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

function toPublicBadge(
  badge: BadgeRecord,
  origin: string,
  side: UserRecord["badgeSide"],
): PublicBadge {
  return {
    key: `custom:${badge.id}`,
    name: badge.name,
    tooltip: badge.name,
    badge: publicImageUrl(badge.filename, origin),
    pending: false,
    createdAt: badge.createdAt,
    side,
  };
}

function orderMovableBadges(user: UserRecord, badges: PublicBadge[]): PublicBadge[] {
  const rank = new Map((user.badgeOrder || []).map((key, index) => [key, index]));
  return badges
    .map((badge, index) => ({ badge, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.badge.key);
      const rightRank = rank.get(right.badge.key);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ badge }) => badge);
}

function settingsRecord(user: UserRecord): PublicBadge {
  return {
    key: "settings",
    name: "Jadges Settings",
    tooltip: "",
    badge: "",
    pending: false,
    side: user.badgeSide,
    metadata: true,
    order: user.badgeOrder ? [...user.badgeOrder] : [],
    nativeBadges: (user.nativeBadges || []).map((badge) => ({
      key: badge.key,
      name: badge.name,
      image: badge.image,
    })),
  };
}

function publicBadgesForUser(
  user: UserRecord,
  origin: string,
  systemStaffBadge: SystemStaffBadge | undefined,
): PublicBadge[] {
  const side = user.badgeSide;
  const movable = user.badges
    .filter((badge) => !badge.pending)
    .map((badge) => toPublicBadge(badge, origin, side));

  const nitro = activeNitroPreset(user);
  if (nitro) {
    movable.push({
      key: "nitro",
      name: nitro.key === "remove" ? "Remove Nitro Badge" : `Nitro ${nitro.label}`,
      tooltip: nitro.key === "remove"
        ? "Native Nitro and server-boosting badges hidden"
        : `Subscriber since ${nitro.subscriberSince}`,
      badge: "",
      pending: false,
      side,
      nitro: {
        ...nitro,
        mobileIcon: mobileNitroIconUrl(origin, nitro.key),
      },
    });
  }

  const ordered = orderMovableBadges(user, movable);

  if (systemStaffBadge) {
    const isAdmin = systemStaffBadge === "admin";
    const name = isAdmin ? JAYCORD_ADMIN_BADGE_NAME : JAYCORD_STAFF_BADGE_NAME;
    ordered.unshift({
      key: "staff",
      name,
      tooltip: name,
      badge: isAdmin ? config.jaycordAdminBadgeUrl : config.jaycordStaffBadgeUrl,
      pending: false,
      side,
    });
  }

  // Always include a settings record for stored users so native Discord order can
  // be applied even when the user has no custom Jadges badge.
  ordered.push(settingsRecord(user));
  return ordered;
}

async function serveNitroIcon(
  response: http.ServerResponse,
  preset: NitroPreset,
): Promise<void> {
  try {
    let png = nitroIconCache.get(preset);

    if (!png) {
      const sourceUrl = NITRO_PRESETS[preset].profileIcon;
      const remote = await fetch(sourceUrl, {
        headers: {
          accept: "image/svg+xml,image/*;q=0.8",
          "user-agent": "Jadges/1.0",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!remote.ok) {
        throw new Error(`Nitro icon source returned HTTP ${remote.status}`);
      }

      const contentLength = Number(remote.headers.get("content-length") || 0);
      if (contentLength > MAX_REMOTE_IMAGE_SIZE) {
        throw new Error("Nitro icon source was unexpectedly large");
      }

      const source = Buffer.from(await remote.arrayBuffer());
      if (source.length > MAX_REMOTE_IMAGE_SIZE) {
        throw new Error("Nitro icon source was unexpectedly large");
      }

      png = await sharp(source, { density: 288 })
        .resize(96, 96, {
          fit: "contain",
          withoutEnlargement: false,
        })
        .png()
        .toBuffer();

      nitroIconCache.set(preset, png);
    }

    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": png.length,
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=86400",
    });
    response.end(png);
  } catch (error) {
    console.error(`Could not render mobile Nitro icon ${preset}:`, error);
    sendJson(response, 502, { error: "Could not render Nitro icon" });
  }
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
  void ensureJaycordStaffMembersFresh();

  const staffSyncTimer = setInterval(() => {
    void ensureJaycordStaffMembersFresh();
  }, STAFF_SYNC_INTERVAL);
  staffSyncTimer.unref();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", config.publicUrl);
      const origin = requestOrigin(request);

      if (
        url.pathname === "/rearrange"
        || url.pathname === "/api/rearrange"
      ) {
        await ensureJaycordStaffMembersFresh();
      }

      if (
        await handleRearrangeRequest(
          request,
          response,
          url,
          origin,
          (userId, user) => systemStaffBadgeForUser(userId, user),
        )
      ) {
        return;
      }

      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "Jadges" });
        return;
      }

      if (url.pathname === "/badges.json") {
        await ensureJaycordStaffMembersFresh();
        const data = await readStore();
        const result: Record<string, PublicBadge[]> = {};
        const userIds = new Set([
          ...Object.keys(data.users),
          ...jaycordStaffUserIds,
          ...jaycordAdminUserIds,
        ]);

        for (const userId of userIds) {
          const user = data.users[userId] ?? { blocked: false, badges: [] };
          const badges = publicBadgesForUser(
            user,
            origin,
            systemStaffBadgeForUser(userId, user),
          );
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

        await ensureJaycordStaffMembersFresh();
        const data = await readStore();
        const user = data.users[userId] ?? { blocked: false, badges: [] };
        sendJson(
          response,
          200,
          publicBadgesForUser(
            user,
            origin,
            systemStaffBadgeForUser(userId, user),
          ),
        );
        return;
      }

      if (url.pathname === "/system-badges/jaycord-staff.png") {
        response.writeHead(302, {
          location: config.jaycordStaffBadgeUrl,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      if (url.pathname === "/system-badges/jaycord-admin.png") {
        response.writeHead(302, {
          location: config.jaycordAdminBadgeUrl,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      if (url.pathname.startsWith("/nitro-icons/")) {
        const filename = decodeURIComponent(
          url.pathname.slice("/nitro-icons/".length),
        );
        const match = /^([a-z]+)\.png$/.exec(filename);
        const preset = match?.[1];

        if (!isNitroPreset(preset)) {
          sendJson(response, 404, { error: "Not found" });
          return;
        }

        await serveNitroIcon(response, preset);
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
