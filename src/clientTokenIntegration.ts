import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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
const WEBSITE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CONNECT_LIFETIME_MS = 10 * 60 * 1000;
const MAX_BODY_SIZE = 16 * 1024;
const MAX_PENDING_CONNECTIONS = 1_000;
const STARTS_PER_MINUTE = 12;

interface SessionPayload {
  kind: "session";
  userId: string;
  expiresAt: number;
}

interface ClientConnectStatePayload {
  kind: "client-connect-state";
  deviceCode: string;
  expiresAt: number;
  nonce: string;
}

type SignedPayload = SessionPayload | ClientConnectStatePayload;

interface DiscordUser {
  id: string;
}

interface PendingConnection {
  expectedUserId: string;
  clientName: string;
  pollSecretHash: string;
  createdAt: number;
  expiresAt: number;
  token?: string;
  tokenExpiresAt?: string;
  error?: string;
  lastPollAt?: number;
}

interface StartRate {
  startedAt: number;
  count: number;
}

const pendingConnections = new Map<string, PendingConnection>();
const startRates = new Map<string, StartRate>();
let installed = false;

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret)
    .update(value)
    .digest("base64url");
}

function signPayload(payload: SignedPayload): string {
  const body = encode(JSON.stringify(payload));
  return `${body}.${signature(body)}`;
}

function verifyPayload<T extends SignedPayload>(
  token: string | null | undefined,
  kind: T["kind"],
): T | undefined {
  if (!token) return undefined;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return undefined;

  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decode(body)) as SignedPayload;
    if (payload.kind !== kind || payload.expiresAt <= Date.now()) return undefined;
    return payload as T;
  } catch {
    return undefined;
  }
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
  return verifyPayload<SessionPayload>(
    parseCookies(request)[SESSION_COOKIE],
    "session",
  )?.userId;
}

function sessionCookie(userId: string): string {
  const session = signPayload({
    kind: "session",
    userId,
    expiresAt: Date.now() + WEBSITE_SESSION_MS,
  });
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(WEBSITE_SESSION_MS / 1000)}${secure}`;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [code, connection] of pendingConnections) {
    if (connection.expiresAt <= now) pendingConnections.delete(code);
  }
  for (const [key, rate] of startRates) {
    if (now - rate.startedAt > 60_000) startRates.delete(key);
  }
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim()
    || request.socket.remoteAddress
    || "unknown";
}

function allowStart(request: IncomingMessage): boolean {
  cleanExpired();
  if (pendingConnections.size >= MAX_PENDING_CONNECTIONS) return false;

  const key = clientAddress(request);
  const now = Date.now();
  const current = startRates.get(key);
  if (!current || now - current.startedAt > 60_000) {
    startRates.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= STARTS_PER_MINUTE;
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
  cors = false,
): void {
  const content = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": content.length,
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(cors ? {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    } : {}),
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sendConnectHtml(
  response: ServerResponse,
  title: string,
  message: string,
  success: boolean,
): void {
  const color = success ? "#57f287" : "#ff6b81";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  response.writeHead(success ? 200 : 400, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080c16;color:#f4f7ff}.card{width:min(520px,calc(100% - 32px));padding:34px;border:1px solid #29324a;border-radius:22px;background:#111827;box-shadow:0 28px 90px #0008;text-align:center}.mark{width:58px;height:58px;margin:0 auto 18px;display:grid;place-items:center;border-radius:50%;border:2px solid ${color};color:${color};font-size:30px;font-weight:900}h1{margin:0;font-size:27px}p{margin:13px 0 0;color:#aab4ca;line-height:1.55}</style></head><body><main class="card"><div class="mark">${success ? "✓" : "!"}</div><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body></html>`);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function completeConnection(
  deviceCode: string,
  userId: string,
): Promise<{ ok: boolean; message: string }> {
  const connection = pendingConnections.get(deviceCode);
  if (!connection || connection.expiresAt <= Date.now()) {
    pendingConnections.delete(deviceCode);
    return { ok: false, message: "This connection request expired. Return to Discord and try again." };
  }

  if (connection.expectedUserId !== userId) {
    connection.error = "The authorized Discord account did not match the account using Jadges.";
    return { ok: false, message: connection.error };
  }

  const issued = await issueClientToken(userId);
  connection.token = issued.token;
  connection.tokenExpiresAt = issued.expiresAt;
  return { ok: true, message: `${connection.clientName} is now connected securely. You can close this page and return to Discord.` };
}

