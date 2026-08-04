import http, { type RequestListener, type ServerResponse } from "node:http";

const MOBILE_APPEARANCE_SCRIPT = String.raw`
(() => {
  function openAppearanceEditor(event) {
    const target = event.target instanceof Element
      ? event.target.closest('.mobile-dashboard-nav a[href="/dashboard#appearance"]')
      : null;
    if (!target) return;

    event.preventDefault();
    const desktopAppearance = document.querySelector('.sidebar .nav-link[href="#appearance"]');
    if (desktopAppearance instanceof HTMLElement) {
      desktopAppearance.click();
      return;
    }

    window.location.hash = "appearance";
  }

  document.addEventListener("click", openAppearanceEditor);
})();
`;

let installed = false;

function serveScript(response: ServerResponse): void {
  const content = Buffer.from(MOBILE_APPEARANCE_SCRIPT, "utf8");
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": String(content.length),
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function injectScript(html: string): string {
  if (!html.includes('class="dashboard-body"') || html.includes("/assets/mobile-appearance.js")) {
    return html;
  }
  return html.replace(
    "</body>",
    '<script src="/assets/mobile-appearance.js" defer></script></body>',
  );
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    if (request.method === "GET" && url.pathname === "/assets/mobile-appearance.js") {
      serveScript(response);
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/dashboard") {
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
      const html = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
      originalEnd(injectScript(html), "utf8", callback);
      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

export function installMobileAppearanceIntegration(): void {
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
