import http, { type RequestListener, type ServerResponse } from "node:http";

const MOBILE_DASHBOARD_CSS = String.raw`
@media (max-width: 900px) {
  html, body, .dashboard-body, .app-shell, .app-main { width: 100%; max-width: 100%; overflow-x: hidden; }
  .dashboard-body { padding-bottom: calc(78px + env(safe-area-inset-bottom)); }
  .topbar {
    min-height: 64px;
    height: auto;
    padding: 9px max(14px, env(safe-area-inset-left)) 9px max(14px, env(safe-area-inset-right));
    gap: 12px;
  }
  .mobile-brand { min-width: 0; }
  .mobile-brand .site-logo { max-width: 145px; }
  .mobile-brand .site-logo span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-menu { min-width: 0; gap: 8px; }
  .account-avatar { width: 36px; height: 36px; flex: 0 0 auto; }
  .logout-link {
    min-width: 44px;
    min-height: 44px;
    margin-left: 0;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: rgba(255,255,255,.025);
  }
  .dashboard-wrap {
    width: 100%;
    padding-left: max(14px, env(safe-area-inset-left));
    padding-right: max(14px, env(safe-area-inset-right));
  }
  .dashboard-grid, .dashboard-primary, .panel, .preview-panel, .preview-body { min-width: 0; max-width: 100%; }
  .panel { box-shadow: 0 14px 42px rgba(0,0,0,.28); }
  .badge-card { touch-action: manipulation; }
  .badge-move button, .segmented button, .logout-link, .mobile-dashboard-nav a { -webkit-tap-highlight-color: transparent; }

  .mobile-dashboard-nav {
    position: fixed;
    z-index: 50;
    left: max(10px, env(safe-area-inset-left));
    right: max(10px, env(safe-area-inset-right));
    bottom: max(10px, env(safe-area-inset-bottom));
    min-height: 64px;
    padding: 7px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 5px;
    border: 1px solid rgba(151,164,196,.22);
    border-radius: 18px;
    background: rgba(10,16,29,.94);
    backdrop-filter: blur(22px);
    box-shadow: 0 18px 55px rgba(0,0,0,.52);
  }
  .mobile-dashboard-nav a {
    min-width: 0;
    min-height: 49px;
    padding: 5px 4px;
    border-radius: 12px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    text-decoration: none;
    font-size: 10px;
    font-weight: 760;
  }
  .mobile-dashboard-nav a:hover,
  .mobile-dashboard-nav a:focus-visible,
  .mobile-dashboard-nav a[aria-current="page"] {
    color: white;
    background: linear-gradient(135deg, rgba(91,140,255,.24), rgba(124,77,255,.24));
  }
  .mobile-dashboard-nav svg {
    width: 21px;
    height: 21px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

@media (min-width: 901px) {
  .mobile-dashboard-nav { display: none; }
}

@media (max-width: 650px) {
  .dashboard-wrap { padding-top: 18px; padding-bottom: 34px; }
  .page-heading { padding: 0 2px; }
  .page-heading h1 { font-size: clamp(25px, 8vw, 30px); line-height: 1.08; }
  .page-heading p { max-width: 34rem; font-size: 13px; line-height: 1.5; }
  .dashboard-grid { margin-top: 18px; gap: 14px; }
  .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .stat-card { min-width: 0; min-height: 88px; padding: 13px; border-radius: 14px; }
  .stat-label, .stat-note { overflow-wrap: anywhere; }
  .stat-label { font-size: 11px; }
  .stat-value { margin-top: 7px; font-size: 19px; }
  .stat-note { font-size: 10px; line-height: 1.35; }
  .panel { margin-top: 13px; border-radius: 16px; }
  .panel-head { padding: 16px 14px 13px; flex-direction: column; align-items: stretch; gap: 10px; }
  .panel-head > div { min-width: 0; }
  .panel-head h2 { font-size: 17px; }
  .panel-head p { margin-top: 5px; overflow-wrap: anywhere; }
  .save-indicator { align-self: flex-start; }
  .badge-editor { padding: 13px; }
  .badge-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .badge-card { min-width: 0; min-height: 132px; padding: 14px 8px 39px; border-radius: 14px; }
  .badge-image-wrap { width: 54px; height: 54px; margin-top: 4px; }
  .badge-image { width: 42px; height: 42px; }
  .badge-name { margin-top: 8px; font-size: 11px; }
  .badge-kind { font-size: 8px; }
  .badge-grip { top: 7px; }
  .pin-label { top: 6px; right: 6px; }
  .badge-move {
    inset: auto 7px 7px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: calc(100% - 14px);
    opacity: 1;
    transform: none;
  }
  .badge-move button { width: 100%; height: 31px; border-radius: 8px; font-size: 15px; }
  .setting-row { min-height: 0; padding: 14px; gap: 12px; }
  .setting-copy { width: 100%; min-width: 0; }
  .setting-copy strong { font-size: 13px; }
  .setting-copy span { font-size: 11px; overflow-wrap: anywhere; }
  .segmented { width: 100%; padding: 4px; }
  .segmented button { min-width: 0; min-height: 40px; height: auto; padding: 8px 10px; }
  .sync-state { min-height: 36px; }
  .preview-panel { margin-top: 0; }
  .preview-body { padding: 12px; }
  .profile-card { border-radius: 14px; }
  .profile-banner { height: 96px; }
  .profile-content { padding: 0 14px 15px; }
  .profile-avatar-wrap, .profile-avatar { width: 72px; height: 72px; }
  .profile-avatar-wrap { margin-top: -36px; }
  .profile-avatar { border-width: 5px; }
  .profile-name { min-width: 0; font-size: 18px; overflow-wrap: anywhere; }
  .profile-badges { gap: 4px; }
  .preview-note { padding: 13px; font-size: 10px; }
  .notice-bar { margin-top: 13px; padding: 13px 14px; overflow-wrap: anywhere; }
}

@media (max-width: 390px) {
  .topbar { padding-left: 10px; padding-right: 10px; }
  .mobile-brand .site-logo { gap: 7px; font-size: 15px; }
  .mobile-brand .logo-mark { width: 24px; height: 28px; }
  .account-avatar { width: 32px; height: 32px; }
  .logout-link { min-width: 40px; min-height: 40px; padding: 0 8px; font-size: 11px; }
  .dashboard-wrap { padding-left: 10px; padding-right: 10px; }
  .stats-grid { gap: 7px; }
  .stat-card { padding: 11px; }
  .badge-editor { padding: 10px; }
  .badge-grid { gap: 7px; }
  .badge-card { min-height: 126px; padding-left: 6px; padding-right: 6px; }
}
`;