async function exchangeDiscordCode(code: string): Promise<DiscordUser | undefined> {
  if (!config.discordClientSecret) return undefined;
  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${config.publicUrl}/oauth/callback`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) return undefined;

  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) return undefined;
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return userResponse.ok
    ? await userResponse.json() as DiscordUser
    : undefined;
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

  if (request.method === "DELETE") {
    await revokeClientToken(userId);
    sendJson(request, response, 200, { ok: true, configured: false });
    return;
  }

  const issued = await issueClientToken(userId, { rotate: true });
  sendJson(request, response, 200, {
    ok: true,
    configured: true,
    createdAt: issued.createdAt,
    expiresAt: issued.expiresAt,
  });
}

async function handleConnectStart(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    });
    response.end();
    return;
  }
  if (request.method !== "POST") {
    sendJson(request, response, 405, { error: "Method not allowed" }, true);
    return;
  }
  if (!allowStart(request)) {
    sendJson(request, response, 429, { error: "Too many connection attempts" }, true);
    return;
  }

  const body = await readJson(request) as { userId?: unknown; client?: unknown };
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!/^\d{15,22}$/.test(userId)) {
    sendJson(request, response, 400, { error: "Invalid Discord user ID" }, true);
    return;
  }

  const clientName = typeof body.client === "string"
    ? body.client.trim().replace(/[^a-z0-9 ._-]/gi, "").slice(0, 40)
    : "Jadges";
  const deviceCode = randomBytes(24).toString("base64url");
  const pollSecret = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + CONNECT_LIFETIME_MS;
  pendingConnections.set(deviceCode, {
    expectedUserId: userId,
    clientName: clientName || "Jadges",
    pollSecretHash: hashSecret(pollSecret),
    createdAt: Date.now(),
    expiresAt,
  });

  const authorizeUrl = new URL("/client/connect", config.publicUrl);
  authorizeUrl.searchParams.set("code", deviceCode);
  sendJson(request, response, 200, {
    deviceCode,
    pollSecret,
    authorizeUrl: authorizeUrl.toString(),
    expiresAt: new Date(expiresAt).toISOString(),
    intervalMs: 2_000,
  }, true);
}

async function handleConnectPoll(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    });
    response.end();
    return;
  }
  if (request.method !== "POST") {
    sendJson(request, response, 405, { error: "Method not allowed" }, true);
    return;
  }

  cleanExpired();
  const body = await readJson(request) as {
    deviceCode?: unknown;
    pollSecret?: unknown;
  };
  const deviceCode = typeof body.deviceCode === "string" ? body.deviceCode : "";
  const pollSecret = typeof body.pollSecret === "string" ? body.pollSecret : "";
  const connection = pendingConnections.get(deviceCode);
  if (!connection || connection.expiresAt <= Date.now()) {
    pendingConnections.delete(deviceCode);
    sendJson(request, response, 410, { error: "Connection request expired" }, true);
    return;
  }

  if (!equalText(hashSecret(pollSecret), connection.pollSecretHash)) {
    sendJson(request, response, 401, { error: "Invalid connection secret" }, true);
    return;
  }

  const now = Date.now();
  if (connection.lastPollAt && now - connection.lastPollAt < 750) {
    sendJson(request, response, 429, { error: "Polling too quickly" }, true);
    return;
  }
  connection.lastPollAt = now;

  if (connection.error) {
    const message = connection.error;
    pendingConnections.delete(deviceCode);
    sendJson(request, response, 403, { error: message }, true);
    return;
  }
  if (!connection.token) {
    sendJson(request, response, 202, { status: "pending" }, true);
    return;
  }

  const token = connection.token;
  const expiresAt = connection.tokenExpiresAt;
  pendingConnections.delete(deviceCode);
  sendJson(request, response, 200, {
    status: "authorized",
    token,
    expiresAt,
  }, true);
}

async function handleBrowserConnect(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(request, response, 405, { error: "Method not allowed" });
    return;
  }

  cleanExpired();
  const deviceCode = url.searchParams.get("code") || "";
  const connection = pendingConnections.get(deviceCode);
  if (!connection || connection.expiresAt <= Date.now()) {
    pendingConnections.delete(deviceCode);
    sendConnectHtml(response, "Connection expired", "Return to Discord and let Jadges create a new secure connection.", false);
    return;
  }

  const loggedInUser = sessionUserId(request);
  if (loggedInUser) {
    const result = await completeConnection(deviceCode, loggedInUser);
    sendConnectHtml(response, result.ok ? "Jadges connected" : "Account mismatch", result.message, result.ok);
    return;
  }

  if (!config.discordClientSecret) {
    sendConnectHtml(response, "Connection unavailable", "Discord OAuth has not been configured on the Jadges server.", false);
    return;
  }

  const state = signPayload({
    kind: "client-connect-state",
    deviceCode,
    expiresAt: connection.expiresAt,
    nonce: randomBytes(12).toString("hex"),
  });
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", `${config.publicUrl}/oauth/callback`);
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "consent");
  redirect(response, authorize.toString());
}

async function handleClientOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const state = verifyPayload<ClientConnectStatePayload>(
    url.searchParams.get("state"),
    "client-connect-state",
  );
  if (!state) return false;

  const connection = pendingConnections.get(state.deviceCode);
  if (!connection || connection.expiresAt <= Date.now()) {
    pendingConnections.delete(state.deviceCode);
    sendConnectHtml(response, "Connection expired", "Return to Discord and try connecting Jadges again.", false);
    return true;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    connection.error = "Discord authorization was cancelled.";
    sendConnectHtml(response, "Authorization cancelled", connection.error, false);
    return true;
  }

  const user = await exchangeDiscordCode(code);
  if (!user?.id) {
    connection.error = "Discord could not verify this account.";
    sendConnectHtml(response, "Authorization failed", connection.error, false);
    return true;
  }

  const result = await completeConnection(state.deviceCode, user.id);
  if (result.ok) response.setHeader("set-cookie", sessionCookie(user.id));
  sendConnectHtml(response, result.ok ? "Jadges connected" : "Account mismatch", result.message, result.ok);
  return true;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);

  if (url.pathname === "/api/client-token") {
    await handleClientToken(request, response);
    return true;
  }
  if (url.pathname === "/api/client-connect/start") {
    await handleConnectStart(request, response);
    return true;
  }
  if (url.pathname === "/api/client-connect/poll") {
    await handleConnectPoll(request, response);
    return true;
  }
  if (url.pathname === "/client/connect") {
    await handleBrowserConnect(request, response, url);
    return true;
  }
  if (url.pathname === "/oauth/callback") {
    return handleClientOAuthCallback(request, response, url);
  }
  return false;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleRequest(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges automatic client authorization error:", error);
        if (response.headersSent) response.destroy();
        else sendJson(request, response, 500, { error: "Could not authorize Jadges" });
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
