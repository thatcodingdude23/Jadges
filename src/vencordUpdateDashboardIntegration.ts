import http, { type RequestListener, type ServerResponse } from "node:http";

const UPDATE_VERSION = 39;
let installed = false;

function sendManifest(response: ServerResponse): void {
  const body = JSON.stringify({ version: UPDATE_VERSION });
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store, no-cache, must-revalidate",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function injectDashboardLink(response: ServerResponse): void {
  const originalEnd = response.end.bind(response);
  let ended = false;
  response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
    if (ended) return response;
    ended = true;
    if (chunk === undefined || response.statusCode < 200 || response.statusCode >= 300) {
      originalEnd(chunk, encoding, callback);
      return response;
    }
    const body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
    if (body.includes('href="/custom-profile"')) {
      originalEnd(body, "utf8", callback);
      return response;
    }
    const marker = `</nav>\n      <div class="sidebar-spacer">`;
    const link = `<a class="nav-link" href="/custom-profile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.7-4.3 3.4-7 8-7s7.3 2.7 8 7"/><path d="m17.5 5.5 1-1 2 2-1 1"/></svg>Custom Profile</a>\n      </nav>\n      <div class="sidebar-spacer">`;
    originalEnd(body.includes(marker) ? body.replace(marker, link) : body, "utf8", callback);
    return response;
  }) as typeof response.end;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.onrender.com");
    if (request.method === "GET" && url.pathname === "/vencord-update.json") {
      sendManifest(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard") injectDashboardLink(response);
    listener(request, response);
  };
}

export function installVencordUpdateDashboardIntegration(): void {
  if (installed) return;
  installed = true;
  const mutable = http as typeof http & { createServer: (...args: any[]) => http.Server };
  const original = mutable.createServer.bind(http) as (...args: any[]) => http.Server;
  mutable.createServer = ((...args: any[]): http.Server => {
    const index = typeof args[0] === "function" ? 0 : typeof args[1] === "function" ? 1 : -1;
    if (index !== -1) args[index] = wrap(args[index] as RequestListener);
    return original(...args);
  }) as typeof http.createServer;
}
