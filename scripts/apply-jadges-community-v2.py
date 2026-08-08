from pathlib import Path
import re


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"Expected text not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str):
    p = Path(path)
    text = p.read_text()
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"Expected one regex match in {path}, got {count}: {pattern[:120]!r}")
    p.write_text(next_text)


def append_once(path: str, marker: str, addition: str):
    p = Path(path)
    text = p.read_text()
    if marker in text:
        return
    p.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n")


# ---------------------------------------------------------------------------
# New shared rarity helpers
# ---------------------------------------------------------------------------
Path("src/badgeRarity.ts").write_text(r'''import type { BadgeRarity } from "./types.js";

export const PUBLIC_BADGE_RARITIES: BadgeRarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
];

export const STAFF_BADGE_RARITIES: BadgeRarity[] = [
  "exclusive",
  "limited",
  "staff",
  "event",
  "quest",
];

export const ALL_BADGE_RARITIES: BadgeRarity[] = [
  ...PUBLIC_BADGE_RARITIES,
  ...STAFF_BADGE_RARITIES,
];

export const BADGE_RARITY_CHOICES = ALL_BADGE_RARITIES.map((value) => ({
  name: value[0]!.toUpperCase() + value.slice(1),
  value,
}));

export function isBadgeRarity(value: unknown): value is BadgeRarity {
  return typeof value === "string" && ALL_BADGE_RARITIES.includes(value as BadgeRarity);
}

export function isStaffBadgeRarity(value: BadgeRarity): boolean {
  return STAFF_BADGE_RARITIES.includes(value);
}

export function rarityLabel(value: BadgeRarity | undefined): string {
  const rarity = value && isBadgeRarity(value) ? value : "common";
  return rarity[0]!.toUpperCase() + rarity.slice(1);
}
''')


# ---------------------------------------------------------------------------
# Preset reactions data store
# ---------------------------------------------------------------------------
Path("src/presetReactions.ts").write_text(r'''import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type PresetReactionKind = "like" | "favorite";

interface PresetReactionRecord {
  likedBy: string[];
  favoritedBy: string[];
}

interface PresetReactionStore {
  presets: Record<string, PresetReactionRecord>;
}

export interface PresetReactionSummary {
  likes: number;
  favorites: number;
  liked: boolean;
  favorited: boolean;
}

const STORE_FILE = path.join(config.dataDir, "preset-reactions.json");
let writeQueue: Promise<void> = Promise.resolve();

async function readUnsafe(): Promise<PresetReactionStore> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, "utf8")) as PresetReactionStore;
    parsed.presets ??= {};
    for (const record of Object.values(parsed.presets)) {
      record.likedBy = Array.isArray(record.likedBy)
        ? [...new Set(record.likedBy.filter((id) => typeof id === "string"))]
        : [];
      record.favoritedBy = Array.isArray(record.favoritedBy)
        ? [...new Set(record.favoritedBy.filter((id) => typeof id === "string"))]
        : [];
    }
    return parsed;
  } catch {
    return { presets: {} };
  }
}

async function writeUnsafe(store: PresetReactionStore): Promise<void> {
  const temporary = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, STORE_FILE);
}

async function mutate<T>(operation: (store: PresetReactionStore) => T): Promise<T> {
  const promise = writeQueue.then(async () => {
    const store = await readUnsafe();
    const result = operation(store);
    await writeUnsafe(store);
    return result;
  });
  writeQueue = promise.then(() => undefined, () => undefined);
  return promise;
}

function summary(record: PresetReactionRecord | undefined, userId?: string): PresetReactionSummary {
  const likedBy = record?.likedBy || [];
  const favoritedBy = record?.favoritedBy || [];
  return {
    likes: likedBy.length,
    favorites: favoritedBy.length,
    liked: Boolean(userId && likedBy.includes(userId)),
    favorited: Boolean(userId && favoritedBy.includes(userId)),
  };
}

export async function getPresetReactionSummary(
  presetId: string,
  userId?: string,
): Promise<PresetReactionSummary> {
  await writeQueue;
  return summary((await readUnsafe()).presets[presetId], userId);
}

export async function getPresetReactionSummaries(
  presetIds: string[],
  userId?: string,
): Promise<Record<string, PresetReactionSummary>> {
  await writeQueue;
  const store = await readUnsafe();
  const result: Record<string, PresetReactionSummary> = {};
  for (const presetId of [...new Set(presetIds)].slice(0, 100)) {
    result[presetId] = summary(store.presets[presetId], userId);
  }
  return result;
}

export async function togglePresetReaction(
  userId: string,
  presetId: string,
  kind: PresetReactionKind,
): Promise<PresetReactionSummary> {
  return mutate((store) => {
    const record = store.presets[presetId] ??= { likedBy: [], favoritedBy: [] };
    const target = kind === "like" ? record.likedBy : record.favoritedBy;
    const index = target.indexOf(userId);
    if (index === -1) target.push(userId);
    else target.splice(index, 1);
    return summary(record, userId);
  });
}

export async function countAllPresetReactions(): Promise<{ likes: number; favorites: number }> {
  await writeQueue;
  const store = await readUnsafe();
  let likes = 0;
  let favorites = 0;
  for (const record of Object.values(store.presets)) {
    likes += record.likedBy.length;
    favorites += record.favoritedBy.length;
  }
  return { likes, favorites };
}
''')


