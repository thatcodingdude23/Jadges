import http, { type RequestListener } from "node:http";
import { COMPLETED_QUEST_BADGE_PNG_BASE64 } from "./questCompletionAsset.js";

const QUEST_BADGE_PATH = "/badges/10000000-0000-4000-8000-000000000099.png";
const QUEST_BADGE_BYTES = Buffer.from(COMPLETED_QUEST_BADGE_PNG_BASE64, "base64");
let installed = false;

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    if (request.method === "GET" && url.pathname === QUEST_BADGE_PATH) {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(QUEST_BADGE_BYTES.length),
        "cache-control": "public, max-age=86400, immutable",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      });
      response.end(QUEST_BADGE_BYTES);
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
