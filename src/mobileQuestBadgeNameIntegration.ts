import http, { type RequestListener, type ServerResponse } from "node:http";

let installed = false;
const COMPLETION_KEY = "custom:quest:completed-any";

function isMobileRequest(userAgent: string | undefined): boolean {
  return /android|iphone|ipad|ipod|discord-mobile|revenge|kettu/i.test(userAgent || "");
}

function transform(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, Array<Record<string, unknown>>>;
    for (const badges of Object.values(parsed)) {
      if (!Array.isArray(badges)) continue;
      for (const badge of badges) {
        if (badge?.key !== COMPLETION_KEY) continue;
        badge.name = "Completed a Quest";
        badge.tooltip = "Completed a Quest";
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    if (
      request.method !== "GET"
      || url.pathname !== "/badges.json"
      || !isMobileRequest(request.headers["user-agent"])
    ) {
      listener(request, response);
      return;
    }

    const chunks: Buffer[] = [];
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    response.write = ((chunk: any, encoding?: any, callback?: any): boolean => {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof callback === "function") callback();
      return true;
    }) as typeof response.write;
    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const original = Buffer.concat(chunks).toString("utf8");
      const changed = transform(original);
      response.removeHeader("content-length");
      originalWrite(changed, "utf8");
      originalEnd(undefined, undefined, callback);
      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

export function installMobileQuestBadgeNameIntegration(): void {
  if (installed) return;
  installed = true;
  const mutable = http as typeof http & { createServer: (...args: any[]) => http.Server };
  const original = mutable.createServer.bind(http) as (...args: any[]) => http.Server;
  mutable.createServer = ((...args: any[]): http.Server => {
    const listenerIndex = typeof args[0] === "function" ? 0 : typeof args[1] === "function" ? 1 : -1;
    if (listenerIndex !== -1) args[listenerIndex] = wrap(args[listenerIndex] as RequestListener);
    return original(...args);
  }) as typeof http.createServer;
}
