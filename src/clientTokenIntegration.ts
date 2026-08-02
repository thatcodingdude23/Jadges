import { createHmac, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import {
  getClientTokenStatus,
  issueClientToken,
  revokeClientToken,
} from "./clientAuth.js";
import { config } from "./config.js";

const SESSION_COOKIE = "jadges_session";
let installed = false;

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret)
    .update(value)
    .digest("base64url");
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return undefined;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return undefined;

  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { kind?: unknown; userId?: unknown; expiresAt?: unknown };
    if (
      payload.kind !== "session"
      || typeof payload.userId !== "string"
      || !/^\d{15,22}$/.test(payload.userId)
      || typeof payload.expiresAt !== "number"
      || payload.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return payload.userId;
  } catch {
    return undefined;
  }
}

function originAllowed(request: IncomingMessage): boolean {
  const supplied = request.headers.origin?.replace(/\/$/, "");
  return !supplied || supplied === config.publicUrl.replace(/\/$/, "");
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const content = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": content.length,
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
}

async function handleClientToken(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const userId = sessionUserId(request);
  if (!userId) {
    sendJson(request, response, 401, { error: "Login required" });
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    sendJson(request, response, 200, await getClientTokenStatus(userId));
    return;
  }

  if (request.method !== "POST" && request.method !== "DELETE") {
    sendJson(request, response, 405, { error: "Method not allowed" });
    return;
  }

  if (!originAllowed(request)) {
    sendJson(request, response, 403, { error: "Origin check failed" });
    return;
  }

  try {
    if (request.method === "DELETE") {
      await revokeClientToken(userId);
      sendJson(request, response, 200, { ok: true, configured: false });
      return;
    }

    const issued = await issueClientToken(userId);
    sendJson(request, response, 200, {
      ok: true,
      configured: true,
      token: issued.token,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      warning: "This token is shown only in this response. Generating another token revokes it.",
    });
  } catch (error) {
    sendJson(request, response, 400, {
      error: error instanceof Error ? error.message : "Could not manage client token",
    });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);
  if (url.pathname !== "/api/client-token") return false;
  await handleClientToken(request, response);
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleRequest(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges client token integration error:", error);
        if (response.headersSent) response.destroy();
        else sendJson(request, response, 500, { error: "Could not manage client token" });
      });
  };
}

export function installClientTokenIntegration(): void {
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
