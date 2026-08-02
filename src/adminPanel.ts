import { createHmac, timingSafeEqual } from "node:crypto";
import {
  appendFile,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { NITRO_PRESETS } from "./presets.js";
import { publicImageUrl } from "./storage.js";
import { getOrCreateUser, mutateStore, readStore } from "./store.js";
import type { BadgeRecord, UserRecord } from "./types.js";

const SESSION_COOKIE = "jadges_session";
const ADMIN_ROLE_ID = "1532572957778645082";
const MAX_BODY_SIZE = 32 * 1024;
const ADMIN_ACCESS_CACHE_MS = 30_000;
const SECURITY_LOG_COOLDOWN_MS = 10 * 60 * 1000;
const ACTION_WINDOW_MS = 60_000;
const ACTION_LIMIT = 30;
const AUDIT_FILE = path.join(config.dataDir, "admin-audit.jsonl");

interface SessionPayload {
  kind: "session";
  userId: string;
  expiresAt: number;
}

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
}

interface DiscordMember {
  user?: DiscordUser;
  nick?: string | null;
  roles?: string[];
  joined_at?: string | null;
  communication_disabled_until?: string | null;
}

interface AdminAccess {
  allowed: boolean;
  inGuild: boolean;
  member?: DiscordMember;
  checkedAt: number;
}

interface ManagedUser extends UserRecord {
  hiddenBadgeKeys?: string[];
  profileVisibleBadgeKeys?: string[];
  profileVisibilityReportedAt?: string;
}

interface AuditEvent {
  at: string;
  kind: "security" | "action";
  actorId: string;
  actorUsername: string;
  action: string;
  targetId?: string;
  targetUsername?: string;
  reason?: string;
  route?: string;
  ip?: string;
  inGuild?: boolean;
  details?: Record<string, unknown>;
}

const accessCache = new Map<string, AdminAccess>();
const securityLogTimes = new Map<string, number>();
const actionTimes = new Map<string, number[]>();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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
  if (
    expected.length !== supplied.length
    || !timingSafeEqual(expected, supplied)
  ) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;

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

