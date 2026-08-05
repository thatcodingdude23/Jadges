import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import path from "node:path";
import { config } from "./config.js";

interface CustomProfile {
  username?: string;
  createdAt?: string;
}

type CustomProfiles = Record<string, CustomProfile>;

const STORE_FILE = path.join(config.dataDir, "custom-profiles.json");
const SESSION_COOKIE = "jadges_session";
let installed = false;
let writeQueue: Promise<void> = Promise.resolve();

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret).update(value).digest("base64url");
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const cookie = (request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const raw = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    const token = decodeURIComponent(raw);
    const [body, suppliedSignature, extra] = token.split(".");
    if (!body || !suppliedSignature || extra) return undefined;
    const expected = Buffer.from(signature(body));
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { kind?: unknown; userId?: unknown; expiresAt?: unknown };
    if (payload.kind !== "session" || typeof payload.userId !== "string" || !/^\d{15,22}$/.test(payload.userId) || typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return undefined;
    return payload.userId;
  } catch { return undefined; }
}

async function ensureStore(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try { await readFile(STORE_FILE, "utf8"); }
  catch { await writeFile(STORE_FILE, "{}", "utf8"); }
}

async function readProfiles(): Promise<CustomProfiles> {
  await writeQueue;
  await ensureStore();
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CustomProfiles : {};
  } catch { return {}; }
}

async function mutateProfiles(change: (profiles: CustomProfiles) => void): Promise<void> {
  const operation = writeQueue.then(async () => {
    const profiles = await readProfilesUnsafe();
    change(profiles);
    const temporary = `${STORE_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(profiles, null, 2), "utf8");
    await rename(temporary, STORE_FILE);
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readProfilesUnsafe(): Promise<CustomProfiles> {
  await ensureStore();
  try { return JSON.parse(await readFile(STORE_FILE, "utf8")) as CustomProfiles; }
  catch { return {}; }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new Error("Request is too large");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Record<string, unknown>;
}

function cleanUsername(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Custom username must be text");
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  if (cleaned.length > 32) throw new Error("Custom username can contain up to 32 characters");
  return cleaned;
}

function cleanDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Choose a valid date");
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (!match) throw new Error("Choose a valid date");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1900 || date > new Date()) throw new Error("Choose a date between 1900 and today");
  return date.toISOString();
}

function page(profile: CustomProfile, saved: boolean): string {
  const date = profile.createdAt ? profile.createdAt.slice(0, 10) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Custom Profile • Jadges</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#080b13;color:#f7f8fc;font:15px/1.5 Inter,system-ui,sans-serif}.wrap{width:min(720px,calc(100% - 28px));margin:40px auto}.card{background:#111827;border:1px solid #2a344a;border-radius:20px;padding:24px}h1{margin:0 0 8px;font-size:34px}p{color:#aeb7c8}label{display:block;margin-top:18px;font-weight:800}input{width:100%;margin-top:7px;padding:13px;border:1px solid #33405a;border-radius:11px;background:#090e19;color:white;font:inherit}button,a{display:inline-block;margin-top:20px;padding:11px 15px;border-radius:11px;text-decoration:none;font-weight:800}button{border:0;background:#7c5cff;color:white;cursor:pointer}a{color:#d6dcf0;border:1px solid #33405a;margin-left:8px}.note{padding:12px;border-radius:11px;background:#0b1222}.ok{background:#123523;color:#8aebb0;padding:11px;border-radius:10px}</style></head><body><main class="wrap"><section class="card"><h1>Custom Profile</h1><p>These values are cosmetic and only appear to people using a supported Jadges client. Your real Discord account is never changed.</p>${saved ? '<div class="ok">Custom profile saved.</div>' : ""}<form id="profile"><label>Custom username<input name="username" maxlength="32" value="${escapeHtml(profile.username || "")}" placeholder="Luck"></label><label>Custom account creation date<input name="createdAt" type="date" min="1900-01-01" value="${escapeHtml(date)}"></label><p class="note">Jadges will also show <b>Originally, your real username</b> and the original Discord account creation date.</p><button type="submit">Save custom profile</button><a href="/dashboard">Dashboard</a></form><script>document.getElementById('profile').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const r=await fetch('/api/custom-profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.get('username'),createdAt:f.get('createdAt')})});const j=await r.json();if(!r.ok){alert(j.error||'Could not save');return}location.href='/custom-profile?saved=1'});</script></section></main></body></html>`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "cache-control": "no-store", "access-control-allow-origin": "*" });
  response.end(body);
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", config.publicUrl);
    if (request.method === "GET" && url.pathname === "/custom-profiles.json") {
      void readProfiles().then((profiles) => sendJson(response, 200, profiles));
      return;
    }
    if (url.pathname === "/custom-profile" && request.method === "GET") {
      const userId = sessionUserId(request);
      if (!userId) { response.writeHead(302, { location: "/login", "cache-control": "no-store" }); response.end(); return; }
      void readProfiles().then((profiles) => {
        const html = page(profiles[userId] || {}, url.searchParams.get("saved") === "1");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        response.end(html);
      });
      return;
    }
    if (url.pathname === "/api/custom-profile" && request.method === "POST") {
      const userId = sessionUserId(request);
      if (!userId) { sendJson(response, 401, { error: "Login required" }); return; }
      void readBody(request).then((body) => {
        const username = cleanUsername(body.username);
        const createdAt = cleanDate(body.createdAt);
        return mutateProfiles((profiles) => {
          if (!username && !createdAt) delete profiles[userId];
          else profiles[userId] = { username, createdAt };
        });
      }).then(() => sendJson(response, 200, { ok: true })).catch((error) => sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not save custom profile" }));
      return;
    }
    listener(request, response);
  };
}

export function installCustomProfileIntegration(): void {
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