const MOBILE_NAVIGATION = `<nav class="mobile-dashboard-nav" aria-label="Mobile dashboard navigation">
  <a href="/dashboard" aria-current="page">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z"/></svg>
    <span>Dashboard</span>
  </a>
  <a href="/dashboard#appearance">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-1.2a2 2 0 0 1-1.7-3l.5-.9A2 2 0 0 0 14.9 3H12Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="10" cy="6.8" r="1"/><circle cx="7.8" cy="14" r="1"/></svg>
    <span>Appearance</span>
  </a>
  <a href="/presets">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="m8 15 2.5-3 2 2 2.5-3 3 4"/><circle cx="9" cy="9" r="1"/></svg>
    <span>Presets</span>
  </a>
</nav>`;

let installed = false;

function serveMobileCss(response: ServerResponse): void {
  const content = Buffer.from(MOBILE_DASHBOARD_CSS, "utf8");
  response.writeHead(200, {
    "content-type": "text/css; charset=utf-8",
    "content-length": String(content.length),
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function transformDashboard(html: string): string {
  if (!html.includes('class="dashboard-body"')) return html;
  if (!html.includes("/assets/mobile-dashboard.css")) {
    html = html.replace(
      "</head>",
      '<link rel="stylesheet" href="/assets/mobile-dashboard.css"></head>',
    );
  }
  if (!html.includes('class="mobile-dashboard-nav"')) {
    html = html.replace("</body>", `${MOBILE_NAVIGATION}</body>`);
  }
  return html;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    if (request.method === "GET" && url.pathname === "/assets/mobile-dashboard.css") {
      serveMobileCss(response);
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/dashboard") {
      listener(request, response);
      return;
    }

    const originalEnd = response.end.bind(response);
    let ended = false;
    response.end = ((chunk?: any, encoding?: any, callback?: any): ServerResponse => {
      if (ended) return response;
      ended = true;
      if (chunk === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        originalEnd(chunk, encoding, callback);
        return response;
      }
      const html = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
      originalEnd(transformDashboard(html), "utf8", callback);
      return response;
    }) as typeof response.end;

    listener(request, response);
  };
}

export function installMobileDashboardIntegration(): void {
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