function csrfToken(userId: string): string {
  return signature(`jadges-admin-csrf:${userId}`);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function requestIp(request: IncomingMessage): string {
  const value =
    firstHeaderValue(request.headers["x-forwarded-for"])
    || firstHeaderValue(request.headers["cf-connecting-ip"])
    || request.socket.remoteAddress
    || "Unavailable";
  return value.replace(/^::ffff:/, "").slice(0, 120);
}

function requestOrigin(request: IncomingMessage): string | undefined {
  return firstHeaderValue(request.headers.origin)?.replace(/\/$/, "");
}

function originIsAllowed(request: IncomingMessage): boolean {
  const supplied = requestOrigin(request);
  return !supplied || supplied === config.publicUrl.replace(/\/$/, "");
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  response.end();
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

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' https: data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  });
  response.end(html);
}

async function serveAsset(
  response: ServerResponse,
  filename: "jadges-admin.css" | "jadges-admin.js",
): Promise<void> {
  const content = await readFile(new URL(`../web/${filename}`, import.meta.url));
  response.writeHead(200, {
    "content-type": filename.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8",
    "content-length": content.length,
    "cache-control": "public, max-age=300, must-revalidate",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function discordRequest(
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.discordToken}`);
  headers.set("user-agent", "Jadges/1.0");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(`https://discord.com/api/v10${route}`, {
    ...init,
    headers,
    signal: init.signal || AbortSignal.timeout(20_000),
  });
}

async function fetchDiscordUser(userId: string): Promise<DiscordUser> {
  const response = await discordRequest(`/users/${encodeURIComponent(userId)}`);
  if (!response.ok) {
    return { id: userId, username: "unknown-user" };
  }
  const user = await response.json() as DiscordUser;
  return { ...user, id: userId };
}

async function fetchAdminAccess(
  userId: string,
  force = false,
): Promise<AdminAccess> {
  const cached = accessCache.get(userId);
  if (
    !force
    && cached
    && Date.now() - cached.checkedAt < ADMIN_ACCESS_CACHE_MS
  ) {
    return cached;
  }

  if (!config.guildId) {
    const access: AdminAccess = {
      allowed: false,
      inGuild: false,
      checkedAt: Date.now(),
    };
    accessCache.set(userId, access);
    return access;
  }

  try {
    const response = await discordRequest(
      `/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(userId)}`,
    );

    if (response.status === 404) {
      const access: AdminAccess = {
        allowed: false,
        inGuild: false,
        checkedAt: Date.now(),
      };
      accessCache.set(userId, access);
      return access;
    }

    if (!response.ok) {
      throw new Error(`Discord returned HTTP ${response.status}`);
    }

    const member = await response.json() as DiscordMember;
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const access: AdminAccess = {
      allowed: roles.includes(ADMIN_ROLE_ID),
      inGuild: true,
      member,
      checkedAt: Date.now(),
    };
    accessCache.set(userId, access);
    return access;
  } catch (error) {
    console.error(`Could not check Jadges admin access for ${userId}:`, error);
    const fallback: AdminAccess = {
      allowed: false,
      inGuild: Boolean(cached?.inGuild),
      member: cached?.member,
      checkedAt: Date.now(),
    };
    accessCache.set(userId, fallback);
    return fallback;
  }
}

export async function canAccessAdminPanel(userId: string): Promise<boolean> {
  return (await fetchAdminAccess(userId)).allowed;
}

function displayName(user: DiscordUser | undefined, member?: DiscordMember): string {
  return (
    member?.nick
    || user?.global_name
    || user?.username
    || "Unknown User"
  );
}

function username(user: DiscordUser | undefined): string {
  return user?.username || "unknown-user";
}

function avatarUrl(user: DiscordUser | undefined): string {
  if (user?.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${extension}?size=128`;
  }
  return "https://cdn.discordapp.com/embed/avatars/0.png";
}

async function sendDiscordLog(
  title: string,
  color: number,
  fields: Array<{ name: string; value: string; inline?: boolean }>,
  description?: string,
): Promise<void> {
  if (!config.adminLogChannel) return;

  try {
    const response = await discordRequest(
      `/channels/${encodeURIComponent(config.adminLogChannel)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          embeds: [{
            title,
            description,
            color,
            fields: fields.map((field) => ({
              ...field,
              value: field.value.slice(0, 1024),
            })),
            timestamp: new Date().toISOString(),
            footer: { text: "Jadges Admin Security" },
          }],
          allowed_mentions: { parse: [] },
        }),
      },
    );

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.error(
        `Could not send Jadges admin log: HTTP ${response.status}${details ? ` ${details}` : ""}`,
      );
    }
  } catch (error) {
    console.error("Could not send Jadges admin log:", error);
  }
}

async function appendAudit(event: AuditEvent): Promise<void> {
  try {
    await appendFile(AUDIT_FILE, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    console.error("Could not write Jadges admin audit event:", error);
  }
}

async function recentAudit(limit = 50): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(AUDIT_FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 100)))
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEvent;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is AuditEvent => Boolean(entry));
  } catch {
    return [];
  }
}

async function logUnauthorized(
  request: IncomingMessage,
  actorId: string,
  access: AdminAccess,
): Promise<void> {
  const ip = requestIp(request);
  const key = `${actorId}:${ip}`;
  const previous = securityLogTimes.get(key) || 0;
  if (Date.now() - previous < SECURITY_LOG_COOLDOWN_MS) return;
  securityLogTimes.set(key, Date.now());

  const user = access.member?.user || await fetchDiscordUser(actorId);
  const event: AuditEvent = {
    at: new Date().toISOString(),
    kind: "security",
    actorId,
    actorUsername: username(user),
    action: "Unauthorized admin access",
    route: request.url || "/admin",
    ip,
    inGuild: access.inGuild,
  };

  await Promise.all([
    appendAudit(event),
    sendDiscordLog(
      "🚨 Exploiter Found",
      0xff3158,
      [
        {
          name: "Authorized account",
          value: `${displayName(user, access.member)} (@${username(user)})`,
        },
        { name: "User ID", value: actorId, inline: true },
        { name: "In server", value: access.inGuild ? "Yes" : "No", inline: true },
        { name: "Required role", value: ADMIN_ROLE_ID, inline: true },
        { name: "IP address", value: ip, inline: true },
        { name: "Route", value: request.url || "/admin" },
      ],
      "A Discord-authorized account attempted to open a protected Jadges admin route without the required role. Access was denied server-side.",
    ),
  ]);
}

