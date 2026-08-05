import http, { type RequestListener, type ServerResponse } from "node:http";
import path from "node:path";
import { incrementBadgeView, incrementPresetView, readAnalytics } from "./analyticsStore.js";
import { config } from "./config.js";
import { listPresets } from "./presetStore.js";
import { sessionUserId } from "./presetWeb.js";
import { readStore } from "./store.js";
import type { BadgeRecord } from "./types.js";

let installed = false;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isCreatorBadge(badge: BadgeRecord): boolean {
  return !badge.pending
    && !badge.id.startsWith("preset-")
    && !badge.id.startsWith("quest:");
}

function number(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function rankFor(userId: string, counts: Array<[string, number]>): number | undefined {
  const sorted = counts
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const index = sorted.findIndex(([id]) => id === userId);
  return index === -1 ? undefined : index + 1;
}

function badgeRows(badges: BadgeRecord[], views: Record<string, number>): string {
  if (!badges.length) return '<div class="empty">You have not created any approved badges yet.</div>';
  return `<div class="table"><div class="tr head"><span>Badge</span><span>Views</span></div>${badges
    .sort((a, b) => (views[b.filename] || 0) - (views[a.filename] || 0))
    .map((badge) => `<div class="tr"><span>${escapeHtml(badge.name)}</span><strong>${number(views[badge.filename] || 0)}</strong></div>`)
    .join("")}</div>`;
}

function presetRows(
  presets: Awaited<ReturnType<typeof listPresets>>,
  views: Record<string, number>,
): string {
  if (!presets.length) return '<div class="empty">You have not published any presets yet.</div>';
  return `<div class="table"><div class="tr preset-head"><span>Preset</span><span>Views</span><span>Uses</span></div>${presets
    .sort((a, b) => (views[b.id] || 0) - (views[a.id] || 0))
    .map((preset) => `<div class="tr preset-row"><span>${escapeHtml(preset.name)}</span><strong>${number(views[preset.id] || 0)}</strong><strong>${number(preset.claims)}</strong></div>`)
    .join("")}</div>`;
}

async function page(userId: string): Promise<string> {
  const [store, presets, analytics] = await Promise.all([
    readStore(),
    listPresets(),
    readAnalytics(),
  ]);
  const userBadges = (store.users[userId]?.badges || []).filter(isCreatorBadge);
  const userPresets = presets.filter((preset) => preset.uploaderId === userId);
  const creatorCounts = Object.entries(store.users).map(([id, user]) => [
    id,
    user.badges.filter(isCreatorBadge).length,
  ] as [string, number]);
  const rank = rankFor(userId, creatorCounts);
  const totalBadgeViews = userBadges.reduce(
    (sum, badge) => sum + (analytics.badgeViews[badge.filename] || 0),
    0,
  );
  const totalPresetViews = userPresets.reduce(
    (sum, preset) => sum + (analytics.presetViews[preset.id] || 0),
    0,
  );
  const totalPresetUses = userPresets.reduce((sum, preset) => sum + preset.claims, 0);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analytics • Jadges</title><style>
  :root{color-scheme:dark;--bg:#080b13;--panel:#111725;--border:#263148;--text:#f7f8fc;--muted:#aab3c7;--accent:#8b5cf6;--blue:#5b8cff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,#25174a 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.45 Inter,system-ui,sans-serif}.shell{width:min(1120px,calc(100% - 28px));margin:auto;padding:24px 0 60px}.top{display:flex;justify-content:space-between;align-items:center}.brand{font-size:22px;font-weight:900}.top a{color:var(--text);text-decoration:none;border:1px solid var(--border);border-radius:11px;padding:9px 13px}.hero{margin-top:22px;padding:26px;border:1px solid var(--border);border-radius:22px;background:linear-gradient(135deg,rgba(139,92,246,.2),rgba(91,140,255,.09)),#0e1421}.hero h1{font-size:clamp(32px,6vw,52px);margin:0}.hero p{color:var(--muted);max-width:700px}.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:18px}.stat{border:1px solid var(--border);background:#0a101c;border-radius:15px;padding:15px}.stat strong{display:block;font-size:25px}.stat span{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:20px}.panel{border:1px solid var(--border);border-radius:18px;background:var(--panel);padding:18px}.panel h2{margin:0 0 4px}.panel>p{margin:0 0 14px;color:var(--muted)}.table{border:1px solid var(--border);border-radius:13px;overflow:hidden}.tr{display:grid;grid-template-columns:1fr 100px;gap:12px;padding:12px 13px;border-top:1px solid var(--border);align-items:center}.tr:first-child{border-top:0}.tr strong{text-align:right}.tr.head,.tr.preset-head{background:#0b1120;color:var(--muted);font-size:12px;font-weight:800}.preset-head,.preset-row{grid-template-columns:1fr 80px 80px}.empty{padding:22px;border:1px dashed var(--border);border-radius:13px;color:var(--muted)}.note{margin-top:16px;color:var(--muted);font-size:12px}@media(max-width:850px){.stats{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}@media(max-width:520px){.shell{width:calc(100% - 18px);padding-top:14px}.hero{padding:19px}.stats{grid-template-columns:1fr}.tr{grid-template-columns:1fr 70px}.preset-head,.preset-row{grid-template-columns:1fr 58px 58px}}
  </style></head><body><main class="shell"><header class="top"><div class="brand">Jadges Analytics</div><a href="/dashboard">Dashboard</a></header><section class="hero"><h1>Badge/Preset Analytics</h1><p>See how your published Jadges content performs. Views begin counting after this feature is deployed.</p><div class="stats"><div class="stat"><strong>${number(totalBadgeViews)}</strong><span>Badge views</span></div><div class="stat"><strong>${number(totalPresetViews)}</strong><span>Preset views</span></div><div class="stat"><strong>${number(totalPresetUses)}</strong><span>Preset uses</span></div><div class="stat"><strong>${rank ? `#${rank}` : "—"}</strong><span>Badge creator rank</span></div><div class="stat"><strong>${number(userBadges.length)} / ${number(userPresets.length)}</strong><span>Badges / presets created</span></div></div></section><section class="grid"><article class="panel"><h2>Your badges</h2><p>Views are counted when a client requests the badge image.</p>${badgeRows(userBadges, analytics.badgeViews)}</article><article class="panel"><h2>Your presets</h2><p>Views count detail-page opens; uses count successful claims.</p>${presetRows(userPresets, analytics.presetViews)}</article></section><p class="note">Analytics are private to the signed-in creator. Automated refreshes may count as views.</p></main></body></html>`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(html);
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", config.publicUrl);

    if (request.method === "GET") {
      const badgeMatch = /^\/badges\/([^/]+)$/.exec(url.pathname);
      if (badgeMatch?.[1]) {
        void incrementBadgeView(decodeURIComponent(path.basename(badgeMatch[1]))).catch((error) => {
          console.warn("Could not count badge view:", error);
        });
      }
      const presetMatch = /^\/presets\/([a-f0-9-]+)$/.exec(url.pathname);
      if (presetMatch?.[1]) {
        void incrementPresetView(presetMatch[1]).catch((error) => {
          console.warn("Could not count preset view:", error);
        });
      }
    }

    if (url.pathname !== "/analytics") {
      listener(request, response);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    const userId = sessionUserId(request);
    if (!userId) {
      response.writeHead(302, { location: "/login", "cache-control": "no-store" });
      response.end();
      return;
    }
    void page(userId)
      .then((html) => sendHtml(response, 200, html))
      .catch((error) => {
        console.error("Analytics page failed:", error);
        sendHtml(response, 500, "<h1>Analytics could not be loaded.</h1>");
      });
  };
}

export function installAnalyticsIntegration(): void {
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