# ---------------------------------------------------------------------------
# Web community APIs: stats, global search, creator profiles, preset reactions
# ---------------------------------------------------------------------------
Path("src/communityFeatures.ts").write_text(r'''import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { config } from "./config.js";
import { rarityLabel } from "./badgeRarity.js";
import {
  countAllPresetReactions,
  getPresetReactionSummaries,
  togglePresetReaction,
} from "./presetReactions.js";
import { findPreset, listPresets, presetImageUrl } from "./presetStore.js";
import {
  discordBotUser,
  originAllowed,
  sendJson,
  sessionUserId,
} from "./presetWeb.js";
import { publicImageUrl } from "./storage.js";
import { readStore } from "./store.js";
import type { BadgeRecord, BadgeRarity, UserRecord } from "./types.js";

let installed = false;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(html);
}

function rarityOf(badge: BadgeRecord): BadgeRarity {
  return badge.rarity || "common";
}

function approvedBadges(user: UserRecord): BadgeRecord[] {
  return (user.badges || []).filter((badge) => !badge.pending);
}

function animatedBadge(badge: BadgeRecord): boolean {
  return badge.mimeType === "image/gif"
    || badge.mimeType === "image/apng"
    || badge.mimeType === "image/webp";
}

async function globalStats(): Promise<Record<string, unknown>> {
  const [store, presets, reactions] = await Promise.all([
    readStore(),
    listPresets(),
    countAllPresetReactions(),
  ]);
  const users = Object.values(store.users);
  const approved = users.flatMap(approvedBadges);
  const pending = users.flatMap((user) => user.badges || []).filter((badge) => badge.pending);
  const rarity: Record<string, number> = {};
  for (const badge of approved) {
    const key = rarityOf(badge);
    rarity[key] = (rarity[key] || 0) + 1;
  }
  return {
    users: users.length,
    approvedBadges: approved.length,
    pendingBadges: pending.length,
    animatedBadges: approved.filter(animatedBadge).length,
    presets: presets.length,
    presetClaims: presets.reduce((sum, preset) => sum + preset.claims, 0),
    presetLikes: reactions.likes,
    presetFavorites: reactions.favorites,
    rarity,
  };
}

async function searchBadges(query: string): Promise<Array<Record<string, unknown>>> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const [store, presets] = await Promise.all([readStore(), listPresets()]);
  const result = new Map<string, Record<string, unknown>>();

  for (const [ownerId, user] of Object.entries(store.users)) {
    for (const badge of approvedBadges(user)) {
      if (!badge.name.toLowerCase().includes(normalized)) continue;
      const creatorId = badge.creatorId || (badge.id.startsWith("quest:") ? undefined : ownerId);
      const dedupe = `${creatorId || "system"}:${badge.name.toLowerCase()}:${rarityOf(badge)}`;
      if (result.has(dedupe)) continue;
      result.set(dedupe, {
        name: badge.name,
        rarity: rarityOf(badge),
        creatorId,
        ownerId,
        badge: publicImageUrl(badge.filename),
        animated: animatedBadge(badge),
        creatorProfile: creatorId ? `${config.publicUrl}/creators/${creatorId}` : undefined,
        source: badge.id.startsWith("preset-") ? "preset" : badge.id.startsWith("quest:") ? "quest" : "custom",
      });
      if (result.size >= 25) break;
    }
    if (result.size >= 25) break;
  }

  if (result.size < 25) {
    for (const preset of presets) {
      if (!preset.name.toLowerCase().includes(normalized)) continue;
      const dedupe = `${preset.uploaderId}:${preset.name.toLowerCase()}:common`;
      if (result.has(dedupe)) continue;
      result.set(dedupe, {
        name: preset.name,
        rarity: "common",
        creatorId: preset.uploaderId,
        badge: `${config.publicUrl}${presetImageUrl(preset)}`,
        animated: preset.mimeType === "image/gif" || preset.mimeType === "image/apng" || preset.mimeType === "image/webp",
        creatorProfile: `${config.publicUrl}/creators/${preset.uploaderId}`,
        source: "preset",
        claims: preset.claims,
      });
      if (result.size >= 25) break;
    }
  }

  return [...result.values()];
}

async function creatorData(userId: string): Promise<Record<string, unknown>> {
  const [store, presets, profile] = await Promise.all([
    readStore(),
    listPresets(),
    discordBotUser(userId).catch(() => ({ id: userId, username: `user-${userId.slice(-4)}`, global_name: null, avatar: null })),
  ]);
  const user = store.users[userId] || { blocked: false, badges: [] };
  const badges = approvedBadges(user)
    .filter((badge) => !badge.id.startsWith("preset-") && !badge.id.startsWith("quest:"))
    .map((badge) => ({
      name: badge.name,
      rarity: rarityOf(badge),
      image: publicImageUrl(badge.filename),
      animated: animatedBadge(badge),
      createdAt: badge.createdAt,
    }));
  const createdPresets = presets
    .filter((preset) => preset.uploaderId === userId)
    .map((preset) => ({
      id: preset.id,
      name: preset.name,
      image: presetImageUrl(preset),
      claims: preset.claims,
    }));
  const displayName = profile.global_name?.trim() || profile.username?.trim() || `User ${userId.slice(-4)}`;
  return {
    id: userId,
    username: profile.username || "discord-user",
    displayName,
    badges,
    presets: createdPresets,
    badgeCount: badges.length,
    presetCount: createdPresets.length,
  };
}

function creatorPage(data: any): string {
  const badges = data.badges as Array<any>;
  const presets = data.presets as Array<any>;
  const badgeCards = badges.length
    ? badges.map((badge) => `<article class="card"><img src="${escapeHtml(badge.image)}" alt=""><div><strong>${escapeHtml(badge.name)}</strong><span class="rarity rarity-${escapeHtml(badge.rarity)}">${escapeHtml(rarityLabel(badge.rarity))}</span></div></article>`).join("")
    : '<p class="empty">No public custom badges created yet.</p>';
  const presetCards = presets.length
    ? presets.map((preset) => `<a class="card" href="/presets/${encodeURIComponent(preset.id)}"><img src="${escapeHtml(preset.image)}" alt=""><div><strong>${escapeHtml(preset.name)}</strong><span>${preset.claims} claim${preset.claims === 1 ? "" : "s"}</span></div></a>`).join("")
    : '<p class="empty">No community presets created yet.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.displayName)} — Jadges Creator</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#080b10;color:#f4f5f7}.shell{width:min(1040px,calc(100% - 32px));margin:auto;padding:44px 0 72px}.back{color:#aeb5c2;text-decoration:none}.hero{margin-top:28px;padding:28px;border:1px solid #282d36;border-radius:20px;background:linear-gradient(145deg,#171a21,#11141a)}.eyebrow{color:#8d7cff;font-size:12px;font-weight:850;text-transform:uppercase;letter-spacing:.14em}.hero h1{font-size:38px;margin:8px 0 4px}.hero p{margin:0;color:#9ca4b2}.stats{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}.pill{padding:8px 11px;border-radius:999px;background:#20242d;color:#d9dde5;font-size:13px}.section{margin-top:34px}.section h2{font-size:21px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}.card{min-height:78px;display:flex;align-items:center;gap:14px;padding:14px;border:1px solid #282d36;border-radius:15px;background:#13161c;color:inherit;text-decoration:none}.card img{width:48px;height:48px;object-fit:contain}.card div{display:grid;gap:5px}.card span{color:#929aa7;font-size:12px}.rarity{font-weight:800}.rarity-common{color:#b7bdc8}.rarity-uncommon{color:#57d68d}.rarity-rare{color:#5ea0ff}.rarity-epic{color:#b978ff}.rarity-legendary{color:#ffbd4a}.rarity-exclusive{color:#ff6ea9}.rarity-limited{color:#ff8a5b}.rarity-staff{color:#59e1dc}.rarity-event{color:#f27cff}.rarity-quest{color:#7bd7ff}.empty{color:#8f98a7}</style></head><body><main class="shell"><a class="back" href="/">← Jadges</a><section class="hero"><div class="eyebrow">Creator Profile</div><h1>${escapeHtml(data.displayName)}</h1><p>@${escapeHtml(data.username)}</p><div class="stats"><span class="pill">${data.badgeCount} custom badge${data.badgeCount === 1 ? "" : "s"}</span><span class="pill">${data.presetCount} preset${data.presetCount === 1 ? "" : "s"}</span></div></section><section class="section"><h2>Created badges</h2><div class="grid">${badgeCards}</div></section><section class="section"><h2>Community presets</h2><div class="grid">${presetCards}</div></section></main></body></html>`;
}

function searchPage(query: string, results: Array<any>): string {
  const cards = results.length
    ? results.map((item) => `<article class="result"><img src="${escapeHtml(item.badge)}" alt=""><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(rarityLabel(item.rarity))} · ${escapeHtml(item.source)}</span>${item.creatorProfile ? `<a href="${escapeHtml(item.creatorProfile)}">Creator profile</a>` : ""}</div></article>`).join("")
    : query ? '<p class="empty">No matching badges.</p>' : '<p class="empty">Search the global Jadges badge directory.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Badge Search — Jadges</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#080b10;color:#f4f5f7}.shell{width:min(850px,calc(100% - 32px));margin:auto;padding:42px 0}.back,a{color:#9b8cff}.hero{margin:28px 0}.hero h1{font-size:36px;margin:0 0 8px}.hero p,.empty{color:#929aa7}.search{display:flex;gap:10px}.search input{flex:1;height:46px;border:1px solid #303641;border-radius:12px;background:#12151b;color:#fff;padding:0 14px;font:inherit}.search button{border:0;border-radius:12px;background:#5865f2;color:#fff;padding:0 18px;font-weight:800}.results{display:grid;gap:10px;margin-top:24px}.result{display:flex;gap:15px;align-items:center;padding:14px;border:1px solid #282d36;border-radius:14px;background:#13161c}.result img{width:46px;height:46px;object-fit:contain}.result div{display:grid;gap:4px}.result span{font-size:12px;color:#959dac}.result a{font-size:12px;text-decoration:none}</style></head><body><main class="shell"><a class="back" href="/">← Jadges</a><section class="hero"><h1>Global Badge Search</h1><p>Find approved badges and their creators across Jadges.</p></section><form class="search"><input name="q" value="${escapeHtml(query)}" placeholder="Search badge names" maxlength="64"><button>Search</button></form><section class="results">${cards}</section></main></body></html>`;
}

function reactionClientScript(): string {
  return `<style id="jadges-preset-reaction-style">.jadges-reactions{display:flex;gap:9px;flex-wrap:wrap;margin-top:13px}.jadges-reaction{border:1px solid #353b49;border-radius:10px;background:#171c27;color:#dce1eb;padding:8px 11px;font:inherit;font-size:13px;font-weight:750;cursor:pointer}.jadges-reaction.active{border-color:#7c5cff;background:#282050;color:#fff}.preset-reaction-counts{display:block;margin-top:4px;color:#9ba5b7;font-size:11px}</style><script>(()=>{const api='/api/preset-reactions';async function summaries(ids){if(!ids.length)return{};const r=await fetch(api+'?ids='+encodeURIComponent(ids.join(',')),{cache:'no-store'});return r.ok?(await r.json()).presets||{}:{}}async function cards(){const nodes=[...document.querySelectorAll('a.preset-card[href^="/presets/"]')];const ids=nodes.map(n=>n.getAttribute('href').split('/').pop()).filter(Boolean);const data=await summaries(ids);nodes.forEach(n=>{const id=n.getAttribute('href').split('/').pop(),s=data[id];if(!s)return;const meta=n.querySelector('.preset-card-meta');if(meta&&!meta.querySelector('.preset-reaction-counts'))meta.insertAdjacentHTML('beforeend','<span class="preset-reaction-counts">♥ '+s.likes+' · ★ '+s.favorites+'</span>')})}async function detail(){const m=location.pathname.match(/^\\/presets\\/([a-f0-9-]+)$/);if(!m)return;const id=m[1],data=await summaries([id]),s=data[id];const claim=document.getElementById('get-preset-badge');if(!claim||!s)return;const wrap=document.createElement('div');wrap.className='jadges-reactions';const like=document.createElement('button'),fav=document.createElement('button');like.type=fav.type='button';like.className='jadges-reaction'+(s.liked?' active':'');fav.className='jadges-reaction'+(s.favorited?' active':'');wrap.append(like,fav);claim.insertAdjacentElement('afterend',wrap);function paint(x){like.textContent='♥ '+x.likes+' Like'+(x.likes===1?'':'s');fav.textContent='★ '+x.favorites+' Favorite'+(x.favorites===1?'':'s');like.classList.toggle('active',x.liked);fav.classList.toggle('active',x.favorited)}paint(s);async function toggle(kind){const r=await fetch('/api/presets/'+id+'/'+kind,{method:'POST'});const j=await r.json();if(r.ok)paint(j.summary);else alert(j.error||'Could not update preset')}like.onclick=()=>toggle('like');fav.onclick=()=>toggle('favorite')}cards();detail()})();</script>`;
}

function wrapPresetHtml(listener: RequestListener, pathname: string): RequestListener {
  return (request, response) => {
    const originalEnd = response.end.bind(response);
    let ended = false;
    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (ended) return response;
      ended = true;
      if (chunk === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        originalEnd(chunk, encoding, callback);
        return response;
      }
      const body = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
      if (!body.includes("</body>")) {
        originalEnd(chunk, encoding, callback);
        return response;
      }
      const next = body.replace("</body>", `${reactionClientScript()}</body>`);
      response.removeHeader("content-length");
      originalEnd(next, "utf8", callback);
      return response;
    }) as typeof response.end;
    listener(request, response);
  };
}

async function handleCommunityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/badges/stats") {
    sendJson(response, 200, await globalStats());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/badges/search") {
    sendJson(response, 200, { results: await searchBadges(url.searchParams.get("q") || "") });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/badge-search") {
    const query = (url.searchParams.get("q") || "").slice(0, 64);
    sendHtml(response, 200, searchPage(query, await searchBadges(query)));
    return true;
  }

  const creatorApi = /^\/api\/creators\/(\d{15,22})$/.exec(url.pathname);
  if (request.method === "GET" && creatorApi?.[1]) {
    sendJson(response, 200, await creatorData(creatorApi[1]));
    return true;
  }
  const creator = /^\/creators\/(\d{15,22})$/.exec(url.pathname);
  if (request.method === "GET" && creator?.[1]) {
    sendHtml(response, 200, creatorPage(await creatorData(creator[1])));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/preset-reactions") {
    const ids = (url.searchParams.get("ids") || "")
      .split(",")
      .filter((id) => /^[a-f0-9-]+$/.test(id))
      .slice(0, 100);
    sendJson(response, 200, {
      presets: await getPresetReactionSummaries(ids, sessionUserId(request)),
    });
    return true;
  }

  const reaction = /^\/api\/presets\/([a-f0-9-]+)\/(like|favorite)$/.exec(url.pathname);
  if (reaction?.[1] && reaction?.[2]) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const userId = sessionUserId(request);
    if (!userId) {
      sendJson(response, 401, { error: "Login required" });
      return true;
    }
    if (!originAllowed(request, origin)) {
      sendJson(response, 403, { error: "Origin check failed" });
      return true;
    }
    if (!await findPreset(reaction[1])) {
      sendJson(response, 404, { error: "Preset not found" });
      return true;
    }
    const summary = await togglePresetReaction(userId, reaction[1], reaction[2] as "like" | "favorite");
    sendJson(response, 200, { summary });
    return true;
  }

  return false;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", config.publicUrl);
    const origin = `${url.protocol}//${request.headers.host || url.host}`;
    void handleCommunityRequest(request, response, url, origin)
      .then((handled) => {
        if (handled) return;
        if (
          request.method === "GET"
          && (url.pathname === "/presets" || /^\/presets\/[a-f0-9-]+$/.test(url.pathname))
        ) {
          wrapPresetHtml(listener, url.pathname)(request, response);
          return;
        }
        listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges community feature error:", error);
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        if (!response.writableEnded) response.end(JSON.stringify({ error: "Community feature failed" }));
      });
  };
}

export function installCommunityFeatures(): void {
  if (installed) return;
  installed = true;
  const mutable = http as typeof http & { createServer: (...args: any[]) => http.Server };
  const original = mutable.createServer.bind(http) as (...args: any[]) => http.Server;
  mutable.createServer = ((...args: any[]): http.Server => {
    const listenerIndex = typeof args[0] === "function" ? 0 : typeof args[1] === "function" ? 1 : -1;
    if (listenerIndex !== -1) args[listenerIndex] = wrap(args[listenerIndex] as RequestListener);
    return original(...args);
  }) as typeof http.createServer;
}
''')


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
replace_once(
    "src/types.ts",
    'export type BadgeSide = "left" | "right";\nexport type StaffBadgeMode = "default" | "admin";',
    '''export type BadgeSide = "left" | "right";\nexport type BadgeRarity =\n  | "common"\n  | "uncommon"\n  | "rare"\n  | "epic"\n  | "legendary"\n  | "exclusive"\n  | "limited"\n  | "staff"\n  | "event"\n  | "quest";\nexport type BadgeAnimationMode = "always" | "hover" | "off";\nexport type StaffBadgeMode = "default" | "admin";''',
)
replace_once(
    "src/types.ts",
    '  approvedAt?: string;\n  /** Legacy field kept so presets submitted before the separate command still work. */',
    '''  approvedAt?: string;\n  /** Badge-directory rarity. Existing records default to common. */\n  rarity?: BadgeRarity;\n  /** Original creator when a badge was claimed from a community preset. */\n  creatorId?: string;\n  /** Legacy field kept so presets submitted before the separate command still work. */''',
)
replace_once(
    "src/types.ts",
    '  badgeSide?: BadgeSide;\n  /** Native Discord badges last observed by an updated Jadges client. */',
    '''  badgeSide?: BadgeSide;\n  /** Controls animated badge playback for supported Jadges clients. */\n  badgeAnimationMode?: BadgeAnimationMode;\n  /** Native Discord badges last observed by an updated Jadges client. */''',
)
replace_once(
    "src/types.ts",
    '  createdAt?: string;\n  side?: BadgeSide;\n  nitro?: PublicNitroPreset;',
    '''  createdAt?: string;\n  side?: BadgeSide;\n  rarity?: BadgeRarity;\n  creatorId?: string;\n  animated?: boolean;\n  /** First-frame PNG used when animation is off or hover-only. */\n  staticBadge?: string;\n  nitro?: PublicNitroPreset;''',
)
replace_once(
    "src/types.ts",
    '  nativeBadges?: PublicNativeBadge[];\n}',
    '''  nativeBadges?: PublicNativeBadge[];\n  animationMode?: BadgeAnimationMode;\n}''',
)


