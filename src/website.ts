import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { NITRO_PRESETS } from "./presets.js";
import { publicImageUrl } from "./storage.js";
import { getUser, setBadgeOrder, setBadgeSide } from "./store.js";
import type { BadgeSide, UserRecord } from "./types.js";

const SESSION_COOKIE = "jadges_session";
const WEBSITE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const WEBSITE_STATE_MS = 10 * 60 * 1000;
const MAX_BODY_SIZE = 64 * 1024;

type SystemStaffBadge = "staff" | "admin";
type ResolveSystemStaffBadge = (userId: string, user: UserRecord) => SystemStaffBadge | undefined;

interface WebsiteStatePayload { kind: "website-state"; expiresAt: number; nonce: string }
interface SessionPayload { kind: "session"; userId: string; expiresAt: number }
type SignedPayload = WebsiteStatePayload | SessionPayload;
interface DiscordUser { id: string; username?: string; global_name?: string | null; avatar?: string | null }
interface DashboardBadge { key: string; name: string; image: string; movable: boolean; subtitle: string }
interface DashboardData {
  profile: { id: string; displayName: string; username: string; avatar: string };
  badges: DashboardBadge[];
  order: string[];
  side: BadgeSide;
  hasNativeBadges: boolean;
  stats: { totalBadges: number; nativeBadges: number; pendingReviews: number; pluginVersion: number };
}

function encode(value: string): string { return Buffer.from(value, "utf8").toString("base64url") }
function decode(value: string): string { return Buffer.from(value, "base64url").toString("utf8") }
function signature(value: string): string { return createHmac("sha256", config.webSessionSecret).update(value).digest("base64url") }
function signPayload(payload: SignedPayload): string { const body = encode(JSON.stringify(payload)); return `${body}.${signature(body)}` }

function verifyPayload<T extends SignedPayload>(token: string | null | undefined, kind: T["kind"]): T | undefined {
  if (!token) return undefined;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return undefined;
  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
  try {
    const payload = JSON.parse(decode(body)) as SignedPayload;
    if (payload.kind !== kind || payload.expiresAt <= Date.now()) return undefined;
    return payload as T;
  } catch { return undefined }
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value) } catch { result[key] = value }
  }
  return result;
}

function sessionUserId(request: IncomingMessage): string | undefined {
  return verifyPayload<SessionPayload>(parseCookies(request)[SESSION_COOKIE], "session")?.userId;
}

function sessionCookie(userId: string): string {
  const session = signPayload({ kind: "session", userId, expiresAt: Date.now() + WEBSITE_SESSION_MS });
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(WEBSITE_SESSION_MS / 1000)}${secure}`;
}

function clearSessionCookie(): string {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" }); response.end();
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self' https://discord.com",
    ].join("; "),
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function serveAsset(response: ServerResponse, filename: "jadges.css" | "jadges.js"): Promise<void> {
  const content = await readFile(new URL(`../web/${filename}`, import.meta.url));
  response.writeHead(200, {
    "content-type": filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
    "content-length": content.length,
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function logoMarkup(): string {
  return `<svg class="logo-mark" viewBox="0 0 48 54" aria-hidden="true"><defs><linearGradient id="jadges-logo" x1="5" y1="3" x2="43" y2="49"><stop stop-color="#b89cff"/><stop offset=".5" stop-color="#7c4dff"/><stop offset="1" stop-color="#5b8cff"/></linearGradient></defs><path d="M24 2.8 43 10v14.2c0 12.2-7.7 22.3-19 27.1C12.7 46.5 5 36.4 5 24.2V10l19-7.2Z" fill="url(#jadges-logo)"/><path d="M24 7.4 38.5 13v11.1c0 9.4-5.6 17.3-14.5 21.5C15.1 41.4 9.5 33.5 9.5 24.1V13L24 7.4Z" fill="#0b1020" opacity=".92"/><path d="m24 14.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9 2.9-5.9Z" fill="white"/></svg>`;
}

function pageHead(title: string, description: string): string {
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#070b14"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/jadges.css"></head>`;
}

