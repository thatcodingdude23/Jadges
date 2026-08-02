import http, {
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { config } from "./config.js";

const PARTNER_ROLE_ID = "1531693452314808461";
const PARTNER_BADGE_KEY = "partner";
const PARTNER_BADGE_NAME = "Jaycord Partner";
const PARTNER_BADGE_URL =
  "https://cdn.discordapp.com/emojis/846569337119703092.webp?size=40";
const PARTNER_SYNC_INTERVAL_MS = 60_000;

let installed = false;
let partnerUserIds = new Set<string>();
let lastPartnerSyncAt = 0;
let partnerSyncPromise: Promise<void> | undefined;

interface BadgeLike {
  key?: unknown;
  side?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function refreshPartnerMembers(): Promise<void> {
  if (!config.guildId) {
    if (lastPartnerSyncAt === 0) {
      console.warn(
        "GUILD_ID is not configured, so the automatic Jaycord Partner badge cannot sync.",
      );
    }
    lastPartnerSyncAt = Date.now();
    return;
  }

  const nextPartnerUserIds = new Set<string>();
  let after: string | undefined;

  while (true) {
    const endpoint = new URL(
      `https://discord.com/api/v10/guilds/${config.guildId}/members`,
    );
    endpoint.searchParams.set("limit", "1000");
    if (after) endpoint.searchParams.set("after", after);

    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bot ${config.discordToken}`,
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Discord partner-role sync returned HTTP ${response.status}${
          details ? `: ${details.slice(0, 500)}` : ""
        }`,
      );
    }

    const members = await response.json() as Array<{
      user?: { id?: string };
      roles?: string[];
    }>;

    if (!Array.isArray(members)) {
      throw new TypeError("Discord partner-role sync returned invalid data");
    }

    for (const member of members) {
      const userId = member.user?.id;
      if (
        userId &&
        Array.isArray(member.roles) &&
        member.roles.includes(PARTNER_ROLE_ID)
      ) {
        nextPartnerUserIds.add(userId);
      }
    }

    if (members.length < 1000) break;

    const finalUserId = members.at(-1)?.user?.id;
    if (!finalUserId || finalUserId === after) break;
    after = finalUserId;
  }

  partnerUserIds = nextPartnerUserIds;
  lastPartnerSyncAt = Date.now();
  console.log(
    `Synced ${partnerUserIds.size} Jaycord Partner role holder${
      partnerUserIds.size === 1 ? "" : "s"
    }.`,
  );
}

async function ensurePartnerMembersFresh(): Promise<void> {
  if (Date.now() - lastPartnerSyncAt < PARTNER_SYNC_INTERVAL_MS) return;

  if (!partnerSyncPromise) {
    partnerSyncPromise = refreshPartnerMembers()
      .catch((error) => {
        console.error("Could not sync the Jaycord Partner role:", error);
      })
      .finally(() => {
        partnerSyncPromise = undefined;
      });
  }

  await partnerSyncPromise;
}

function partnerBadgeFor(badges: unknown[]): BadgeLike {
  const settings = badges.find((badge) =>
    isObjectRecord(badge) && badge.metadata === true
  ) as BadgeLike | undefined;
  const firstSide = badges.find((badge) =>
    isObjectRecord(badge) && (badge.side === "left" || badge.side === "right")
  ) as BadgeLike | undefined;
  const side = settings?.side === "left" || settings?.side === "right"
    ? settings.side
    : firstSide?.side === "left" || firstSide?.side === "right"
      ? firstSide.side
      : undefined;

  return {
    key: PARTNER_BADGE_KEY,
    name: PARTNER_BADGE_NAME,
    tooltip: PARTNER_BADGE_NAME,
    badge: PARTNER_BADGE_URL,
    pending: false,
    ...(side ? { side } : {}),
  };
}

function withPartnerBadge(userId: string, value: unknown): unknown[] {
  const badges = Array.isArray(value) ? [...value] : [];
  const cleaned = badges.filter((badge) =>
    !isObjectRecord(badge) || badge.key !== PARTNER_BADGE_KEY
  );

  if (!partnerUserIds.has(userId)) return cleaned;

  const staffIndex = cleaned.findIndex((badge) =>
    isObjectRecord(badge) && badge.key === "staff"
  );
  cleaned.splice(
    staffIndex >= 0 ? staffIndex + 1 : 0,
    0,
    partnerBadgeFor(cleaned),
  );
  return cleaned;
}

async function transformJsonBody(pathname: string, body: string): Promise<string> {
  await ensurePartnerMembersFresh();

  if (pathname === "/badges.json") {
    const parsed = JSON.parse(body) as unknown;
    if (!isObjectRecord(parsed)) return body;

    for (const userId of partnerUserIds) {
      parsed[userId] = withPartnerBadge(userId, parsed[userId]);
    }
    return JSON.stringify(parsed);
  }

  const userMatch = /^\/users\/(\d{15,22})$/.exec(pathname);
  if (!userMatch?.[1]) return body;

  const parsed = JSON.parse(body) as unknown;
  return JSON.stringify(withPartnerBadge(userMatch[1], parsed));
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    const shouldTransform = request.method === "GET"
      && (url.pathname === "/badges.json" || /^\/users\/\d{15,22}$/.test(url.pathname));

    if (!shouldTransform) {
      listener(request, response);
      return;
    }

    const originalEnd = response.end.bind(response);
    let ended = false;

    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (ended) return response;
      ended = true;

      const contentType = String(response.getHeader("content-type") || "");
      if (
        chunk === undefined ||
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !contentType.includes("application/json")
      ) {
        originalEnd(chunk, encoding, callback);
        return response;
      }

      const body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      void transformJsonBody(url.pathname, body)
        .then((transformed) => {
          response.removeHeader("content-length");
          originalEnd(transformed, "utf8", callback);
        })
        .catch((error) => {
          console.error("Jadges Partner badge integration error:", error);
          originalEnd(chunk, encoding, callback);
        });

      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

export function installPartnerBadgeIntegration(): void {
  if (installed) return;
  installed = true;

  void ensurePartnerMembersFresh();
  const timer = setInterval(() => {
    void ensurePartnerMembersFresh();
  }, PARTNER_SYNC_INTERVAL_MS);
  timer.unref();

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