function allowAction(actorId: string): boolean {
  const now = Date.now();
  const recent = (actionTimes.get(actorId) || [])
    .filter((time) => now - time < ACTION_WINDOW_MS);

  if (recent.length >= ACTION_LIMIT) {
    actionTimes.set(actorId, recent);
    return false;
  }

  recent.push(now);
  actionTimes.set(actorId, recent);
  return true;
}

function validateReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("A reason is required");
  }
  const reason = value.trim().replace(/\s+/g, " ");
  if (reason.length < 3) {
    throw new Error("The reason must be at least 3 characters");
  }
  if (reason.length > 300) {
    throw new Error("The reason cannot exceed 300 characters");
  }
  return reason;
}

function cleanSavedBadgeKey(user: ManagedUser, key: string): void {
  if (Array.isArray(user.badgeOrder)) {
    user.badgeOrder = user.badgeOrder.filter((item) => item !== key);
    if (user.badgeOrder.length === 0) delete user.badgeOrder;
  }
  if (Array.isArray(user.hiddenBadgeKeys)) {
    user.hiddenBadgeKeys = user.hiddenBadgeKeys.filter((item) => item !== key);
    if (user.hiddenBadgeKeys.length === 0) delete user.hiddenBadgeKeys;
  }
  if (Array.isArray(user.profileVisibleBadgeKeys)) {
    user.profileVisibleBadgeKeys = user.profileVisibleBadgeKeys
      .filter((item) => item !== key);
  }
}

async function deleteImage(filename: string | undefined): Promise<void> {
  if (!filename || path.basename(filename) !== filename) return;
  await rm(path.join(config.imagesDir, filename), { force: true }).catch((error) => {
    console.warn(`Could not delete admin-removed badge image ${filename}:`, error);
  });
}

async function deleteImages(filenames: string[]): Promise<void> {
  await Promise.all(filenames.map((filename) => deleteImage(filename)));
}

async function recordAdminAction(
  request: IncomingMessage,
  actorId: string,
  access: AdminAccess,
  action: string,
  targetId: string,
  targetUser: DiscordUser,
  reason: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const actor = access.member?.user || await fetchDiscordUser(actorId);
  const event: AuditEvent = {
    at: new Date().toISOString(),
    kind: "action",
    actorId,
    actorUsername: username(actor),
    action,
    targetId,
    targetUsername: username(targetUser),
    reason,
    ip: requestIp(request),
    inGuild: access.inGuild,
    details,
  };

  await Promise.all([
    appendAudit(event),
    sendDiscordLog(
      "🛡️ Jadges Admin Action",
      0x7c4dff,
      [
        {
          name: "Administrator",
          value: `${displayName(actor, access.member)} (@${username(actor)})`,
        },
        { name: "Administrator ID", value: actorId, inline: true },
        {
          name: "Target",
          value: `${displayName(targetUser)} (@${username(targetUser)})`,
        },
        { name: "Target ID", value: targetId, inline: true },
        { name: "Action", value: action, inline: true },
        { name: "Reason", value: reason },
        { name: "IP address", value: requestIp(request), inline: true },
      ],
      details ? `Details: ${JSON.stringify(details).slice(0, 500)}` : undefined,
    ),
  ]);
}