function landingPage(loggedIn: boolean): string {
  const href = loggedIn ? "/dashboard" : "/login";
  const label = loggedIn ? "Open Dashboard" : "Login with Discord";
  return `<!doctype html><html lang="en">${pageHead("Jadges", "Manage your Jadges badges and cosmetic profile.")}<body class="landing"><nav class="landing-nav"><a class="site-logo" href="/">${logoMarkup()}<span>Jadges</span></a><a class="discord-button" href="${href}">${label}</a></nav><main class="landing-main"><section class="hero-copy"><h1>Your badges.<br><span>Your order.</span><br>Your profile.</h1><p>Arrange badges and customize your cosmetic Jadges identity from one secure dashboard.</p><div class="hero-buttons"><a class="discord-button" href="${href}">${label}</a><a class="secondary-button" href="https://discord.gg/h63eG654F">Jaycord</a></div></section></main></body></html>`;
}

function verifiedIcon(): string {
  return `<svg class="verified-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 2 2.2 2 3-.2.8 2.9 2.6 1.6-1.1 2.8 1.1 2.8-2.6 1.6-.8 2.9-3-.2-2.2 2-2.2-2-3 .2-.8-2.9-2.6-1.6 1.1-2.8-1.1-2.8 2.6-1.6.8-2.9 3 .2L12 2Zm-1.1 13.5 5.6-5.6-1.4-1.4-4.2 4.2-2-2-1.4 1.4 3.4 3.4Z"/></svg>`;
}

