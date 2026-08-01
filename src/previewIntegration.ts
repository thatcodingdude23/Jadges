import { readFile } from "node:fs/promises";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";

let installed = false;
let combinedJavascript: Buffer | undefined;

async function servePreviewJavascript(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", "https://jadges.local");
  if (url.pathname !== "/assets/jadges.js") return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  if (!combinedJavascript) {
    const [dashboard, appearance, preview] = await Promise.all([
      readFile(new URL("../web/jadges.js", import.meta.url), "utf8"),
      readFile(new URL("../web/jadges-theme.js", import.meta.url), "utf8"),
      readFile(new URL("../web/jadges-preview.js", import.meta.url), "utf8"),
    ]);
    combinedJavascript = Buffer.from(
      `${dashboard}\n${appearance}\n${preview}`,
      "utf8",
    );
  }

  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": combinedJavascript.length,
    "cache-control": "public, max-age=300, must-revalidate",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(combinedJavascript);
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void servePreviewJavascript(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges preview integration error:", error);
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ error: "Could not load the Jadges website" }));
        }
      });
  };
}

export function installPreviewIntegration(): void {
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
