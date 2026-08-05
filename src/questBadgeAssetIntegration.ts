import http, { type RequestListener } from "node:http";
import { COMPLETED_QUEST_BADGE_PNG_BASE64 } from "./questCompletionAsset.js";

const QUEST_BADGE_PATH = "/badges/10000000-0000-4000-8000-000000000099.png";
const QUEST_BADGE_URL = "https://cdn3.emoji.gg/emojis/66366-completed-a-quest.png";
const FALLBACK_BYTES = Buffer.from(COMPLETED_QUEST_BADGE_PNG_BASE64, "base64");
let installed = false;
let cachedBytes: Buffer | undefined;
let downloadPromise: Promise<Buffer> | undefined;

async function questBadgeBytes(): Promise<Buffer> {
  if (cachedBytes) return cachedBytes;
  if (!downloadPromise) {
    downloadPromise = fetch(QUEST_BADGE_URL, {
      headers: {
        accept: "image/png,image/*;q=0.8",
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (remote) => {
        if (!remote.ok) {
          throw new Error(`Emoji.gg returned HTTP ${remote.status}`);
        }
        const bytes = Buffer.from(await remote.arrayBuffer());
        if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
          throw new Error("Emoji.gg returned an invalid image size");
        }
        cachedBytes = bytes;
        return bytes;
      })
      .catch((error) => {
        console.error("Could not download the Jadges Quests icon; using bundled fallback:", error);
        cachedBytes = FALLBACK_BYTES;
        return FALLBACK_BYTES;
      })
      .finally(() => {
        downloadPromise = undefined;
      });
  }
  return downloadPromise;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    if (request.method === "GET" && url.pathname === QUEST_BADGE_PATH) {
      void questBadgeBytes()
        .then((bytes) => {
          response.writeHead(200, {
            "content-type": "image/png",
            "content-length": String(bytes.length),
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
            "cross-origin-resource-policy": "cross-origin",
            "x-content-type-options": "nosniff",
          });
          response.end(bytes);
        })
        .catch((error) => {
          console.error("Could not serve the Jadges Quests icon:", error);
          response.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
          });
          response.end(JSON.stringify({ error: "Could not serve quest badge icon" }));
        });
      return;
    }

    listener(request, response);
  };
}

export function installQuestBadgeAssetIntegration(): void {
  if (installed) return;
  installed = true;

  const mutable = http as typeof http & { createServer: (...args: any[]) => http.Server };
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