function dashboardPage(data: DashboardData): string {
  const safeData = JSON.stringify(data).replaceAll("<", "\\u003c");
  const safeDisplayName = escapeHtml(data.profile.displayName);
  const safeUsername = escapeHtml(data.profile.username);
  const safeAvatar = escapeHtml(data.profile.avatar);
  const nativeNotice = data.hasNativeBadges
    ? "Native Discord badges detected by the Jadges plugin are included in your arrangement."
    : "No native Discord badges have been detected yet. Open your Discord profile with Jadges enabled, then refresh.";

  return `<!doctype html><html lang="en">${pageHead("Dashboard — Jadges", "Manage your Jadges badges and cosmetic profile.")}<body class="dashboard-body">
  <style>
    .dashboard-view[hidden],.custom-profile-view[hidden]{display:none!important}.custom-profile-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:24px;align-items:start}.custom-profile-form{padding:0 24px 26px;display:grid;gap:18px}.custom-profile-form label>span{display:block;margin-bottom:8px;font-weight:800}.custom-profile-form input{width:100%;height:48px;padding:0 14px;border:1px solid #303b52;border-radius:11px;background:#080e19;color:#fff;font:inherit;outline:none}.custom-profile-form input:focus{border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.15)}.custom-profile-form small{display:block;margin-top:7px;color:#7f8ba0}.custom-profile-note{padding:14px 15px;border:1px solid #2a3550;border-radius:12px;background:#0a1221;color:#aeb8ca}.custom-profile-actions{display:flex;gap:12px;flex-wrap:wrap}.custom-profile-actions button{border-radius:11px;padding:12px 18px;font:inherit;font-weight:850;cursor:pointer}.custom-profile-actions .clear{border:1px solid #303b52;background:transparent;color:#cbd2df}.custom-profile-preview{overflow:hidden}.custom-preview-body{padding:26px}.custom-preview-card{overflow:hidden;border:1px solid #30333b;border-radius:16px;background:#16181d}.custom-preview-banner{height:100px;background:radial-gradient(circle at 18% 30%,rgba(154,119,255,.8),transparent 30%),linear-gradient(135deg,#322367,#19274f)}.custom-preview-content{padding:0 18px 22px}.custom-preview-avatar{display:block;width:78px;height:78px;margin-top:-39px;border:6px solid #16181d;border-radius:50%;object-fit:cover;background:#222}.custom-preview-name{margin-top:11px;font-size:22px;font-weight:900}.custom-preview-original{margin-top:3px;color:#929aa8;font-size:12px}.custom-preview-date{margin-top:5px;color:#e5e7eb}@media(max-width:900px){.custom-profile-grid{grid-template-columns:1fr}}
  </style>
  <div class="app-shell"><aside class="sidebar"><a class="site-logo" href="/">${logoMarkup()}<span>Jadges</span></a><nav class="sidebar-nav">
    <a class="nav-link active" href="#dashboard"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v9H4v-9Z"/><path d="M9 20v-6h6v6"/></svg>Dashboard</a>
    <a class="nav-link" href="#badges"><svg viewBox="0 0 24 24"><path d="m12 3 7 3v5c0 4.6-2.8 8.2-7 10-4.2-1.8-7-5.4-7-10V6l7-3Z"/></svg>Badges</a>
    <a class="nav-link" href="#appearance"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-1 1.5-2-.7-1.5.4-3 2-3h2.2A3.3 3.3 0 0 0 21 12.7 9.7 9.7 0 0 0 12 3Z"/></svg>Appearance</a>
    <a class="nav-link" href="#customprofile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.4 3.5-7 8-7s7.2 2.6 8 7"/><path d="M18 4v4M16 6h4"/></svg>Custom Profile</a>
  </nav><div class="sidebar-spacer"></div><div class="sidebar-help"><strong>Need help?</strong><p>Join Jaycord for dashboard or plugin support.</p><a href="https://discord.gg/h63eG654F">Open support server →</a></div><div class="sidebar-foot">Jadges Dashboard • V.1</div></aside>
  <main class="app-main" id="dashboard"><header class="topbar"><div class="mobile-brand"><a class="site-logo" href="/">${logoMarkup()}<span>Jadges</span></a></div><div class="account-menu"><img class="account-avatar" src="${safeAvatar}" alt=""><div class="account-copy"><strong>${safeDisplayName}</strong><span>@${safeUsername}</span></div><form action="/logout" method="post"><button class="logout-link" type="submit">Log out</button></form></div></header>
  <div class="dashboard-wrap">
    <div class="dashboard-view" id="dashboard-view">
      <div class="page-heading"><h1>Dashboard</h1><p>Manage your badges, placement, and Jadges profile appearance.</p></div>
      <div class="dashboard-grid"><section class="dashboard-primary"><div class="stats-grid"><article class="stat-card"><div class="stat-label">Total badges</div><div class="stat-value">${data.stats.totalBadges}</div><div class="stat-note">Available to display</div></article><article class="stat-card"><div class="stat-label">Position</div><div class="stat-value" id="position-value">${data.side === "left" ? "Left" : "Right"}</div><div class="stat-note">Default profile side</div></article><article class="stat-card"><div class="stat-label">Native badges</div><div class="stat-value">${data.stats.nativeBadges}</div><div class="stat-note">Detected from Discord</div></article><article class="stat-card"><div class="stat-label">Plugin version</div><div class="stat-value">V.${data.stats.pluginVersion}</div><div class="stat-note">Vencord and Revenge</div></article></div>
      <section class="panel" id="badges"><div class="panel-head"><div><h2>Your badges</h2><p>Drag badges to swap their order.</p></div><div class="save-indicator" id="save-indicator"><span class="save-dot"></span><span>All changes saved</span></div></div><div class="badge-editor"><div class="badge-grid" id="badge-grid"></div></div><div class="settings-list" id="appearance"><div class="setting-row"><div class="setting-copy"><strong>Badge position</strong><span>Choose the default side where Jadges badges appear.</span></div><div class="segmented" role="group"><button type="button" data-side="left" aria-pressed="${data.side === "left"}">Left</button><button type="button" data-side="right" aria-pressed="${data.side === "right"}">Right</button></div></div><div class="setting-row"><div class="setting-copy"><strong>Profile sync</strong><span>Changes save automatically and sync with supported Jadges clients.</span></div><div class="sync-state"><i></i>Synced</div></div></div></section><div class="notice-bar"><strong>Native badge detection:</strong> ${escapeHtml(nativeNotice)}</div></section>
      <aside class="panel preview-panel"><div class="panel-head"><div><h2>Profile preview</h2><p>A preview of your badge order.</p></div></div><div class="preview-body"><div class="profile-card"><div class="profile-banner"></div><div class="profile-content"><div class="profile-avatar-wrap"><img class="profile-avatar" src="${safeAvatar}" alt=""><span class="profile-online"></span></div><div class="profile-badges" id="profile-badges"></div><div class="profile-name">${safeDisplayName}${verifiedIcon()}</div><div class="profile-username">${safeUsername}</div><div class="profile-divider"></div><div class="profile-section-title">About Jadges</div><div class="profile-copy">Your saved badge order appears to people using the Jadges plugin.</div></div></div></div></aside></div>
    </div>
    <section class="custom-profile-view" id="customprofile" hidden><div class="page-heading"><h1>Custom Profile</h1><p>Change your cosmetic username and account creation date without changing your real Discord account.</p></div><div class="custom-profile-grid"><section class="panel"><div class="panel-head"><div><h2>Profile details</h2><p>These values appear only in supported Jadges clients.</p></div><div class="save-indicator" id="custom-profile-status"><span class="save-dot"></span><span>Ready</span></div></div><form id="custom-profile-form" class="custom-profile-form"><label><span>Custom username</span><input id="custom-profile-username" maxlength="32" placeholder="Enter a cosmetic name"><small>Used across profiles, messages, member lists, and supported surfaces.</small></label><label><span>Custom account creation date</span><input id="custom-profile-date" type="date" min="1900-01-01"><small>Shown as your cosmetic Member Since date.</small></label><div class="custom-profile-note">Your original Discord username and real creation date remain visible underneath.</div><div class="custom-profile-actions"><button class="primary-button" type="submit">Save changes</button><button class="clear" id="custom-profile-clear" type="button">Clear custom profile</button></div></form></section><aside class="panel custom-profile-preview"><div class="panel-head"><div><h2>Live preview</h2><p>Your cosmetic identity in a Discord-inspired card.</p></div></div><div class="custom-preview-body"><div class="custom-preview-card"><div class="custom-preview-banner"></div><div class="custom-preview-content"><img class="custom-preview-avatar" src="${safeAvatar}" alt=""><div class="custom-preview-name" id="custom-preview-name">${safeDisplayName}</div><div class="custom-preview-original">Originally, ${safeUsername}</div><div class="profile-divider"></div><div class="profile-section-title">Member Since</div><div class="custom-preview-date" id="custom-preview-date">Original Discord date</div><div class="custom-preview-original">Originally, your real account creation date</div></div></div></div></aside></div></section>
  </div></main></div>
  <script id="jadges-data" type="application/json">${safeData}</script><script src="/assets/jadges.js" defer></script>
  <script>
    (()=>{const state=${safeData};const dashboard=document.getElementById('dashboard-view');const custom=document.getElementById('customprofile');const links=[...document.querySelectorAll('.sidebar-nav .nav-link')];const user=state.profile.id;const name=document.getElementById('custom-profile-username');const date=document.getElementById('custom-profile-date');const previewName=document.getElementById('custom-preview-name');const previewDate=document.getElementById('custom-preview-date');const status=document.getElementById('custom-profile-status');const setStatus=(text,error=false)=>{status?.classList.toggle('error',error);const label=status?.querySelector('span:last-child');if(label)label.textContent=text};const updatePreview=()=>{if(previewName)previewName.textContent=name?.value.trim()||state.profile.displayName;if(previewDate)previewDate.textContent=date?.value||'Original Discord date'};const route=()=>{const isCustom=location.hash==='#customprofile';if(dashboard)dashboard.hidden=isCustom;if(custom)custom.hidden=!isCustom;for(const link of links){const href=link.getAttribute('href');link.classList.toggle('active',isCustom?href==='#customprofile':href===(location.hash||'#dashboard'))}if(isCustom)scrollTo(0,0)};addEventListener('hashchange',route);name?.addEventListener('input',updatePreview);date?.addEventListener('input',updatePreview);fetch('/custom-profiles.json',{cache:'no-store'}).then(r=>r.ok?r.json():{}).then(p=>{const v=p[user]||{};if(name)name.value=v.username||'';if(date)date.value=v.createdAt?String(v.createdAt).slice(0,10):'';updatePreview()}).catch(()=>setStatus('Could not load profile',true));document.getElementById('custom-profile-form')?.addEventListener('submit',async e=>{e.preventDefault();setStatus('Saving…');const r=await fetch('/api/custom-profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name?.value||'',createdAt:date?.value||''})});const b=await r.json().catch(()=>({}));setStatus(r.ok?'Saved':b.error||'Could not save',!r.ok)});document.getElementById('custom-profile-clear')?.addEventListener('click',async()=>{if(name)name.value='';if(date)date.value='';updatePreview();setStatus('Clearing…');const r=await fetch('/api/custom-profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'',createdAt:''})});setStatus(r.ok?'Cleared':'Could not clear',!r.ok)});route()})();
  </script></body></html>`;
}

