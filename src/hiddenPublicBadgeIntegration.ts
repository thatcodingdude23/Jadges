import http, {
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { readStore } from "./store.js";
import type { UserRecord } from "./types.js";

interface VisibilityUser extends UserRecord {
  hiddenBadgeKeys?: string[];
}

interface PublicBadgeLike {
  key?: unknown;
  metadata?: unknown;
}

let installed = false;

function hiddenCustomKeys(user: UserRecord | undefined): Set<string> {
  const values = (user as VisibilityUser | undefined)?.hiddenBadgeKeys;
  if (!Array.isArray(values)) return new Set();

  return new Set(
    values.filter(
      (key): key is string =>
        typeof key === "string" && /^custom:[a-z0-9-]{1,100}$/i.test(key),
    ),
  );
}

async function filterHiddenCustomBadges(body: string): Promise<string> {
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;

  const store = await readStore();
  const result = parsed as Record<string, unknown>;

  for (const [userId, value] of Object.entries(result)) {
    if (!Array.isArray(value)) continue;
    const hidden = hiddenCustomKeys(store.users[userId]);
    if (hidden.size === 0) continue;

    result[userId] = value.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const badge = item as PublicBadgeLike;
      if (badge.metadata === true || typeof badge.key !== "string") return true;
      return !hidden.has(badge.key);
    });
  }

  return JSON.stringify(result);
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    if (url.pathname !== "/badges.json") {
      listener(request, response);
      return;
    }

    const originalEnd = response.end.bind(response);
    let ended = false;

    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (ended) return response;
      ended = true;

      if (
        chunk === undefined
        || response.statusCode < 200
        || response.statusCode >= 300
        || !String(response.getHeader("content-type") || "").includes("application/json")
      ) {
        originalEnd(chunk, encoding, callback);
        return response;
      }

      const body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      void filterHiddenCustomBadges(body)
        .then((filtered) => {
          response.removeHeader("content-length");
          originalEnd(filtered, "utf8", callback);
        })
        .catch((error) => {
          console.error("Jadges hidden public badge integration error:", error);
          originalEnd(chunk, encoding, callback);
        });

      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

export function installHiddenPublicBadgeIntegration(): void {
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
