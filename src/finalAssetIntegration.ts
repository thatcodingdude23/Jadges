import { readFile } from "node:fs/promises";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";

const LOGO_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 54' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='j' x1='10' y1='7' x2='36' y2='48' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%23b89cff'/%3E%3Cstop offset='.5' stop-color='%237c4dff'/%3E%3Cstop offset='1' stop-color='%235b8cff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M31 8v27.5C31 43 26.7 47 20.2 47c-5.4 0-9.2-2.8-10.7-7.6' stroke='url(%23j)' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const BRAND_CSS = `
.logo-mark {
  width: 34px;
  height: 38px;
  background-image: url("${LOGO_DATA_URI}");
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
  filter: drop-shadow(0 8px 18px rgba(124, 77, 255, 0.3));
}
.logo-mark > * { display: none !important; }
`;

let installed = false;
let css: Buffer | undefined;
let javascript: Buffer | undefined;

async function combinedCss(): Promise<Buffer> {
  if (css) return css;
  const [base, appearance, visibility, deletion, categories, clientAuth] = await Promise.all([
    readFile(new URL("../web/jadges.css", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-theme.css", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-visibility.css", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-delete.css", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-categories.css", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-client-auth.css", import.meta.url), "utf8"),
  ]);
  css = Buffer.from(
    `${base}\n${BRAND_CSS}\n${appearance}\n${visibility}\n${deletion}\n${categories}\n${clientAuth}`,
    "utf8",
  );
  return css;
}

async function combinedJavascript(): Promise<Buffer> {
  if (javascript) return javascript;
  const [dashboard, appearance, preview, visibility, deletion, clientAuth] = await Promise.all([
    readFile(new URL("../web/jadges.js", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-theme.js", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-preview.js", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-visibility.js", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-delete.js", import.meta.url), "utf8"),
    readFile(new URL("../web/jadges-client-auth.js", import.meta.url), "utf8"),
  ]);
  javascript = Buffer.from(
    `${dashboard}\n${appearance}\n${preview}\n${visibility}\n${deletion}\n${clientAuth}`,
    "utf8",
  );
  return javascript;
}

async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", "https://jadges.local");
  const isCss = url.pathname === "/assets/jadges.css";
  const isJs = url.pathname === "/assets/jadges.js";
  if (!isCss && !isJs) return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  const content = isCss ? await combinedCss() : await combinedJavascript();
  response.writeHead(200, {
    "content-type": isCss
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8",
    "content-length": content.length,
    "cache-control": "public, max-age=300, must-revalidate",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void serveAsset(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges final asset integration error:", error);
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ error: "Could not load Jadges assets" }));
        }
      });
  };
}

export function installFinalAssetIntegration(): void {
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