# ---------------------------------------------------------------------------
# Store normalization and animation setting
# ---------------------------------------------------------------------------
replace_once(
    "src/store.ts",
    'import { config } from "./config.js";',
    'import { config } from "./config.js";\nimport { isBadgeRarity } from "./badgeRarity.js";',
)
replace_once(
    "src/store.ts",
    '  BadgeRecord,\n  BadgeSide,',
    '  BadgeAnimationMode,\n  BadgeRecord,\n  BadgeSide,',
)
replace_once(
    "src/store.ts",
    '  user.badges ??= [];\n\n  if (user.badgeOrder',
    '''  user.badges ??= [];\n  for (const badge of user.badges) {\n    if (!isBadgeRarity(badge.rarity)) badge.rarity = "common";\n    if (!badge.creatorId && !badge.id.startsWith("quest:") && !badge.id.startsWith("preset-")) {\n      badge.creatorId = badge.userId;\n    }\n  }\n\n  if (user.badgeAnimationMode !== "always" && user.badgeAnimationMode !== "hover" && user.badgeAnimationMode !== "off") {\n    delete user.badgeAnimationMode;\n  }\n\n  if (user.badgeOrder''',
)
append_once(
    "src/store.ts",
    "export async function setBadgeAnimationMode",
    r'''export async function setBadgeAnimationMode(
  userId: string,
  mode: BadgeAnimationMode,
): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    user.badgeAnimationMode = mode;
  });
}''',
)


