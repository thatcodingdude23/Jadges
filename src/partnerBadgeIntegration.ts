import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http, {
  type RequestListener,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { config } from "./config.js";

const PARTNER_ROLE_ID = "1531693452314808461";
const PARTNER_BADGE_KEY = "partner";
const PARTNER_BADGE_NAME = "Jaycord Partner";
const PARTNER_BADGE_PATH = "/assets/jaycord-partner.webp";
const PARTNER_BADGE_URL = new URL(PARTNER_BADGE_PATH, config.publicUrl).toString();
const PARTNER_BADGE_SOURCE_URL =
  "https://media.discordapp.net/attachments/1472616427956604940/1533434306192609390/3f9748e53446a137a052f3454e2de41e-1.png?ex=6a70797c&is=6a6f27fc&hm=f48f2286cc754ac225a73bffbd0d29c255f737874686ddadd17c49b0ec000fd4&=&format=webp&quality=lossless";
const PARTNER_BADGE_CACHE_FILE = path.join(config.dataDir, "jaycord-partner.webp");
const PARTNER_SYNC_INTERVAL_MS = 60_000;

let installed = false;
let partnerUserIds = new Set<string>();
let lastPartnerSyncAt = 0;
let partnerSyncPromise: Promise<void> | undefined;
let partnerBadgeAsset: Buffer | undefined;
let partnerBadgeAssetPromise: Promise<Buffer> | undefined;

interface BadgeLike {
  key?: unknown;
  side?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFileError(error: unknown): boolean {
  return isObjectRecord(error) && error.code === "ENOENT";
}

async function downloadAndCachePartnerBadge(): Promise<Buffer> {
  const response = await fetch(PARTNER_BADGE_SOURCE_URL, {
    headers: {
      "user-agent": "Jadges/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Partner badge image download returned HTTP ${response.status}${
        details ? `: ${details.slice(0, 300)}` : ""
      }`,
    );
  }

  const image = Buffer.from(await response.arrayBuffer());
  if (image.length === 0) {
    throw new Error("Partner badge image download returned an empty file");
  }

  await mkdir(config.dataDir, { recursive: true });
  const temporaryFile = `${PARTNER_BADGE_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryFile, image);
  await rename(temporaryFile, PARTNER_BADGE_CACHE_FILE);

  console.log(`Cached the Jaycord Partner badge at ${PARTNER_BADGE_CACHE_FILE}.`);
  return image;
}

async function loadPartnerBadgeAsset(): Promise<Buffer> {
  if (partnerBadgeAsset) return partnerBadgeAsset;

  try {
    partnerBadgeAsset = await readFile(PARTNER_BADGE_CACHE_FILE);
    return partnerBadgeAsset;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  if (!partnerBadgeAssetPromise) {
    partnerBadgeAssetPromise = downloadAndCachePartnerBadge()
      .then((image) => {
        partnerBadgeAsset = image;
        return image;
      })
      .finally(() => {
        partnerBadgeAssetPromise = undefined;
      });
  }

  return partnerBadgeAssetPromise;
}

async function servePartnerBadge(
  requestMethod: string | undefined,
  response: ServerResponse,
): Promise<void> {
  try {
    const image = await loadPartnerBadgeAsset();
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(image.byteLength),
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
    });
    response.end(requestMethod === "HEAD" ? undefined : image);
  } catch (error) {
    console.error("Could not serve the Jaycord Partner badge image:", error);
    response.writeHead(503, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("Jaycord Partner badge image is temporarily unavailable.");
  }
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

    if (
      (request.method === "GET" || request.method === "HEAD")
      && url.pathname === PARTNER_BADGE_PATH
    ) {
      void servePartnerBadge(request.method, response);
      return;
    }

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

      if (
        chunk === undefined ||
        response.statusCode < 200 ||
        response.statusCode >= 300
      ) {
        originalEnd(chunk, encoding, callback);
        return response;
      }

      const body = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);

      void transformJsonBody(url.pathname, body)
        .then((transformed) => {
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

  void loadPartnerBadgeAsset().catch((error) => {
    console.error("Could not cache the Jaycord Partner badge image:", error);
  });
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
