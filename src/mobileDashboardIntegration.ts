import http, { type RequestListener, type ServerResponse } from "node:http";

const MOBILE_DASHBOARD_CSS = String.raw`
/* Jadges dashboard mobile layout */
@media (max-width: 900px) {
  html, body, .dashboard-body, .app-shell, .app-main { width: 100%; max-width: 100%; overflow-x: hidden; }
  .dashboard-body { padding-bottom: env(safe-area-inset-bottom); }
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
  .badge-move button, .segmented button, .logout-link { -webkit-tap-highlight-color: transparent; }
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
  .panel-head {
    padding: 16px 14px 13px;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .panel-head > div { min-width: 0; }
  .panel-head h2 { font-size: 17px; }
  .panel-head p { margin-top: 5px; overflow-wrap: anywhere; }
  .save-indicator { align-self: flex-start; }

  .badge-editor { padding: 13px; }
  .badge-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .badge-card {
    min-width: 0;
    min-height: 132px;
    padding: 14px 8px 39px;
    border-radius: 14px;
  }
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
  .badge-move button {
    width: 100%;
    height: 31px;
    border-radius: 8px;
    font-size: 15px;
  }

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

let installed = false;

function injectMobileStyles(html: string): string {
  if (!html.includes('class="dashboard-body"') || html.includes("jadges-mobile-dashboard-css")) {
    return html;
  }
  return html.replace(
    "</head>",
    `<style id="jadges-mobile-dashboard-css">${MOBILE_DASHBOARD_CSS}</style></head>`,
  );
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
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
      originalEnd(injectMobileStyles(html), "utf8", callback);
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
