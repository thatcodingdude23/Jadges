import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import path from "node:path";
import { config } from "./config.js";

const COOKIE = "jadges_session";
const SESSION_MS = 60 * 60 * 1000;
const REVOKED_FILE = path.join(config.dataDir, "rearrange-revocations.json");

type Payload = Ticket | State | Session;
interface Ticket { kind: "ticket"; userId: string; expiresAt: number; nonce: string; }
interface State { kind: "state"; ticket: string; expiresAt: number; nonce: string; }
interface Session { kind: "session"; userId: string; expiresAt: number; }

const revoked = new Map<string, number>();
let loadPromise: Promise<void> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let installed = false;

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function mac(value: string): string {
  return createHmac("sha256", config.webSessionSecret).update(value).digest("base64url");
}

function sign(payload: Payload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}

function verify<T extends Payload>(token: string | null | undefined, kind: T["kind"]): T | undefined {
  if (!token) return undefined;
  const [body, supplied, extra] = token.split(".");
  if (!body || !supplied || extra) return undefined;
  const expectedBytes = Buffer.from(mac(body));
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return payload.kind === kind && payload.expiresAt > Date.now() ? payload as T : undefined;
  } catch {
    return undefined;
  }
}

function sessionUser(request: IncomingMessage): string | undefined {
  const raw = (request.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
  const value = raw?.slice(COOKIE.length + 1);
  if (!value) return undefined;
  try {
    return verify<Session>(decodeURIComponent(value), "session")?.userId;
  } catch {
    return undefined;
  }
}

function prune(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of revoked) if (expiresAt <= now) revoked.delete(nonce);
}

async function loadRevocations(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const data = JSON.parse(await readFile(REVOKED_FILE, "utf8")) as { tickets?: Record<string, unknown> };
      for (const [nonce, value] of Object.entries(data.tickets || {})) {
        const expiresAt = Number(value);
        if (/^[a-f0-9]{24}$/.test(nonce) && Number.isFinite(expiresAt)) revoked.set(nonce, expiresAt);
      }
      prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not load terminated rearrangement links:", error);
    }
  })();
  await loadPromise;
}

async function saveRevocations(): Promise<void> {
  prune();
  const temp = `${REVOKED_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify({ tickets: Object.fromEntries(revoked) }, null, 2)}\n`, "utf8");
  try {
    await rename(temp, REVOKED_FILE);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function isTerminated(ticket: Ticket): Promise<boolean> {
  await loadRevocations();
  return (revoked.get(ticket.nonce) || 0) > Date.now();
}

async function terminate(ticket: Ticket): Promise<boolean> {
  await loadRevocations();
  if ((revoked.get(ticket.nonce) || 0) > Date.now()) return false;
  revoked.set(ticket.nonce, ticket.expiresAt);
  writeQueue = writeQueue.catch(() => undefined).then(saveRevocations);
  await writeQueue.catch(error => console.error("Could not save terminated rearrangement link:", error));
  return true;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function sendPage(response: ServerResponse, status: number, title: string, message: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0f1015;color:#f5f6f7}main{width:min(620px,100%);padding:30px;border:1px solid #5d2529;border-left:5px solid #ed4245;border-radius:18px;background:#17181f;box-shadow:0 24px 80px #0008}h1{margin:0;font-size:clamp(28px,6vw,42px)}p{margin:14px 0 0;color:#d2d4dc;line-height:1.6}footer{margin-top:24px;color:#8f93a3;font-size:13px}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><footer>Jadges • Security Protection</footer></main></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function discord<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.discordToken}`);
  headers.set("user-agent", "Jadges/1.0");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Discord API returned HTTP ${response.status}`);
  return await response.json() as T;
}

function safeName(value: string): string {
  return value.replace(/([\\`*_~|>])/g, "\\$1");
}