async function imageStorageStats(): Promise<{
  imageFiles: number;
  imageBytes: number;
}> {
  try {
    const entries = await readdir(config.imagesDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const sizes = await Promise.all(
      files.map((entry) =>
        stat(path.join(config.imagesDir, entry.name))
          .then((value) => value.size)
          .catch(() => 0)
      ),
    );
    return {
      imageFiles: files.length,
      imageBytes: sizes.reduce((sum, size) => sum + size, 0),
    };
  } catch {
    return { imageFiles: 0, imageBytes: 0 };
  }
}

async function guildCounts(): Promise<{
  memberCount?: number;
  onlineCount?: number;
}> {
  if (!config.guildId) return {};
  try {
    const response = await discordRequest(
      `/guilds/${encodeURIComponent(config.guildId)}?with_counts=true`,
    );
    if (!response.ok) return {};
    const guild = await response.json() as {
      approximate_member_count?: number;
      approximate_presence_count?: number;
    };
    return {
      memberCount: guild.approximate_member_count,
      onlineCount: guild.approximate_presence_count,
    };
  } catch {
    return {};
  }
}

async function adminStats(): Promise<Record<string, number | undefined>> {
  const [data, images, guild] = await Promise.all([
    readStore(),
    imageStorageStats(),
    guildCounts(),
  ]);

  let approvedBadges = 0;
  let pendingBadges = 0;
  let equippedNitro = 0;
  let pendingNitro = 0;
  let nativeBadges = 0;
  let blockedUsers = 0;

  for (const user of Object.values(data.users)) {
    if (user.blocked) blockedUsers += 1;
    for (const badge of user.badges || []) {
      if (badge.pending) pendingBadges += 1;
      else approvedBadges += 1;
    }
    if (user.nitro) equippedNitro += 1;
    if (user.pendingNitro) pendingNitro += 1;
    nativeBadges += user.nativeBadges?.length || 0;
  }

  return {
    storedUsers: Object.keys(data.users).length,
    blockedUsers,
    approvedBadges,
    pendingBadges,
    equippedNitro,
    pendingNitro,
    nativeBadges,
    imageFiles: images.imageFiles,
    imageBytes: images.imageBytes,
    guildMembers: guild.memberCount,
    guildOnline: guild.onlineCount,
  };
}

function userSummary(
  user: DiscordUser,
  member: DiscordMember | undefined,
  stored: UserRecord | undefined,
): Record<string, unknown> {
  return {
    id: user.id,
    username: username(user),
    displayName: displayName(user, member),
    avatar: avatarUrl(user),
    inGuild: Boolean(member),
    blocked: Boolean(stored?.blocked),
    badgeCount: stored?.badges?.filter((badge) => !badge.pending).length || 0,
    pendingBadgeCount: stored?.badges?.filter((badge) => badge.pending).length || 0,
    roles: member?.roles || [],
  };
}

async function findMember(userId: string): Promise<DiscordMember | undefined> {
  if (!config.guildId) return undefined;
  const response = await discordRequest(
    `/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(userId)}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Discord member lookup returned HTTP ${response.status}`);
  }
  return response.json() as Promise<DiscordMember>;
}

async function searchUsers(query: string): Promise<Record<string, unknown>[]> {
  const normalized = query.trim().slice(0, 100);
  if (!normalized) return [];

  const store = await readStore();

  if (/^\d{15,22}$/.test(normalized)) {
    const member = await findMember(normalized).catch(() => undefined);
    const user = member?.user || await fetchDiscordUser(normalized);
    return [userSummary(user, member, store.users[normalized])];
  }

  if (!config.guildId) return [];

  const response = await discordRequest(
    `/guilds/${encodeURIComponent(config.guildId)}/members/search?query=${encodeURIComponent(normalized)}&limit=20`,
  );

  if (!response.ok) {
    throw new Error(`Discord member search returned HTTP ${response.status}`);
  }

  const members = await response.json() as DiscordMember[];
  return members
    .filter((member): member is DiscordMember & { user: DiscordUser } =>
      Boolean(member.user?.id)
    )
    .map((member) =>
      userSummary(
        member.user,
        member,
        store.users[member.user.id],
      )
    );
}

function publicBadgeRecord(badge: BadgeRecord): Record<string, unknown> {
  return {
    id: badge.id,
    name: badge.name,
    pending: badge.pending,
    createdAt: badge.createdAt,
    approvedAt: badge.approvedAt,
    image: publicImageUrl(badge.filename, config.publicUrl),
  };
}

