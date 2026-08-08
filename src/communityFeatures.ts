import http, {
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
