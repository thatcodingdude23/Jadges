import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { errorPage, type DiscordUser } from "./presetPages.js";
import {
  MAX_PRESET_UPLOAD_SIZE,
  presetImageContentType,
  presetImagePath,
} from "./presetStore.js";

const SESSION_COOKIE = "jadges_session";
const WEBSITE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const PRESET_STATE_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BODY_SIZE = Math.ceil(MAX_PRESET_UPLOAD_SIZE * 1.42) + 128 * 1024;

type SignedPayload = SessionPayload | PresetStatePayload;
interface SessionPayload { kind: "session"; userId: string; expiresAt: number; }
interface PresetStatePayload {
  kind: "preset-state";
  expiresAt: number;
  nonce: string;
  returnTo: string;
}

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
    if (
      payload.kind !== kind
      || payload.expiresAt <= Date.now()
      || (payload.kind === "session" && !/^\d{15,22}$/.test(payload.userId))
    ) return undefined;
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
    const raw = part.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(raw); }
    catch { result[key] = raw; }
  }
  return result;
}

export function sessionUserId(request: IncomingMessage): string | undefined {
  return verifyPayload<SessionPayload>(
    parseCookies(request)[SESSION_COOKIE],
    "session",
  )?.userId;
}

function sessionCookie(userId: string): string {
  const token = signPayload({
    kind: "session",
    userId,
    expiresAt: Date.now() + WEBSITE_SESSION_MS,
  });
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(WEBSITE_SESSION_MS / 1000)}${secure}`;
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/presets";
  try {
    const parsed = new URL(value, "https://jadges.local");
    if (!parsed.pathname.startsWith("/presets")) return "/presets";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/presets";
  }
}

export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

export function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' https: data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self' https://discord.com",
    ].join("; "),
  });
  response.end(html);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function originAllowed(request: IncomingMessage, origin: string): boolean {
  const supplied = request.headers.origin;
  return !supplied || supplied === origin || supplied === config.publicUrl;
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_UPLOAD_BODY_SIZE) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function discordBotUser(userId: string): Promise<DiscordUser> {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          authorization: `Bot ${config.discordToken}`,
          "user-agent": "Jadges/1.0",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
    const user = await response.json() as DiscordUser;
    return { ...user, id: userId };
  } catch (error) {
    console.warn(`Could not load preset profile for ${userId}:`, error);
    return { id: userId, username: "discord-user", global_name: "Discord User" };
  }
}

export async function servePresetAsset(
  response: ServerResponse,
  filename: "presets.css" | "presets.js",
): Promise<void> {
  const content = await readFile(new URL(`../web/${filename}`, import.meta.url));
  response.writeHead(200, {
    "content-type": filename.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8",
    "content-length": String(content.length),
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

export async function servePresetImage(
  response: ServerResponse,
  filename: string,
  headOnly: boolean,
): Promise<void> {
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif|apng)$/i.test(filename)) {
    sendJson(response, 404, { error: "Image not found" });
    return;
  }
  try {
    const content = await readFile(presetImagePath(path.basename(filename)));
    response.writeHead(200, {
      "content-type": presetImageContentType(filename),
      "content-length": String(content.length),
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    });
    response.end(headOnly ? undefined : content);
  } catch {
    sendJson(response, 404, { error: "Image not found" });
  }
}

export async function startPresetLogin(
  response: ServerResponse,
  returnTo: string,
): Promise<void> {
  if (!config.discordClientSecret) {
    sendHtml(
      response,
      503,
      errorPage(undefined, "Login unavailable", "Discord OAuth has not been configured for Jadges yet."),
    );
    return;
  }
  const state = signPayload({
    kind: "preset-state",
    expiresAt: Date.now() + PRESET_STATE_MS,
    nonce: randomBytes(12).toString("hex"),
    returnTo: safeReturnTo(returnTo),
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

export async function handlePresetCallback(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  const state = verifyPayload<PresetStatePayload>(
    url.searchParams.get("state"),
    "preset-state",
  );
  if (!state) return false;
  const code = url.searchParams.get("code");
  if (!code || !config.discordClientSecret) {
    sendHtml(response, 400, errorPage(undefined, "Login failed", "Discord authorization could not be verified."));
    return true;
  }
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
  if (!tokenResponse.ok) {
    sendHtml(response, 502, errorPage(undefined, "Login failed", "Discord rejected the authorization request."));
    return true;
  }
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) {
    sendHtml(response, 502, errorPage(undefined, "Login failed", "Discord did not return an access token."));
    return true;
  }
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const user = userResponse.ok ? await userResponse.json() as DiscordUser : undefined;
  if (!user?.id || !/^\d{15,22}$/.test(user.id)) {
    sendHtml(response, 502, errorPage(undefined, "Login failed", "Discord could not verify your account."));
    return true;
  }
  response.setHeader("set-cookie", sessionCookie(user.id));
  redirect(response, safeReturnTo(state.returnTo));
  return true;
}

export function requirePageLogin(
  request: IncomingMessage,
  response: ServerResponse,
  returnTo: string,
): string | undefined {
  const userId = sessionUserId(request);
  if (userId) return userId;
  redirect(response, `/presets/login?next=${encodeURIComponent(safeReturnTo(returnTo))}`);
  return undefined;
}