# ---------------------------------------------------------------------------
# Preset claims keep original creator and default rarity
# ---------------------------------------------------------------------------
replace_once(
    "src/presetStore.ts",
    '      approvedAt: now,\n    };',
    '      approvedAt: now,\n      rarity: "common",\n      creatorId: preset.uploaderId,\n    };',
)


# ---------------------------------------------------------------------------
# Quest system rarity
# ---------------------------------------------------------------------------
replace_once(
    "src/badgeQuests.ts",
    '    approvedAt: now,\n  };',
    '    approvedAt: now,\n    rarity: "quest",\n  };',
)


# ---------------------------------------------------------------------------
# Server public badge payload + static first-frame endpoint
# ---------------------------------------------------------------------------
replace_once(
    "src/server.ts",
    'function toPublicBadge(\n  badge: BadgeRecord,',
    '''function badgeIsAnimated(badge: BadgeRecord): boolean {\n  return badge.mimeType === "image/gif"\n    || badge.mimeType === "image/apng"\n    || badge.mimeType === "image/webp";\n}\n\nfunction staticBadgeUrl(filename: string, origin: string): string {\n  return `${origin.replace(/\\/$/, "")}/badge-previews/${encodeURIComponent(filename)}.png`;\n}\n\nfunction toPublicBadge(\n  badge: BadgeRecord,''',
)
replace_once(
    "src/server.ts",
    '    createdAt: badge.createdAt,\n    side,\n  };',
    '''    createdAt: badge.createdAt,\n    side,\n    rarity: badge.rarity || "common",\n    creatorId: badge.creatorId || (badge.id.startsWith("quest:") ? undefined : badge.userId),\n    animated: badgeIsAnimated(badge),\n    staticBadge: badgeIsAnimated(badge) ? staticBadgeUrl(badge.filename, origin) : undefined,\n  };''',
)
replace_once(
    "src/server.ts",
    '    nativeBadges: (user.nativeBadges || []).map((badge) => ({',
    '    animationMode: user.badgeAnimationMode || "always",\n    nativeBadges: (user.nativeBadges || []).map((badge) => ({',
)
replace_once(
    "src/server.ts",
    '      pending: false,\n      side,\n    });\n  }\n\n  // Always include a settings record',
    '      pending: false,\n      side,\n      rarity: "staff",\n    });\n  }\n\n  // Always include a settings record',
)
replace_once(
    "src/server.ts",
    'async function serveImage(\n  response: http.ServerResponse,',
    r'''async function serveBadgePreview(
  response: http.ServerResponse,
  encodedFilename: string,
): Promise<void> {
  const filename = decodeURIComponent(encodedFilename).replace(/\.png$/i, "");
  if (!allowedFile.test(filename)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  try {
    const input = path.join(config.imagesDir, filename);
    const png = await sharp(input, { animated: false, page: 0 })
      .png()
      .toBuffer();
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": png.length,
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=86400",
    });
    response.end(png);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function serveImage(
  response: http.ServerResponse,''',
)
replace_once(
    "src/server.ts",
    '      if (url.pathname.startsWith("/badges/")) {',
    '''      if (url.pathname.startsWith("/badge-previews/")) {\n        await serveBadgePreview(\n          response,\n          url.pathname.slice("/badge-previews/".length),\n        );\n        return;\n      }\n\n      if (url.pathname.startsWith("/badges/")) {''',
)


# ---------------------------------------------------------------------------
# Settings feed gets animation mode
# ---------------------------------------------------------------------------
replace_once(
    "src/rearrange.ts",
    'interface PublicBadgeSettings {\n  side?: BadgeSide;',
    'interface PublicBadgeSettings {\n  side?: BadgeSide;\n  animationMode?: "always" | "hover" | "off";',
)
replace_once(
    "src/rearrange.ts",
    '        !user.badgeSide &&\n        !user.badgeOrder?.length &&',
    '        !user.badgeSide &&\n        !user.badgeAnimationMode &&\n        !user.badgeOrder?.length &&',
)
replace_once(
    "src/rearrange.ts",
    '      result[userId] = {\n        side: user.badgeSide,',
    '      result[userId] = {\n        side: user.badgeSide,\n        animationMode: user.badgeAnimationMode || "always",',
)