async function userDetails(userId: string): Promise<Record<string, unknown>> {
  const [store, member] = await Promise.all([
    readStore(),
    findMember(userId).catch(() => undefined),
  ]);
  const discordUser = member?.user || await fetchDiscordUser(userId);
  const stored = store.users[userId] as ManagedUser | undefined;

  return {
    ...userSummary(discordUser, member, stored),
    joinedAt: member?.joined_at,
    timeoutUntil: member?.communication_disabled_until,
    stored: Boolean(stored),
    badges: (stored?.badges || []).map(publicBadgeRecord),
    nitro: stored?.nitro
      ? {
          preset: stored.nitro.preset,
          label: NITRO_PRESETS[stored.nitro.preset]?.label || stored.nitro.preset,
          pending: stored.nitro.pending,
          createdAt: stored.nitro.createdAt,
          approvedAt: stored.nitro.approvedAt,
        }
      : undefined,
    pendingNitro: stored?.pendingNitro
      ? {
          preset: stored.pendingNitro.preset,
          label: NITRO_PRESETS[stored.pendingNitro.preset]?.label || stored.pendingNitro.preset,
          createdAt: stored.pendingNitro.createdAt,
        }
      : undefined,
    nativeBadges: stored?.nativeBadges || [],
    badgeSide: stored?.badgeSide,
    badgeOrder: stored?.badgeOrder || [],
    hiddenBadgeKeys: stored?.hiddenBadgeKeys || [],
    profileVisibilityReportedAt: stored?.profileVisibilityReportedAt,
  };
}

async function setBlockedState(
  userId: string,
  blocked: boolean,
): Promise<void> {
  await mutateStore((data) => {
    getOrCreateUser(data, userId).blocked = blocked;
  });
}

async function removeSelectedBadge(
  userId: string,
  badgeId: string,
): Promise<BadgeRecord> {
  let removed: BadgeRecord | undefined;

  await mutateStore((data) => {
    const user = data.users[userId] as ManagedUser | undefined;
    if (!user) throw new Error("User record not found");

    const index = user.badges.findIndex((badge) => badge.id === badgeId);
    if (index === -1) throw new Error("Badge not found");

    const candidate = user.badges.splice(index, 1)[0];
    if (!candidate) throw new Error("Badge not found");

    cleanSavedBadgeKey(user, `custom:${candidate.id}`);
    removed = candidate;
  });

  if (!removed) throw new Error("Badge not found");
  await deleteImage(removed.filename);
  return removed;
}

async function removeAllBadges(userId: string): Promise<{
  removedBadges: number;
  removedNitro: boolean;
  removedPendingNitro: boolean;
  removedNativeBadges: number;
}> {
  let filenames: string[] = [];
  let result = {
    removedBadges: 0,
    removedNitro: false,
    removedPendingNitro: false,
    removedNativeBadges: 0,
  };

  await mutateStore((data) => {
    const user = data.users[userId] as ManagedUser | undefined;
    if (!user) throw new Error("User record not found");

    filenames = user.badges
      .map((badge) => badge.filename)
      .filter((filename): filename is string => Boolean(filename));

    result = {
      removedBadges: user.badges.length,
      removedNitro: Boolean(user.nitro),
      removedPendingNitro: Boolean(user.pendingNitro),
      removedNativeBadges: user.nativeBadges?.length || 0,
    };

    user.badges = [];
    delete user.nitro;
    delete user.pendingNitro;
    delete user.badgeOrder;
    delete user.nativeBadges;
    delete user.hiddenBadgeKeys;
    delete user.profileVisibleBadgeKeys;
    delete user.profileVisibilityReportedAt;
  });

  await deleteImages(filenames);
  return result;
}

async function purgeUserRecord(userId: string): Promise<{
  removedBadges: number;
}> {
  let filenames: string[] = [];
  let removedBadges = 0;

  await mutateStore((data) => {
    const user = data.users[userId];
    if (!user) throw new Error("User record not found");

    filenames = user.badges
      .map((badge) => badge.filename)
      .filter((filename): filename is string => Boolean(filename));
    removedBadges = user.badges.length;
    delete data.users[userId];
  });

  await deleteImages(filenames);
  return { removedBadges };
}

