import { createHmac, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { refreshQuestProgress, type QuestProgress } from "./badgeQuests.js";

const SESSION_COOKIE = "jadges_session";
let installed = false;

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret).update(value).digest("base64url");
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const cookie = (request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const raw = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return undefined;

  try {
    const token = decodeURIComponent(raw);
    const [body, suppliedSignature, extra] = token.split(".");
    if (!body || !suppliedSignature || extra) return undefined;
    const expected = Buffer.from(signature(body));
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      kind?: unknown;
      userId?: unknown;
      expiresAt?: unknown;
    };
    if (
      payload.kind !== "session"
      || typeof payload.userId !== "string"
      || !/^\d{15,22}$/.test(payload.userId)
      || typeof payload.expiresAt !== "number"
      || payload.expiresAt <= Date.now()
    ) return undefined;
    return payload.userId;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function category(item: QuestProgress): "completed" | "progress" | "uncompleted" {
  if (item.completed) return "completed";
  return item.current > 0 ? "progress" : "uncompleted";
}

function questCard(item: QuestProgress): string {
  const status = category(item);
  const labels = {
    completed: "Completed",
    progress: "In Progress",
    uncompleted: "Uncompleted",
  };
  const percentage = item.target > 0
    ? Math.max(0, Math.min(100, Math.round(item.current / item.target * 100)))
    : 0;
  return `<article class="quest-card ${status}">
    <div class="quest-card-head">
      <div><span class="status ${status}">${labels[status]}</span><h3>${escapeHtml(item.quest.name)}</h3></div>
      <strong>${escapeHtml(item.progress)}</strong>
    </div>
    <p>${escapeHtml(item.quest.description)}</p>
    <div class="progress-track"><span style="width:${percentage}%"></span></div>
    <div class="reward">Reward: <b>${escapeHtml(item.quest.rewardName)}</b>${item.claimed ? " • Equipped" : ""}</div>
  </article>`;
}

function section(title: string, items: QuestProgress[], kind: ReturnType<typeof category>): string {
  const selected = items.filter((item) => category(item) === kind);
  return `<section class="quest-section">
    <div class="section-heading"><h2>${title}</h2><span>${selected.length}</span></div>
    <div class="quest-grid">${selected.length ? selected.map(questCard).join("") : '<div class="empty">No quests in this section.</div>'}</div>
  </section>`;
}

function page(progress: QuestProgress[], unlocked: string[]): string {
  const completed = progress.filter((item) => item.completed).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Badge Quests • Jadges</title>
  <style>
    :root{color-scheme:dark;--bg:#070b14;--card:#111827;--border:#27314a;--text:#f6f7fb;--muted:#a8b0c3;--purple:#8b5cf6;--blue:#5b8cff;--green:#43d17d;--yellow:#f2b84b}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#27194c 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}.shell{width:min(1100px,calc(100% - 28px));margin:auto;padding:24px 0 60px}.top{display:flex;justify-content:space-between;align-items:center;gap:14px}.brand{font-size:21px;font-weight:900}.top a{color:#d9dff0;text-decoration:none;border:1px solid var(--border);padding:10px 14px;border-radius:12px}.hero{margin-top:22px;padding:26px;border:1px solid var(--border);border-radius:22px;background:linear-gradient(135deg,rgba(139,92,246,.22),rgba(91,140,255,.10)),#0e1524}.hero h1{font-size:clamp(30px,7vw,54px);line-height:1;margin:0}.hero p{color:var(--muted);max-width:720px}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px}.summary div{background:#0a1020;border:1px solid var(--border);border-radius:14px;padding:14px}.summary strong{display:block;font-size:23px}.unlock{margin-top:14px;padding:13px 15px;border:1px solid #3b8460;background:#123523;border-radius:13px}.reward-showcase{display:flex;align-items:center;gap:15px;margin-top:18px;padding:16px;border:1px solid var(--border);border-radius:16px;background:rgba(6,10,20,.6)}.reward-showcase img{width:70px;height:70px;object-fit:contain}.reward-showcase p{margin:3px 0;color:var(--muted)}.quest-section{margin-top:28px}.section-heading{display:flex;align-items:center;gap:10px}.section-heading h2{margin:0}.section-heading span{background:#202a42;padding:2px 9px;border-radius:999px}.quest-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.quest-card,.empty{border:1px solid var(--border);border-radius:17px;background:var(--card);padding:17px}.quest-card-head{display:flex;justify-content:space-between;gap:12px}.quest-card h3{margin:7px 0 0}.quest-card p,.reward{color:var(--muted)}.status{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:800}.status.completed{background:#163d29;color:#7ae7a5}.status.progress{background:#3b3013;color:#ffd370}.status.uncompleted{background:#202839;color:#b7c0d4}.progress-track{height:8px;background:#080d18;border-radius:999px;overflow:hidden}.progress-track span{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--blue))}.reward{margin-top:11px;font-size:12px}.footer{margin-top:30px;color:var(--muted);text-align:center}@media(max-width:700px){.shell{width:min(100% - 20px,1100px);padding-top:14px}.hero{padding:20px}.summary{grid-template-columns:1fr}.quest-grid{grid-template-columns:1fr}.reward-showcase{align-items:flex-start}.top a{padding:8px 10px}}
  </style></head><body><main class="shell"><header class="top"><div class="brand">Jadges</div><a href="/dashboard">Dashboard</a></header>
  <section class="hero"><h1>Badge Quests</h1><p>Complete Jadges challenges, track your progress, and unlock profile rewards. Opening this page automatically checks and awards newly completed quests.</p>
  <div class="summary"><div><strong>${progress.length}</strong>Total quests</div><div><strong>${completed}</strong>Completed</div><div><strong>${progress.length - completed}</strong>Remaining</div></div>
  ${unlocked.length ? `<div class="unlock">New rewards equipped: <b>${escapeHtml(unlocked.join(", "))}</b></div>` : ""}
  <div class="reward-showcase"><img src="/badges/${encodeURIComponent("10000000-0000-4000-8000-000000000099.png")}" alt="Completed a Quest badge"><div><b>Complete any quest to unlock the shared quest badge</b><p>Shown as <strong>Quests</strong> on PC and <strong>Completed a Quest</strong> on mobile.</p></div></div></section>
  ${section("Completed", progress, "completed")}${section("In Progress", progress, "progress")}${section("Uncompleted", progress, "uncompleted")}
  <div class="footer">Jadges Badge Quests</div></main></body></html>`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(html);
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", config.publicUrl);
    if (url.pathname !== "/quests") {
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
    void refreshQuestProgress(userId)
      .then(({ progress, unlocked }) => sendHtml(response, 200, page(progress, unlocked)))
      .catch((error) => {
        console.error("Badge Quests website failed:", error);
        sendHtml(response, 500, "<h1>Badge Quests could not be loaded.</h1><p>Please try again shortly.</p>");
      });
  };
}

export function installQuestWebsiteIntegration(): void {
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