# ---------------------------------------------------------------------------
# Discord rarity autocomplete + commands
# ---------------------------------------------------------------------------
replace_once(
    "src/discord.ts",
    'import { config } from "./config.js";',
    '''import { config } from "./config.js";\nimport {\n  BADGE_RARITY_CHOICES,\n  isBadgeRarity,\n  isStaffBadgeRarity,\n  rarityLabel,\n} from "./badgeRarity.js";''',
)
replace_once(
    "src/discord.ts",
    '  getUser,\n  removeBadgeById,',
    '  getOrCreateUser,\n  getUser,\n  mutateStore,\n  readStore,\n  removeBadgeById,',
)
replace_once(
    "src/discord.ts",
    '  setBlocked,\n  setStaffBadgeMode,',
    '  setBadgeAnimationMode,\n  setBlocked,\n  setStaffBadgeMode,',
)
replace_once(
    "src/discord.ts",
    'import type { BadgeRecord, NitroRecord } from "./types.js";',
    'import type { BadgeRecord, NitroRecord } from "./types.js";\nimport { listPresets } from "./presetStore.js";',
)
replace_once(
    "src/discord.ts",
    '      )\n      .addAttachmentOption((option) =>',
    '''      )\n      .addStringOption((option) =>\n        option\n          .setName("rarity")\n          .setDescription("Choose the badge rarity")\n          .setAutocomplete(true)\n          .setRequired(true),\n      )\n      .addAttachmentOption((option) =>''',
)
replace_once(
    "src/discord.ts",
    '  .addSubcommandGroup((group) =>',
    r'''  .addSubcommand((subcommand) =>
    subcommand
      .setName("animation")
      .setDescription("Choose how animated badges play")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Animated badge playback")
          .addChoices(
            { name: "Always animate", value: "always" },
            { name: "Animate on hover", value: "hover" },
            { name: "Animation off", value: "off" },
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("theme")
      .setDescription("Apply a Jadges profile theme preset")
      .addStringOption((option) =>
        option
          .setName("preset")
          .setDescription("Profile theme")
          .addChoices(
            { name: "Default", value: "default" },
            { name: "Dark", value: "dark" },
            { name: "Purple", value: "purple" },
            { name: "Gold", value: "gold" },
            { name: "Glass", value: "glass" },
            { name: "AMOLED", value: "amoled" },
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("stats").setDescription("View global Jadges badge statistics"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("search")
      .setDescription("Search the global Jadges badge directory")
      .addStringOption((option) =>
        option
          .setName("query")
          .setDescription("Badge name to search for")
          .setMaxLength(64)
          .setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>''',
)
replace_once(
    "src/discord.ts",
    '    .addFields(\n      { name: "Badge name", value: badge.name },\n      { name: "Badge ID", value: badge.id },',
    '    .addFields(\n      { name: "Badge name", value: badge.name },\n      { name: "Rarity", value: rarityLabel(badge.rarity) },\n      { name: "Badge ID", value: badge.id },',
)
replace_once(
    "src/discord.ts",
    '  const name = cleanName(interaction.options.getString("name", true));\n  const attachment = interaction.options.getAttachment("image", true) as Attachment;',
    r'''  const name = cleanName(interaction.options.getString("name", true));
  const selectedRarity = interaction.options.getString("rarity", true).toLowerCase();
  if (!isBadgeRarity(selectedRarity)) {
    await interaction.editReply("That rarity is not available. Choose one of the listed options.");
    return;
  }
  if (isStaffBadgeRarity(selectedRarity) && !hasRole(interaction, JAYCORD_STAFF_ROLE_ID)) {
    await interaction.editReply("That rarity is reserved for Jadges staff-awarded badges.");
    return;
  }
  const attachment = interaction.options.getAttachment("image", true) as Attachment;''',
)
replace_once(
    "src/discord.ts",
    '      pending: true,\n      createdAt: new Date().toISOString(),',
    '      pending: true,\n      createdAt: new Date().toISOString(),\n      rarity: selectedRarity,\n      creatorId: userId,',
)
replace_once(
    "src/discord.ts",
    '  const lines = user.badges.map(\n    (badge) => `• **${badge.name}**${badge.pending ? " — pending" : ""}`,\n  );',
    '  const lines = user.badges.map(\n    (badge) => `• **${badge.name}** — ${rarityLabel(badge.rarity)}${badge.pending ? " — pending" : ""}`,\n  );',
)
# Insert new command handlers before setUserBlock.
replace_once(
    "src/discord.ts",
    'async function setUserBlock(\n  interaction: ChatInputCommandInteraction,',
    r'''interface StoredTheme {
  enabled: boolean;
  mode: "dark" | "light";
  colors: string[];
  angle: number;
  intensity: number;
  updatedAt: string;
}

const PROFILE_THEME_PRESETS: Record<string, Omit<StoredTheme, "updatedAt"> | undefined> = {
  default: undefined,
  dark: { enabled: true, mode: "dark", colors: ["#313338", "#1E1F22"], angle: 45, intensity: 28 },
  purple: { enabled: true, mode: "dark", colors: ["#7C4DFF", "#B89CFF", "#5B8CFF"], angle: 135, intensity: 68 },
  gold: { enabled: true, mode: "dark", colors: ["#E8B84A", "#8A6424", "#33250D"], angle: 120, intensity: 62 },
  glass: { enabled: true, mode: "dark", colors: ["#8FD3FF", "#B7A1FF", "#D5F4FF"], angle: 145, intensity: 30 },
  amoled: { enabled: true, mode: "dark", colors: ["#000000", "#090909", "#171717"], angle: 180, intensity: 88 },
};

async function setAnimationPreference(interaction: ChatInputCommandInteraction): Promise<void> {
  const mode = interaction.options.getString("mode", true);
  if (mode !== "always" && mode !== "hover" && mode !== "off") {
    await interaction.reply({ content: "That animation mode is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }
  await setBadgeAnimationMode(interaction.user.id, mode);
  await interaction.reply({
    content: mode === "always"
      ? "Animated badges will always play."
      : mode === "hover"
        ? "Animated badges will use a still frame until you hover them."
        : "Animated badges will use a still frame.",
    flags: MessageFlags.Ephemeral,
  });
}

async function setProfileTheme(interaction: ChatInputCommandInteraction): Promise<void> {
  const preset = interaction.options.getString("preset", true);
  if (!Object.hasOwn(PROFILE_THEME_PRESETS, preset)) {
    await interaction.reply({ content: "That profile theme is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }
  await mutateStore((data) => {
    const user = getOrCreateUser(data, interaction.user.id) as typeof data.users[string] & { theme?: StoredTheme };
    const theme = PROFILE_THEME_PRESETS[preset];
    if (!theme) delete user.theme;
    else user.theme = { ...theme, colors: [...theme.colors], updatedAt: new Date().toISOString() };
  });
  await interaction.reply({
    content: preset === "default"
      ? "Your Jadges profile theme was reset to default."
      : `The **${preset[0]!.toUpperCase() + preset.slice(1)}** Jadges profile theme is now active.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function badgeStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const [data, presets] = await Promise.all([readStore(), listPresets()]);
  const users = Object.values(data.users);
  const all = users.flatMap((user) => user.badges || []);
  const approved = all.filter((badge) => !badge.pending);
  const pending = all.filter((badge) => badge.pending);
  const animated = approved.filter((badge) =>
    badge.mimeType === "image/gif" || badge.mimeType === "image/apng" || badge.mimeType === "image/webp"
  );
  const rarityCounts = new Map<string, number>();
  for (const badge of approved) {
    const rarity = rarityLabel(badge.rarity);
    rarityCounts.set(rarity, (rarityCounts.get(rarity) || 0) + 1);
  }
  const rarityLine = [...rarityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}: ${count}`)
    .join(" • ") || "No approved badges yet";
  const embed = new EmbedBuilder()
    .setTitle("Jadges Badge Stats")
    .setDescription(rarityLine)
    .addFields(
      { name: "Users", value: String(users.length), inline: true },
      { name: "Approved badges", value: String(approved.length), inline: true },
      { name: "Pending", value: String(pending.length), inline: true },
      { name: "Animated", value: String(animated.length), inline: true },
      { name: "Community presets", value: String(presets.length), inline: true },
      { name: "Preset claims", value: String(presets.reduce((sum, preset) => sum + preset.claims, 0)), inline: true },
    )
    .setColor(0x7c5cff);
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function globalBadgeSearch(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = cleanName(interaction.options.getString("query", true)).toLowerCase();
  const data = await readStore();
  const matches: Array<{ name: string; rarity: string; creatorId?: string }> = [];
  const seen = new Set<string>();
  for (const [ownerId, user] of Object.entries(data.users)) {
    for (const badge of user.badges || []) {
      if (badge.pending || !badge.name.toLowerCase().includes(query)) continue;
      const creatorId = badge.creatorId || (badge.id.startsWith("quest:") ? undefined : ownerId);
      const key = `${creatorId || "system"}:${badge.name.toLowerCase()}:${badge.rarity || "common"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ name: badge.name, rarity: rarityLabel(badge.rarity), creatorId });
      if (matches.length >= 10) break;
    }
    if (matches.length >= 10) break;
  }
  const description = matches.length
    ? matches.map((match) =>
        `• **${match.name}** — ${match.rarity}${match.creatorId ? ` — [Creator](${config.publicUrl}/creators/${match.creatorId})` : ""}`
      ).join("\n")
    : "No approved Jadges badges matched that search.";
  const embed = new EmbedBuilder()
    .setTitle(`Badge search: ${interaction.options.getString("query", true)}`)
    .setDescription(description)
    .setColor(0x5865f2);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open global search")
      .setStyle(ButtonStyle.Link)
      .setURL(`${config.publicUrl}/badge-search?q=${encodeURIComponent(interaction.options.getString("query", true))}`),
  );
  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function setUserBlock(
  interaction: ChatInputCommandInteraction,''',
)
# Autocomplete rarity before badge-only branch.
replace_once(
    "src/discord.ts",
    '  const focused = interaction.options.getFocused(true);\n  if (focused.name !== "badge") {',
    r'''  const focused = interaction.options.getFocused(true);
  if (focused.name === "rarity" && subcommand === "create") {
    const query = String(focused.value || "").toLowerCase();
    const hasSpecialAccess = interaction.inCachedGuild()
      && interaction.member.roles.cache.has(JAYCORD_STAFF_ROLE_ID);
    const choices = BADGE_RARITY_CHOICES
      .filter((choice) => hasSpecialAccess || !isStaffBadgeRarity(choice.value))
      .filter((choice) => choice.name.toLowerCase().includes(query) || choice.value.includes(query))
      .slice(0, 25);
    await interaction.respond(choices);
    return;
  }
  if (focused.name !== "badge") {''',
)
replace_once(
    "src/discord.ts",
    '    case "list":\n      await listBadges(interaction);\n      break;',
    '''    case "list":\n      await listBadges(interaction);\n      break;\n    case "animation":\n      await setAnimationPreference(interaction);\n      break;\n    case "theme":\n      await setProfileTheme(interaction);\n      break;\n    case "stats":\n      await badgeStats(interaction);\n      break;\n    case "search":\n      await globalBadgeSearch(interaction);\n      break;''',
)