async function discordServerAction(
  action: "kick" | "ban" | "unban",
  targetId: string,
  reason: string,
): Promise<void> {
  if (!config.guildId) throw new Error("GUILD_ID is not configured");

  const encodedGuild = encodeURIComponent(config.guildId);
  const encodedTarget = encodeURIComponent(targetId);
  const headers = {
    "x-audit-log-reason": encodeURIComponent(reason).slice(0, 512),
  };

  let response: Response;
  if (action === "kick") {
    response = await discordRequest(
      `/guilds/${encodedGuild}/members/${encodedTarget}`,
      { method: "DELETE", headers },
    );
  } else if (action === "ban") {
    response = await discordRequest(
      `/guilds/${encodedGuild}/bans/${encodedTarget}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ delete_message_seconds: 0 }),
      },
    );
  } else {
    response = await discordRequest(
      `/guilds/${encodedGuild}/bans/${encodedTarget}`,
      { method: "DELETE", headers },
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Discord ${action} failed with HTTP ${response.status}${details ? `: ${details.slice(0, 300)}` : ""}`,
    );
  }
}

function adminPage(
  actorId: string,
  actor: DiscordUser,
  member: DiscordMember | undefined,
): string {
  const safeName = escapeHtml(displayName(actor, member));
  const safeUsername = escapeHtml(username(actor));
  const safeAvatar = escapeHtml(avatarUrl(actor));
  const safeCsrf = escapeHtml(csrfToken(actorId));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#090b14">
  <meta name="jadges-admin-csrf" content="${safeCsrf}">
  <title>Admin Panel — Jadges</title>
  <link rel="stylesheet" href="/assets/jadges-admin.css">
</head>
<body>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <a class="admin-brand" href="/dashboard">
        <span class="admin-brand-mark">J</span>
        <span><strong>Jadges</strong><small>Administration</small></span>
      </a>
      <nav>
        <button class="admin-nav active" data-view="overview">Overview</button>
        <button class="admin-nav" data-view="users">User Manager</button>
        <button class="admin-nav" data-view="audit">Audit Log</button>
      </nav>
      <div class="admin-sidebar-foot">
        <img src="${safeAvatar}" alt="">
        <div><strong>${safeName}</strong><span>@${safeUsername}</span></div>
        <a href="/dashboard">Exit</a>
      </div>
    </aside>

    <main class="admin-main">
      <header class="admin-topbar">
        <div>
          <p class="eyebrow">Protected workspace</p>
          <h1>Jadges Admin Panel</h1>
        </div>
        <div class="admin-role-pill">Role verified • ${ADMIN_ROLE_ID}</div>
      </header>

      <section class="admin-view active" data-panel="overview">
        <div class="section-heading">
          <div><h2>Live statistics</h2><p>Persistent Render data and Discord server information.</p></div>
          <button class="button ghost" id="refresh-stats">Refresh</button>
        </div>
        <div class="stats-grid" id="stats-grid">
          <div class="loading-card">Loading statistics…</div>
        </div>
        <div class="dashboard-columns">
          <article class="panel">
            <div class="panel-heading"><h3>Quick user lookup</h3></div>
            <form class="search-form" id="overview-search-form">
              <input id="overview-search" placeholder="User ID or username" autocomplete="off">
              <button class="button primary" type="submit">Search</button>
            </form>
            <div id="overview-results" class="result-list compact"></div>
          </article>
          <article class="panel">
            <div class="panel-heading"><h3>Security</h3></div>
            <div class="security-copy">
              <strong>Server-side authorization</strong>
              <p>Every admin request re-checks the Discord guild and required role. Unauthorized authorized accounts are denied and logged.</p>
              <dl>
                <div><dt>Required role</dt><dd>${ADMIN_ROLE_ID}</dd></div>
                <div><dt>Security logs</dt><dd>Discord + persistent audit file</dd></div>
                <div><dt>CSRF protection</dt><dd>Enabled</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </section>

      <section class="admin-view" data-panel="users">
        <div class="section-heading">
          <div><h2>User manager</h2><p>Search Jadges records or Discord server members.</p></div>
        </div>
        <form class="search-form wide" id="user-search-form">
          <input id="user-search" placeholder="Search username or paste a Discord user ID" autocomplete="off">
          <button class="button primary" type="submit">Find user</button>
        </form>
        <div class="user-manager-grid">
          <div class="panel result-panel">
            <div class="panel-heading"><h3>Results</h3><span id="result-count">0 users</span></div>
            <div id="user-results" class="result-list"></div>
          </div>
          <div class="panel user-detail-panel" id="user-detail">
            <div class="empty-state">
              <strong>Select a user</strong>
              <p>Their badges, server state, and management controls will appear here.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="admin-view" data-panel="audit">
        <div class="section-heading">
          <div><h2>Audit history</h2><p>The newest administrative and security events from the Render disk.</p></div>
          <button class="button ghost" id="refresh-audit">Refresh</button>
        </div>
        <div class="panel audit-panel">
          <div id="audit-list" class="audit-list"><div class="loading-card">Loading audit history…</div></div>
        </div>
      </section>
    </main>
  </div>
  <div class="toast-stack" id="toast-stack" aria-live="polite"></div>
  <dialog id="confirm-dialog">
    <form method="dialog" class="dialog-card">
      <h3 id="confirm-title">Confirm action</h3>
      <p id="confirm-copy"></p>
      <label>Reason<input id="confirm-reason" maxlength="300" placeholder="Required"></label>
      <div class="dialog-actions">
        <button class="button ghost" value="cancel">Cancel</button>
        <button class="button danger" value="confirm" id="confirm-submit">Confirm</button>
      </div>
    </form>
  </dialog>
  <script src="/assets/jadges-admin.js" defer></script>
</body>
</html>`;
}

function forbiddenPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Access denied — Jadges</title>
  <link rel="stylesheet" href="/assets/jadges-admin.css">
</head>
<body class="denied-page">
  <main class="denied-card">
    <div class="denied-icon">!</div>
    <h1>Admin access denied</h1>
    <p>Your Discord account does not currently have the required Jadges administrator role. This attempt was logged.</p>
    <a class="button primary" href="/dashboard">Return to dashboard</a>
  </main>
</body>
</html>`;
}

