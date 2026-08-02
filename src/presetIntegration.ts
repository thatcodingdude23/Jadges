import http, { type RequestListener, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { presetCssAsset, presetJsAsset } from "./presetAssetsSmall.js";
import { handlePresetRequest } from "./presetMarketplace.js";

let installed = false;

function serveAsset(response: ServerResponse, kind: "css" | "js"): void {
  const content = kind === "css" ? presetCssAsset : presetJsAsset;
  response.writeHead(200, {
    "content-type": kind === "css"
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8",
    "content-length": String(content.length),
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function addPresetsNavigation(html: string, pathname: string): string {
  if (!html.includes('/assets/presets.css')) {
    html = html.replace(
      "</head>",
      '<link rel="stylesheet" href="/assets/presets.css"></head>',
    );
  }

  const link = '<a class="secondary-button presets-topbar-link" href="/presets">Presets</a>';
  if (html.includes('href="/presets"')) return html;

  if (pathname === "/") {
    return html.replace('<div class="landing-actions">', `<div class="landing-actions">${link}`);
  }

  if (pathname === "/dashboard") {
    return html.replace('<div class="account-menu">', `${link}<div class="account-menu">`);
  }

  return html;
}

function wrapHtmlNavigation(
  listener: RequestListener,
  pathname: string,
): RequestListener {
  return (request, response) => {
    const originalEnd = response.end.bind(response);
    let ended = false;

    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (ended) return response;
      ended = true;

      if (
        chunk === undefined
        || response.statusCode < 200
        || response.statusCode >= 300
      ) {
        originalEnd(chunk, encoding, callback);
        return response;
      }

      const body = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
      const transformed = addPresetsNavigation(body, pathname);
      originalEnd(transformed, "utf8", callback);
      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");

    if (request.method === "GET" && url.pathname === "/assets/presets.css") {
      serveAsset(response, "css");
      return;
    }
    if (request.method === "GET" && url.pathname === "/assets/presets.js") {
      serveAsset(response, "js");
      return;
    }

    void handlePresetRequest(request, response, url, config.publicUrl)
      .then((handled) => {
        if (handled) return;
        if (
          request.method === "GET"
          && (url.pathname === "/" || url.pathname === "/dashboard")
        ) {
          wrapHtmlNavigation(listener, url.pathname)(request, response);
          return;
        }
        listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges Presets integration error:", error);
        if (!response.headersSent) {
          response.writeHead(500, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
        }
        if (!response.writableEnded) response.end("Could not load Jadges Presets.");
      });
  };
}

export function installPresetMarketplaceIntegration(): void {
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