function errorPage(title: string, message: string): string {
  return `<!doctype html><html lang="en">${pageHead(`${title} — Jadges`, message)}<body class="landing"><main class="landing-main"><section class="hero-copy"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="primary-button" href="/">Return home</a></section></main></body></html>`;
}

function nativeBadgeIsVisible(user: UserRecord, key: string): boolean {
  if (key === "discord:nitro" && user.nitro) return false;
  if (key === "discord:boosting" && user.nitro?.preset === "remove") return false;
  return true;
}

function orderedMovableKeys(user: UserRecord): string[] {
  const available = [
    ...user.badges.filter((badge) => !badge.pending).map((badge) => `custom:${badge.id}`),
    ...(user.nitro && !user.nitro.pending && user.nitro.preset !== "remove" ? ["nitro"] : []),
    ...(user.nativeBadges || []).filter((badge) => nativeBadgeIsVisible(user, badge.key)).map((badge) => badge.key),
  ];
  const availableSet = new Set(available);
  const ordered = (user.badgeOrder || []).filter((key) => availableSet.has(key));
  for (const key of available) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

function defaultAvatarIndex(userId: string): number { try { return Number((BigInt(userId) >> 22n) % 6n) } catch { return 0 } }
function discordAvatar(user: DiscordUser): string {
  if (user.avatar) { const extension = user.avatar.startsWith("a_") ? "gif" : "png"; return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${extension}?size=256` }
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(user.id)}.png`;
}

async function discordBotUser(userId: string): Promise<DiscordUser> {
  try {
    const response = await fetch(`https://discord.com/api/v10/users/${encodeURIComponent(userId)}`, { headers: { authorization: `Bot ${config.discordToken}`, "user-agent": "Jadges/1.0" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
    return { ...(await response.json() as DiscordUser), id: userId };
  } catch (error) {
    console.warn(`Could not load website profile for ${userId}:`, error);
    return { id: userId, username: "discord-user", global_name: "Discord User" };
  }
}

async function buildDashboardData(userId: string, origin: string, resolveSystemStaffBadge: ResolveSystemStaffBadge): Promise<DashboardData> {
  const [user, discordUser] = await Promise.all([getUser(userId), discordBotUser(userId)]);
  const badges: DashboardBadge[] = [];
  const staffBadge = resolveSystemStaffBadge(userId, user);
  if (staffBadge) {
    const admin = staffBadge === "admin";
    badges.push({ key: "staff", name: admin ? "Jaycord Admin" : "Jaycord Staff", image: admin ? config.jaycordAdminBadgeUrl : config.jaycordStaffBadgeUrl, movable: false, subtitle: "Official Jaycord badge" });
  }
  for (const badge of user.badges.filter((item) => !item.pending)) badges.push({ key: `custom:${badge.id}`, name: badge.name, image: publicImageUrl(badge.filename, origin), movable: true, subtitle: "Jadges badge" });
  if (user.nitro && !user.nitro.pending && user.nitro.preset !== "remove") { const preset = NITRO_PRESETS[user.nitro.preset]; badges.push({ key: "nitro", name: `${preset.label} Nitro`, image: preset.profileIcon, movable: true, subtitle: "Jadges Nitro badge" }) }
  for (const badge of user.nativeBadges || []) if (nativeBadgeIsVisible(user, badge.key)) badges.push({ key: badge.key, name: badge.name, image: badge.image, movable: true, subtitle: "Native Discord badge" });
  const nativeBadges = badges.filter((badge) => badge.key.startsWith("discord:")).length;
  const pendingReviews = user.badges.filter((badge) => badge.pending).length + (user.pendingNitro || user.nitro?.pending ? 1 : 0);
  const displayName = discordUser.global_name?.trim() || discordUser.username?.trim() || "Discord User";
  const username = discordUser.username?.trim() || "discord-user";
  return { profile: { id: userId, displayName, username, avatar: discordAvatar(discordUser) }, badges, order: orderedMovableKeys(user), side: user.badgeSide === "left" ? "left" : "right", hasNativeBadges: nativeBadges > 0, stats: { totalBadges: badges.length, nativeBadges, pendingReviews, pluginVersion: 20 } };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > MAX_BODY_SIZE) throw new Error("Request body is too large"); chunks.push(buffer) }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function startWebsiteLogin(response: ServerResponse): Promise<void> {
  if (!config.discordClientSecret) { sendHtml(response, 503, errorPage("Login unavailable", "Discord OAuth has not been configured for Jadges yet.")); return }
  const state = signPayload({ kind: "website-state", expiresAt: Date.now() + WEBSITE_STATE_MS, nonce: randomBytes(12).toString("hex") });
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", config.clientId); authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", `${config.publicUrl}/oauth/callback`); authorize.searchParams.set("scope", "identify"); authorize.searchParams.set("state", state); authorize.searchParams.set("prompt", "none");
  redirect(response, authorize.toString());
}

async function handleWebsiteCallback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const state = verifyPayload<WebsiteStatePayload>(url.searchParams.get("state"), "website-state");
  if (!state) return false;
  const code = url.searchParams.get("code");
  if (!code || !config.discordClientSecret) { sendHtml(response, 400, errorPage("Login failed", "Discord authorization could not be verified.")); return true }
  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.discordClientSecret, grant_type: "authorization_code", code, redirect_uri: `${config.publicUrl}/oauth/callback` }), signal: AbortSignal.timeout(15_000) });
  if (!tokenResponse.ok) { sendHtml(response, 502, errorPage("Login failed", "Discord rejected the authorization request.")); return true }
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) { sendHtml(response, 502, errorPage("Login failed", "Discord did not return an access token.")); return true }
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000) });
  const user = userResponse.ok ? await userResponse.json() as DiscordUser : undefined;
  if (!user?.id) { sendHtml(response, 502, errorPage("Login failed", "Discord could not verify your account.")); return true }
  response.setHeader("set-cookie", sessionCookie(user.id)); redirect(response, "/dashboard"); return true;
}

