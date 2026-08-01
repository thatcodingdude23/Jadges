import { readFile } from "node:fs/promises";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 54" fill="none">
  <defs>
    <linearGradient id="j" x1="10" y1="7" x2="36" y2="48" gradientUnits="userSpaceOnUse">
      <stop stop-color="#b89cff"/>
      <stop offset=".5" stop-color="#7c4dff"/>
      <stop offset="1" stop-color="#5b8cff"/>
    </linearGradient>
  </defs>
  <path d="M31 8v27.5C31 43 26.7 47 20.2 47c-5.4 0-9.2-2.8-10.7-7.6" stroke="url(#j)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const LOGO_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 54' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='j' x1='10' y1='7' x2='36' y2='48' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%23b89cff'/%3E%3Cstop offset='.5' stop-color='%237c4dff'/%3E%3Cstop offset='1' stop-color='%235b8cff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M31 8v27.5C31 43 26.7 47 20.2 47c-5.4 0-9.2-2.8-10.7-7.6' stroke='url(%23j)' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const BRAND_CSS = `

/* Jadges outlined J branding */
.logo-mark {
  width: 34px;
  height: 38px;
  background-image: url("${LOGO_DATA_URI}");
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
  filter: drop-shadow(0 8px 18px rgba(124, 77, 255, 0.3));
}

.logo-mark > * {
  display: none !important;
}
`;

let installed = false;
let brandedCss: Buffer | undefined;

function send(
  request: IncomingMessage,
  response: ServerResponse,
  contentType: string,
  body: Buffer,
): void {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "public, max-age=300, must-revalidate",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

async function serveBrandAsset(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const url = new URL(request.url || "/", "http://localhost");

  if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
    send(
      request,
      response,
      "image/svg+xml; charset=utf-8",
      Buffer.from(FAVICON_SVG, "utf8"),
    );
    return true;
  }

  if (url.pathname === "/assets/jadges.css") {
    if (!brandedCss) {
      const original = await readFile(new URL("../web/jadges.css", import.meta.url), "utf8");
      brandedCss = Buffer.from(`${original}${BRAND_CSS}`, "utf8");
    }
    send(request, response, "text/css; charset=utf-8", brandedCss);
    return true;
  }

  return false;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void serveBrandAsset(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges brand asset error:", error);
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Could not load Jadges branding");
        }
      });
  };
}

export function installBrandIntegration(): void {
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