async function notifyOwner(userId: string): Promise<void> {
  try {
    const profile = await discord<{ username?: string; global_name?: string | null }>(`/users/${encodeURIComponent(userId)}`);
    const displayName = safeName(profile.global_name?.trim() || profile.username?.trim() || "there");
    const dm = await discord<{ id?: string }>("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!dm.id) throw new Error("Discord did not return a DM channel ID");
    await discord(`/channels/${encodeURIComponent(dm.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        embeds: [{
          title: "Link Terminated",
          description: `Hello, ${displayName}!\n\nJadges detected that your private badge-rearrangement link was opened and authorized using a different Discord account. To protect your profile, the link was immediately terminated before any badge changes could be made.\n\nYou may generate a new link using \`/badge rearrange\`. Please keep rearrangement links private and never share them with anyone you do not know or do not want attempting to access your badge settings.`,
          color: 0xed4245,
          footer: { text: "Jadges • Security Protection" },
          timestamp: new Date().toISOString(),
        }],
        allowed_mentions: { parse: [] },
      }),
    });
  } catch (error) {
    console.warn(`Could not DM rearrangement security alert to ${userId}:`, error);
  }
}

async function terminateAndNotify(ticket: Ticket): Promise<void> {
  if (await terminate(ticket)) await notifyOwner(ticket.userId);
}

async function oauthCallback(response: ServerResponse, url: URL): Promise<void> {
  const state = verify<State>(url.searchParams.get("state"), "state");
  const ticket = state ? verify<Ticket>(state.ticket, "ticket") : undefined;
  const code = url.searchParams.get("code");
  if (!state || !ticket || !code || !config.discordClientSecret) {
    sendPage(response, 400, "Authorization Failed", "Discord authorization could not be verified. Generate a new rearrangement link and try again.");
    return;
  }
  if (await isTerminated(ticket)) {
    sendPage(response, 410, "Link Terminated", "This rearrangement link has already been terminated. Generate a new link and keep it private.");
    return;
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
    sendPage(response, 502, "Authorization Failed", "Discord rejected the authorization request. Generate a new rearrangement link and try again.");
    return;
  }
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) {
    sendPage(response, 502, "Authorization Failed", "Discord did not return an access token. Generate a new rearrangement link and try again.");
    return;
  }
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const user = userResponse.ok ? await userResponse.json() as { id?: string } : undefined;
  if (!user?.id) {
    sendPage(response, 502, "Authorization Failed", "Discord could not verify the authorized account. Generate a new rearrangement link and try again.");
    return;
  }
  if (user.id !== ticket.userId) {
    await terminateAndNotify(ticket);
    sendPage(response, 403, "Link Terminated", "This private rearrangement link was terminated because a different Discord account attempted to authorize it. The owner has been notified.");
    return;
  }

  const session = sign({ kind: "session", userId: ticket.userId, expiresAt: Date.now() + SESSION_MS });
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  response.setHeader("set-cookie", `${COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
  response.writeHead(302, { location: `/rearrange?ticket=${encodeURIComponent(state.ticket)}`, "cache-control": "no-store" });
  response.end();
}

async function intercept(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);
  if (url.pathname === "/oauth/callback") {
    await oauthCallback(response, url);
    return true;
  }
  if (!["/rearrange", "/oauth/start", "/api/rearrange"].includes(url.pathname)) return false;
  const ticket = verify<Ticket>(url.searchParams.get("ticket"), "ticket");
  if (!ticket) return false;

  if (await isTerminated(ticket)) {
    if (url.pathname === "/api/rearrange") sendJson(response, 410, { error: "This rearrangement link was terminated." });
    else sendPage(response, 410, "Link Terminated", "This rearrangement link has been terminated. Generate a new link and keep it private.");
    return true;
  }
  if (url.pathname === "/rearrange") {
    const currentUser = sessionUser(request);
    if (currentUser && currentUser !== ticket.userId) {
      await terminateAndNotify(ticket);
      sendPage(response, 403, "Link Terminated", "This private rearrangement link was terminated because it was opened by a different Discord account. The owner has been notified.");
      return true;
    }
  }
  return false;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void intercept(request, response).then(handled => {
      if (!handled) listener(request, response);
    }).catch(error => {
      console.error("Rearrangement security error:", error);
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "Internal security error" });
    });
  };
}

export function installRearrangeSecurity(): void {
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