# ---------------------------------------------------------------------------
# Preset creator links
# ---------------------------------------------------------------------------
replace_once(
    "src/presetPages.ts",
    '        <p>Uploaded by <strong>@${escapeHtml(preset.uploaderUsername)}</strong>. Add a personal copy directly to your Jadges profile.</p>',
    '        <p>Uploaded by <a href="/creators/${encodeURIComponent(preset.uploaderId)}"><strong>@${escapeHtml(preset.uploaderUsername)}</strong></a>. Add a personal copy directly to your Jadges profile.</p>',
)


# ---------------------------------------------------------------------------
# Vencord directory payload, animation playback and exact directory-style UI
# ---------------------------------------------------------------------------
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    'type BadgeSide = "left" | "right";',
    'type BadgeSide = "left" | "right";\ntype BadgeRarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "exclusive" | "limited" | "staff" | "event" | "quest";\ntype BadgeAnimationMode = "always" | "hover" | "off";',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '    nativeBadges?: PublicNativeBadge[];\n}',
    '    nativeBadges?: PublicNativeBadge[];\n    rarity?: BadgeRarity;\n    creatorId?: string;\n    animated?: boolean;\n    staticBadge?: string;\n    animationMode?: BadgeAnimationMode;\n}',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    'interface JadgesSettings {\n    side: BadgeSide;\n    order: string[];\n    nativeBadges: PublicNativeBadge[];\n}',
    'interface JadgesSettings {\n    side: BadgeSide;\n    order: string[];\n    nativeBadges: PublicNativeBadge[];\n    animationMode: BadgeAnimationMode;\n}',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '    nativeBadges?: PublicNativeBadge[];\n}>;',
    '    nativeBadges?: PublicNativeBadge[];\n    animationMode?: BadgeAnimationMode;\n}>;',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '    nitro?: NitroPreset;\n}',
    '    nitro?: NitroPreset;\n    rarity: BadgeRarity;\n    creatorId?: string;\n    animated?: boolean;\n    staticImage?: string;\n}',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '        nativeBadges: Array.isArray(stored?.nativeBadges)',
    '        animationMode: stored?.animationMode === "hover" || stored?.animationMode === "off" ? stored.animationMode : "always",\n        nativeBadges: Array.isArray(stored?.nativeBadges)',
)
# Add directory metadata to Nitro/custom/native entries.
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '                description: "A Nitro appearance equipped through Jadges.",\n                nitro: badge.nitro',
    '                description: "A Nitro appearance equipped through Jadges.",\n                nitro: badge.nitro,\n                rarity: "rare"',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '            description: `A profile badge displayed through Jadges. Other Jadges users can also see “${title}”.`\n        });',
    '            description: badge.rarity === "quest" ? "Unlocked by completing a Quest." : `A profile badge displayed through Jadges. Other Jadges users can also see “${title}”.`,\n            rarity: badge.rarity || "common",\n            creatorId: badge.creatorId,\n            animated: badge.animated === true,\n            staticImage: badge.staticBadge\n        });',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '            description: "A native Discord badge whose position is customized locally by the Jadges plugin."\n        });',
    '            description: "A native Discord badge whose position is customized locally by the Jadges plugin.",\n            rarity: "common"\n        });',
)
# Replace modal with a Discord Badge Directory-inspired two-panel layout.
regex_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    r'function BadgeDirectoryModal\(\{ userId, modalProps \}: \{ userId: string; modalProps: any; \}\) \{.*?\n\}\n\nfunction openBadgeDirectory',
    r'''function rarityLabel(value: BadgeRarity): string {
    return value[0]!.toUpperCase() + value.slice(1);
}

function directoryImage(entry: DirectoryEntry, userId: string): string {
    const mode = getSettings(userId).animationMode;
    if (entry.animated && mode !== "always" && entry.staticImage) return entry.staticImage;
    return entry.detailImage;
}

function BadgeDirectoryModal({ userId, modalProps }: { userId: string; modalProps: any; }) {
    const entries = buildDirectoryEntries(userId);
    const [selectedId, setSelectedId] = React.useState(entries[0]?.id);
    const [stats, setStats] = React.useState<{ approvedBadges?: number; users?: number; }>();
    const selected = entries.find(entry => entry.id === selectedId) || entries[0];

    React.useEffect(() => {
        let active = true;
        void fetch(`${apiRoot()}/api/badges/stats`, { cache: "no-store", credentials: "omit" })
            .then(response => response.ok ? response.json() : undefined)
            .then(value => { if (active && value) setStats(value); })
            .catch(() => undefined);
        return () => { active = false; };
    }, []);

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} aria-label="Badge Directory" className="jadges-directory-modal-root">
            <ModalContent className="jadges-directory-content jadges-directory-v2">
                {entries.length === 0 || !selected ? (
                    <div className="jadges-directory-empty">No visible badges were found for this user.</div>
                ) : (
                    <div className="jadges-directory-layout">
                        <section className="jadges-directory-list">
                            <header className="jadges-directory-header-v2">
                                <h1>Your badges</h1>
                                <p>Browse your badges and discover new ones you can unlock.</p>
                            </header>
                            <div className="jadges-directory-scroll">
                                <div className="jadges-directory-grid" role="tablist" aria-label="Your badges">
                                    {entries.map(entry => (
                                        <button
                                            key={entry.id}
                                            role="tab"
                                            aria-selected={selected.id === entry.id}
                                            aria-label={entry.title}
                                            className={`jadges-directory-slot${selected.id === entry.id ? " jadges-directory-slot-selected" : ""}`}
                                            onClick={() => setSelectedId(entry.id)}
                                        >
                                            <img src={entry.icon} alt="" aria-hidden="true" />
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <footer className="jadges-directory-list-footer">
                                <span>{stats?.approvedBadges ?? entries.length} badges</span>
                                <span>{stats?.users ? `${stats.users} Jadges users` : "Jadges directory"}</span>
                            </footer>
                        </section>

                        <section className="jadges-directory-detail" role="tabpanel">
                            <button className="jadges-directory-detail-close" aria-label="Close" onClick={modalProps.onClose}>×</button>
                            <div className="jadges-directory-graphic-wrap">
                                <img
                                    className="jadges-directory-graphic"
                                    src={directoryImage(selected, userId)}
                                    alt=""
                                    aria-hidden="true"
                                    data-jadges-animation-mode={getSettings(userId).animationMode}
                                    data-jadges-animated-src={selected.animated ? selected.detailImage : undefined}
                                    data-jadges-static-src={selected.staticImage}
                                />
                            </div>
                            <div className="jadges-directory-identity">
                                <h2>{selected.title}</h2>
                                <div>{selected.subtitle || "Unlocked"}</div>
                            </div>
                            <div className="jadges-directory-details-grid">
                                <div className={`jadges-directory-stat-card rarity-${selected.rarity}`}>
                                    <strong><span className="jadges-rarity-dot" />{rarityLabel(selected.rarity)}</strong>
                                    <span>Rarity</span>
                                </div>
                                <div className="jadges-directory-description-card">
                                    <div>{selected.description}</div>
                                    <div className="jadges-directory-actions">
                                        {selected.creatorId && selected.rarity !== "quest" && selected.rarity !== "staff" && (
                                            <button onClick={() => window.open(`${apiRoot()}/creators/${selected.creatorId}`, "_blank")}>Creator Profile</button>
                                        )}
                                        <button onClick={() => window.open(`${apiRoot()}/badge-search`, "_blank")}>Badge Search</button>
                                    </div>
                                </div>
                            </div>

                            {selected.nitro && (
                                <div className="jadges-directory-timeline-wrap">
                                    <div className="jadges-directory-tier-note">Unlock more tiers the longer you have Nitro</div>
                                    <div className="jadges-directory-timeline" role="list">
                                        {NITRO_TIMELINE.map(tier => {
                                            const unlocked = tier.months <= selected.nitro!.months;
                                            return (
                                                <div key={tier.key} role="listitem" className={`jadges-directory-tier${unlocked ? "" : " jadges-directory-tier-locked"}`}>
                                                    <img src={tier.icon} alt="" aria-hidden="true" />
                                                    <strong>{tier.label}</strong>
                                                    <span>{tier.months >= 12
                                                        ? `${tier.months / 12} year${tier.months === 12 ? "" : "s"}`
                                                        : `${tier.months} month${tier.months === 1 ? "" : "s"}`}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </section>
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

function openBadgeDirectory''',
)
# Animation pointer swap helpers before click handler.
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    'function handleProfileBadgeClick(event: MouseEvent): void {',
    r'''function animationImageFromEvent(event: Event): HTMLImageElement | undefined {
    const target = event.target;
    if (!(target instanceof Element)) return undefined;
    const image = target instanceof HTMLImageElement
        ? target
        : target.closest<HTMLImageElement>("img.jadges-profile-badge-image, img.jadges-directory-graphic");
    return image || undefined;
}

function handleBadgeAnimationOver(event: Event): void {
    const image = animationImageFromEvent(event);
    if (!image || image.dataset.jadgesAnimationMode !== "hover") return;
    const animated = image.dataset.jadgesAnimatedSrc;
    if (animated && image.src !== animated) image.src = animated;
}

function handleBadgeAnimationOut(event: Event): void {
    const image = animationImageFromEvent(event);
    if (!image || image.dataset.jadgesAnimationMode !== "hover") return;
    const still = image.dataset.jadgesStaticSrc;
    if (still && image.src !== still) image.src = still;
}

function handleProfileBadgeClick(event: MouseEvent): void {''',
)
# Extend makeImageBadge and callers.
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '    userId: string,\n    position: BadgePosition\n): NativeDiscordBadge {\n    return {',
    r'''    userId: string,
    position: BadgePosition,
    staticImage?: string,
    animated = false
): NativeDiscordBadge {
    const animationMode = getSettings(userId).animationMode;
    const displayedImage = animated && animationMode !== "always" && staticImage
        ? staticImage
        : image;
    return {''',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '        image,\n        rawImage: true,\n        iconSrc: image,',
    '        image: displayedImage,\n        rawImage: true,\n        iconSrc: displayedImage,',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '            "data-jadges-key": orderKey,\n            style:',
    '            "data-jadges-key": orderKey,\n            "data-jadges-animation-mode": animationMode,\n            "data-jadges-animated-src": animated ? image : undefined,\n            "data-jadges-static-src": staticImage,\n            style:',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '            badge.badge,\n            userId,\n            position\n        ));',
    '            badge.badge,\n            userId,\n            position,\n            badge.staticBadge,\n            badge.animated === true\n        ));',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '        document.addEventListener("click", handleProfileBadgeClick, true);',
    '        document.addEventListener("click", handleProfileBadgeClick, true);\n        document.addEventListener("pointerover", handleBadgeAnimationOver, true);\n        document.addEventListener("pointerout", handleBadgeAnimationOut, true);',
)
replace_once(
    "vencord-plugin/jadgesBadges/base.tsx",
    '        document.removeEventListener("click", handleProfileBadgeClick, true);',
    '        document.removeEventListener("click", handleProfileBadgeClick, true);\n        document.removeEventListener("pointerover", handleBadgeAnimationOver, true);\n        document.removeEventListener("pointerout", handleBadgeAnimationOut, true);',
)