async function requireAdmin(
  request: IncomingMessage,
  response: ServerResponse,
  logDenied = true,
): Promise<{ actorId: string; access: AdminAccess } | undefined> {
  const actorId = sessionUserId(request);
  if (!actorId) {
    if (request.url?.startsWith("/admin")) redirect(response, "/login");
    else sendJson(response, 401, { error: "Login required" });
    return undefined;
  }

  const access = await fetchAdminAccess(actorId, true);
  if (!access.allowed) {
    if (logDenied) await logUnauthorized(request, actorId, access);
    if (request.url?.startsWith("/admin")) {
      sendHtml(response, 403, forbiddenPage());
    } else {
      sendJson(response, 403, { error: "Admin role required" });
    }
    return undefined;
  }

  return { actorId, access };
}

function verifyAdminWrite(
  request: IncomingMessage,
  actorId: string,
): string | undefined {
  if (!originIsAllowed(request)) return "Origin check failed";

  const supplied = firstHeaderValue(request.headers["x-jadges-csrf"]);
  if (!supplied || !safeEqual(supplied, csrfToken(actorId))) {
    return "Security token check failed";
  }

  if (!allowAction(actorId)) {
    return "Too many admin actions. Wait a minute and try again";
  }

  return undefined;
}

async function handleAdminPost(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actorId: string,
  access: AdminAccess,
): Promise<boolean> {
  const match = /^\/api\/admin\/users\/(\d{15,22})\/(block|remove-badge|remove-all|purge|server)$/.exec(url.pathname);
  if (!match?.[1] || !match[2]) return false;

  const targetId = match[1];
  const operation = match[2];
  const securityError = verifyAdminWrite(request, actorId);
  if (securityError) {
    sendJson(response, 403, { error: securityError });
    return true;
  }

  try {
    const body = await readJson(request) as {
      blocked?: unknown;
      badgeId?: unknown;
      action?: unknown;
      reason?: unknown;
    };
    const reason = validateReason(body.reason);
    const targetUser = await fetchDiscordUser(targetId);
    let actionLabel = "";
    let details: Record<string, unknown> | undefined;

    if (operation === "block") {
      if (typeof body.blocked !== "boolean") {
        throw new Error("Invalid blocked state");
      }
      await setBlockedState(targetId, body.blocked);
      actionLabel = body.blocked
        ? "Blocked badge submissions"
        : "Unblocked badge submissions";
      details = { blocked: body.blocked };
    } else if (operation === "remove-badge") {
      if (typeof body.badgeId !== "string" || !body.badgeId.trim()) {
        throw new Error("A badge must be selected");
      }
      const removed = await removeSelectedBadge(targetId, body.badgeId.trim());
      actionLabel = "Removed one badge";
      details = { badgeId: removed.id, badgeName: removed.name };
    } else if (operation === "remove-all") {
      details = await removeAllBadges(targetId);
      actionLabel = "Removed all Jadges badges";
    } else if (operation === "purge") {
      details = await purgeUserRecord(targetId);
      actionLabel = "Purged complete Jadges user record";
    } else {
      if (
        body.action !== "kick"
        && body.action !== "ban"
        && body.action !== "unban"
      ) {
        throw new Error("Invalid server action");
      }
      if (targetId === actorId && body.action !== "unban") {
        throw new Error("You cannot kick or ban your own admin account");
      }
      await discordServerAction(body.action, targetId, reason);
      actionLabel = `${body.action[0]?.toUpperCase() || ""}${body.action.slice(1)} user in Discord`;
      details = { serverAction: body.action };
    }

    accessCache.delete(targetId);
    await recordAdminAction(
      request,
      actorId,
      access,
      actionLabel,
      targetId,
      targetUser,
      reason,
      details,
    );

    sendJson(response, 200, {
      ok: true,
      action: actionLabel,
      user: await userDetails(targetId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin action failed";
    sendJson(
      response,
      message.includes("not found") ? 404 : 400,
      { error: message },
    );
  }

  return true;
}

export async function handleAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (
    url.pathname === "/assets/jadges-admin.css"
    || url.pathname === "/assets/jadges-admin.js"
  ) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    await serveAsset(
      response,
      url.pathname.endsWith(".css")
        ? "jadges-admin.css"
        : "jadges-admin.js",
    );
    return true;
  }

  if (url.pathname === "/api/admin/access") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const actorId = sessionUserId(request);
    if (!actorId) {
      sendJson(response, 200, { allowed: false, loggedIn: false });
      return true;
    }
    const access = await fetchAdminAccess(actorId);
    sendJson(response, 200, {
      allowed: access.allowed,
      loggedIn: true,
      inGuild: access.inGuild,
    });
    return true;
  }

  const isAdminRoute =
    url.pathname === "/admin"
    || url.pathname.startsWith("/api/admin/");
  if (!isAdminRoute) return false;

  const authorized = await requireAdmin(request, response);
  if (!authorized) return true;
  const { actorId, access } = authorized;

  if (url.pathname === "/admin") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const actor = access.member?.user || await fetchDiscordUser(actorId);
    sendHtml(response, 200, adminPage(actorId, actor, access.member));
    return true;
  }

  if (url.pathname === "/api/admin/stats") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    sendJson(response, 200, await adminStats());
    return true;
  }

  if (url.pathname === "/api/admin/audit") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    sendJson(response, 200, { events: await recentAudit(50) });
    return true;
  }

  if (url.pathname === "/api/admin/users") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const query = url.searchParams.get("q") || "";
      sendJson(response, 200, { users: await searchUsers(query) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "User search failed",
      });
    }
    return true;
  }

  const detailsMatch = /^\/api\/admin\/users\/(\d{15,22})$/.exec(url.pathname);
  if (detailsMatch?.[1]) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      sendJson(response, 200, await userDetails(detailsMatch[1]));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not load user",
      });
    }
    return true;
  }

  if (request.method === "POST") {
    if (await handleAdminPost(
      request,
      response,
      url,
      actorId,
      access,
    )) {
      return true;
    }
  }

  sendJson(response, 404, { error: "Admin route not found" });
  return true;
}