export async function handleWebsiteRequest(request: IncomingMessage, response: ServerResponse, url: URL, origin: string, resolveSystemStaffBadge: ResolveSystemStaffBadge): Promise<boolean> {
  if (url.pathname === "/assets/jadges.css" || url.pathname === "/assets/jadges.js") {
    if (request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return true }
    await serveAsset(response, url.pathname.endsWith(".css") ? "jadges.css" : "jadges.js"); return true;
  }
  if (url.pathname === "/oauth/callback") return handleWebsiteCallback(request, response, url);
  if (url.pathname === "/") { if (request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return true } sendHtml(response, 200, landingPage(Boolean(sessionUserId(request)))); return true }
  if (url.pathname === "/login") { if (request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return true } if (sessionUserId(request)) redirect(response, "/dashboard"); else await startWebsiteLogin(response); return true }
  if (url.pathname === "/logout") { if (request.method !== "POST" && request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return true } response.setHeader("set-cookie", clearSessionCookie()); redirect(response, "/"); return true }
  if (url.pathname === "/dashboard") {
    if (request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return true }
    const userId = sessionUserId(request); if (!userId) { redirect(response, "/login"); return true }
    sendHtml(response, 200, dashboardPage(await buildDashboardData(userId, origin, resolveSystemStaffBadge))); return true;
  }
  if (url.pathname === "/api/dashboard") {
    const userId = sessionUserId(request); if (!userId) { sendJson(response, 401, { error: "Login required" }); return true }
    if (request.method === "GET") { sendJson(response, 200, await buildDashboardData(userId, origin, resolveSystemStaffBadge)); return true }
    if (request.method !== "POST") { sendJson(response, 405, { error: "Method not allowed" }); return true }
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== origin && requestOrigin !== config.publicUrl) { sendJson(response, 403, { error: "Origin check failed" }); return true }
    try {
      const body = await readJson(request) as { order?: unknown; side?: unknown };
      const user = await getUser(userId);
      if (body.order !== undefined) {
        if (!Array.isArray(body.order) || !body.order.every((item) => typeof item === "string")) throw new Error("Invalid badge order");
        const available = orderedMovableKeys(user); const availableSet = new Set(available); const supplied = [...new Set(body.order)];
        if (supplied.some((value) => !availableSet.has(value))) throw new Error("One of those badges is no longer available");
        await setBadgeOrder(userId, [...supplied, ...available.filter((value) => !supplied.includes(value))]);
      }
      if (body.side !== undefined) { if (body.side !== "left" && body.side !== "right") throw new Error("Invalid badge placement"); await setBadgeSide(userId, body.side) }
      sendJson(response, 200, await buildDashboardData(userId, origin, resolveSystemStaffBadge));
    } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request" }) }
    return true;
  }
  return false;
}
