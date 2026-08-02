import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { isBotOnlyNativeBadgeName } from "./nativeStore.js";
import { readStore } from "./store.js";
import type { NitroPreset, UserRecord } from "./types.js";

interface VisibilityUser extends UserRecord {
  hiddenBadgeKeys?: string[];
  profileVisibleBadgeKeys?: string[];
  profileVisibilityReportedAt?: string;
}

interface DashboardBadgeLike {
  key: string;
  name: string;
  image: string;
  movable: boolean;
  subtitle: string;
}

interface DashboardDataLike {
  profile?: { id?: string };
  badges?: DashboardBadgeLike[];
  order?: string[];
  hidden?: string[];
  profileVisibilityReportedAt?: string;
  hasNativeBadges?: boolean;
  stats?: {
    totalBadges?: number;
    nativeBadges?: number;
    pendingReviews?: number;
    pluginVersion?: number;
  };
}

const VALID_BADGE_KEY = /^(?:staff|nitro|custom:[a-z0-9-]{1,100}|discord:[a-z0-9._:-]{1,180})$/i;
let installed = false;

function normalizedKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((key): key is string => typeof key === "string")
      .map((key) => key.trim())
      .filter((key) => VALID_BADGE_KEY.test(key)),
  )].slice(0, 100);
}

function legacyNitroPreset(user: UserRecord): NitroPreset | undefined {
  let selected: UserRecord["badges"][number] | undefined;

  for (const badge of user.badges || []) {
    if (badge.pending || !badge.nitroPreset) continue;
    const selectedTime = Date.parse(selected?.approvedAt || selected?.createdAt || "");
    const badgeTime = Date.parse(badge.approvedAt || badge.createdAt || "");
    if (!selected || !Number.isFinite(selectedTime) || badgeTime >= selectedTime) {
      selected = badge;
    }
  }

  return selected?.nitroPreset;
}

function activeNitroPreset(user: UserRecord): NitroPreset | undefined {
  if (user.nitro && !user.nitro.pending) return user.nitro.preset;
  return legacyNitroPreset(user);
}

function detectedHiddenKeys(
  user: VisibilityUser,
  badges: DashboardBadgeLike[],
): string[] {
  const hidden = new Set(normalizedKeys(user.hiddenBadgeKeys));
  const hasLiveReport = Array.isArray(user.profileVisibleBadgeKeys)
    && typeof user.profileVisibilityReportedAt === "string";

  if (hasLiveReport) {
    const visible = new Set(normalizedKeys(user.profileVisibleBadgeKeys));
    for (const badge of badges) {
      if (!visible.has(badge.key)) hidden.add(badge.key);
    }
  } else {
    const preset = activeNitroPreset(user);
    if (preset) hidden.add("discord:nitro");
    if (preset === "remove") hidden.add("discord:boosting");
  }

  return [...hidden];
}

function isDashboardData(value: unknown): value is DashboardDataLike {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && typeof (value as DashboardDataLike).profile?.id === "string",
  );
}

function isBotOnlyDashboardBadge(badge: DashboardBadgeLike): boolean {
  return badge.key.startsWith("discord:")
    && isBotOnlyNativeBadgeName(badge.name);
}

async function enrichDashboardData(value: unknown): Promise<unknown> {
  if (!isDashboardData(value)) return value;
  const userId = value.profile?.id;
  if (!userId) return value;

  const store = await readStore();
  const user = store.users[userId] as VisibilityUser | undefined;
  if (!user) return value;

  const badges = (Array.isArray(value.badges) ? [...value.badges] : [])
    .filter((badge) => !isBotOnlyDashboardBadge(badge));
  const badgeKeys = new Set(badges.map((badge) => badge.key));

  // Keep every real account badge in the editor, including ones currently
  // hidden on the profile. Bot/application badges are intentionally excluded.
  for (const badge of user.nativeBadges || []) {
    if (isBotOnlyNativeBadgeName(badge.name) || badgeKeys.has(badge.key)) continue;
    badges.push({
      key: badge.key,
      name: badge.name,
      image: badge.image,
      movable: true,
      subtitle: "Native Discord badge",
    });
    badgeKeys.add(badge.key);
  }

  const movableKeys = badges
    .filter((badge) => badge.movable)
    .map((badge) => badge.key);
  const movableSet = new Set(movableKeys);
  const preferredOrder = Array.isArray(user.badgeOrder) ? user.badgeOrder : [];
  const order = [
    ...preferredOrder.filter((key) => movableSet.has(key)),
    ...movableKeys.filter((key) => !preferredOrder.includes(key)),
  ];
  const nativeCount = badges.filter((badge) => badge.key.startsWith("discord:")).length;

  return {
    ...value,
    badges,
    order,
    hidden: detectedHiddenKeys(user, badges),
    profileVisibilityReportedAt: user.profileVisibilityReportedAt,
    hasNativeBadges: nativeCount > 0,
    stats: {
      ...(value.stats || {}),
      totalBadges: badges.length,
      nativeBadges: nativeCount,
    },
  } satisfies DashboardDataLike;
}

async function transformBody(
  pathname: string,
  contentType: string,
  body: string,
): Promise<string> {
  if (pathname === "/api/dashboard" && contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return JSON.stringify(await enrichDashboardData(parsed));
    } catch {
      return body;
    }
  }

  if (pathname === "/dashboard" && contentType.includes("text/html")) {
    const pattern = /<script id="jadges-data" type="application\/json">([\s\S]*?)<\/script>/;
    const match = body.match(pattern);
    if (!match?.[1]) return body;

    try {
      const parsed = JSON.parse(match[1]) as unknown;
      const enriched = await enrichDashboardData(parsed);
      const serialized = JSON.stringify(enriched).replaceAll("<", "\\u003c");
      return body.replace(pattern, `<script id="jadges-data" type="application/json">${serialized}</script>`);
    } catch {
      return body;
    }
  }

  return body;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    const shouldTransform = url.pathname === "/dashboard"
      || url.pathname === "/api/dashboard";

    if (!shouldTransform) {
      listener(request, response);
      return;
    }

    const originalEnd = response.end.bind(response);
    let ended = false;

    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (ended) return response;
      ended = true;

      if (chunk === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        originalEnd(chunk, encoding, callback);
        return response;
      }

      const body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const contentType = String(response.getHeader("content-type") || "");

      void transformBody(url.pathname, contentType, body)
        .then((transformed) => {
          response.removeHeader("content-length");
          originalEnd(transformed, "utf8", callback);
        })
        .catch((error) => {
          console.error("Jadges hidden dashboard integration error:", error);
          originalEnd(chunk, encoding, callback);
        });

      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

export function installHiddenDashboardIntegration(): void {
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