append_once(
    "vencord-plugin/jadgesBadges/style.css",
    ".jadges-directory-v2",
    r'''.jadges-directory-v2 {
    padding: 0 !important;
    overflow: hidden !important;
}

.jadges-directory-v2 .jadges-directory-layout {
    display: grid;
    grid-template-columns: minmax(350px, 1.08fr) minmax(330px, .92fr);
    gap: 0;
    min-height: 540px;
    background: var(--background-base-lowest, var(--background-primary));
}

.jadges-directory-v2 .jadges-directory-list,
.jadges-directory-v2 .jadges-directory-detail {
    border: 0;
    border-radius: 0;
    background: transparent;
}

.jadges-directory-v2 .jadges-directory-list {
    display: flex;
    min-width: 0;
    flex-direction: column;
    padding: 0;
    border-right: 1px solid var(--border-subtle);
}

.jadges-directory-header-v2 {
    padding: 28px 28px 18px;
}

.jadges-directory-header-v2 h1 {
    margin: 0;
    color: var(--text-strong);
    font-size: 24px;
    font-weight: 750;
    line-height: 1.2;
}

.jadges-directory-header-v2 p {
    margin: 7px 0 0;
    color: var(--text-subtle);
    font-size: 14px;
    line-height: 1.4;
}

.jadges-directory-scroll {
    flex: 1;
    overflow: auto;
    padding: 2px 28px 24px;
}

.jadges-directory-v2 .jadges-directory-grid {
    grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
    gap: 11px;
}

.jadges-directory-v2 .jadges-directory-slot {
    min-height: 66px;
    padding: 13px;
    border: 1px solid transparent;
    border-radius: 12px;
    background: var(--background-mod-subtle, rgba(255,255,255,.055));
    transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.jadges-directory-v2 .jadges-directory-slot:hover {
    background: var(--background-mod-strong, rgba(255,255,255,.11));
    transform: translateY(-1px);
}

.jadges-directory-v2 .jadges-directory-slot-selected {
    border-color: var(--border-strong, rgba(255,255,255,.22));
    background: var(--background-mod-strong, rgba(255,255,255,.14));
    box-shadow: inset 0 0 0 1px var(--brand-500, #5865f2);
}

.jadges-directory-v2 .jadges-directory-slot img {
    width: 39px;
    height: 39px;
}

.jadges-directory-list-footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 28px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-subtle);
    font-size: 12px;
}

.jadges-directory-v2 .jadges-directory-detail {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 28px 28px 30px;
    text-align: left;
    background: var(--background-secondary);
}

.jadges-directory-detail-close {
    position: absolute;
    top: 18px;
    right: 18px;
    z-index: 2;
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: var(--background-mod-subtle, rgba(255,255,255,.06));
    color: var(--interactive-normal);
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
}

.jadges-directory-graphic-wrap {
    display: grid;
    min-height: 208px;
    place-items: center;
    margin: 20px 0 14px;
}

.jadges-directory-v2 .jadges-directory-graphic {
    width: min(230px, 74%);
    height: 190px;
    margin: 0;
    object-fit: contain;
}

.jadges-directory-v2 .jadges-directory-identity h2 {
    margin: 0;
    color: var(--text-strong);
    font-size: 27px;
    font-style: normal;
    font-weight: 800;
    text-transform: none;
}

.jadges-directory-v2 .jadges-directory-identity div {
    margin-top: 5px;
    font-size: 12px;
}

.jadges-directory-details-grid {
    display: grid;
    grid-template-columns: 125px minmax(0, 1fr);
    gap: 10px;
    margin-top: 24px;
}

.jadges-directory-v2 .jadges-directory-stat-card,
.jadges-directory-v2 .jadges-directory-description-card {
    min-height: 104px;
    padding: 14px;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    background: var(--background-primary);
}

.jadges-directory-v2 .jadges-directory-stat-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
}

.jadges-directory-v2 .jadges-directory-stat-card strong {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: .04em;
}

.jadges-rarity-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
}

.jadges-directory-stat-card.rarity-common strong { color: #b7bdc8; }
.jadges-directory-stat-card.rarity-uncommon strong { color: #57d68d; }
.jadges-directory-stat-card.rarity-rare strong { color: #5ea0ff; }
.jadges-directory-stat-card.rarity-epic strong { color: #b978ff; }
.jadges-directory-stat-card.rarity-legendary strong { color: #ffbd4a; }
.jadges-directory-stat-card.rarity-exclusive strong { color: #ff6ea9; }
.jadges-directory-stat-card.rarity-limited strong { color: #ff8a5b; }
.jadges-directory-stat-card.rarity-staff strong { color: #59e1dc; }
.jadges-directory-stat-card.rarity-event strong { color: #f27cff; }
.jadges-directory-stat-card.rarity-quest strong { color: #7bd7ff; }

.jadges-directory-v2 .jadges-directory-description-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-default);
    font-size: 14px;
    line-height: 1.45;
}

.jadges-directory-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.jadges-directory-actions button {
    min-height: 32px;
    padding: 0 11px;
    border: 0;
    border-radius: 8px;
    background: var(--button-secondary-background, var(--background-mod-strong));
    color: var(--text-strong);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
}

.jadges-directory-v2 .jadges-directory-timeline-wrap {
    margin-top: 18px;
}

@media (max-width: 760px) {
    .jadges-directory-v2 .jadges-directory-layout {
        grid-template-columns: 1fr;
        min-height: 0;
    }

    .jadges-directory-v2 .jadges-directory-list {
        border-right: 0;
        border-bottom: 1px solid var(--border-subtle);
    }

    .jadges-directory-v2 .jadges-directory-scroll {
        max-height: 260px;
    }

    .jadges-directory-v2 .jadges-directory-detail {
        min-height: 470px;
    }

    .jadges-directory-details-grid {
        grid-template-columns: 1fr;
    }
}''',
)


# ---------------------------------------------------------------------------
# Main integration ordering: community wrapper must sit outside Presets wrapper
# ---------------------------------------------------------------------------
replace_once(
    "src/main.ts",
    'import { config } from "./config.js";',
    'import { config } from "./config.js";\nimport { installCommunityFeatures } from "./communityFeatures.js";',
)
replace_once(
    "src/main.ts",
    'installPresetOwnerDeleteIntegration();\ninstallPresetMarketplaceIntegration();',
    'installPresetOwnerDeleteIntegration();\ninstallCommunityFeatures();\ninstallPresetMarketplaceIntegration();',
)


# ---------------------------------------------------------------------------
# Documentation
# ---------------------------------------------------------------------------
replace_once(
    "README.md",
    '- Custom badge images and names\n',
    '- Custom badge images and names\n- Discord-style badge directory with rarity details and creator links\n- Common, Uncommon, Rare, Epic, Legendary, plus staff-only special rarities\n- Animated badge playback modes: always, hover-only, or off\n- Global badge stats and search, creator profiles, and preset likes/favorites\n- Named Jadges profile theme presets\n',
)

print("Jadges community v2 patch applied")
