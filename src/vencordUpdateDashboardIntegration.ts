import http, { type RequestListener, type ServerResponse } from "node:http";

const UPDATE_VERSION = 47;
let installed = false;

const customProfileLink = `<a class="nav-link" href="/custom-profile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.7-4.3 3.4-7 8-7s7.3 2.7 8 7"/><path d="M18 4v4M16 6h4"/></svg>Custom Profile</a>`;

function sendManifest(response: ServerResponse): void {
  const body = JSON.stringify({ version: UPDATE_VERSION });
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store, no-cache, must-revalidate",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function interceptHtml(response: ServerResponse, transform: (body: string) => string): void {
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
    originalEnd(transform(body), "utf8", callback);
    return response;
  }) as typeof response.end;
}

function addDashboardLink(body: string): string {
  if (body.includes('href="/custom-profile"')) return body;
  const spacer = '<div class="sidebar-spacer">';
  const spacerIndex = body.indexOf(spacer);
  if (spacerIndex !== -1) {
    const navEnd = body.lastIndexOf("</nav>", spacerIndex);
    if (navEnd !== -1) return `${body.slice(0, navEnd)}${customProfileLink}\n      ${body.slice(navEnd)}`;
  }
  const appearance = /(<a class="nav-link" href="#appearance"[\s\S]*?<\/a>)/;
  return appearance.test(body) ? body.replace(appearance, `$1\n        ${customProfileLink}`) : body;
}

function dashboardCustomProfile(body: string): string {
  if (!body.includes("<title>Custom Profile")) return body;

  const dashboardCss = `
  .cp-shell{min-height:100vh;display:grid;grid-template-columns:238px 1fr;background:#070b14}
  .cp-sidebar{height:100vh;position:sticky;top:0;padding:24px 16px;background:#080d17;border-right:1px solid #1a2233;display:flex;flex-direction:column}
  .cp-brand{display:flex;align-items:center;gap:13px;padding:0 10px 24px;color:#fff;text-decoration:none;font-size:20px;font-weight:850}
  .cp-mark{width:28px;height:35px;border:4px solid #7c5cff;border-top:0;border-right:0;border-radius:0 0 0 15px}
  .cp-nav{display:grid;gap:8px}.cp-nav a{display:flex;align-items:center;gap:13px;min-height:44px;padding:0 13px;border-radius:11px;color:#9ca8bd;text-decoration:none;font-weight:760;margin:0}
  .cp-nav a:hover{background:#11182a;color:#fff}.cp-nav a.active{background:#201c51;color:#fff;border:1px solid #39317b}
  .cp-nav svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}.cp-spacer{flex:1}.cp-foot{padding:12px 10px;color:#647087;font-size:12px}
  .cp-main{min-width:0}.cp-topbar{height:76px;padding:0 32px;border-bottom:1px solid #192235;display:flex;align-items:center;justify-content:flex-end;background:rgba(7,11,20,.84);backdrop-filter:blur(14px)}
  .cp-topbar a{margin:0;color:#aab4c8;border:0;padding:0}.cp-content{width:min(1080px,calc(100% - 48px));margin:0 auto;padding:42px 0 70px}.cp-heading{margin-bottom:26px}.cp-eyebrow{color:#8d7cff;font-size:12px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}.cp-heading h1{font-size:38px;margin:8px 0 10px}.cp-heading p{max-width:720px;margin:0;color:#9ca8bd}
  .cp-layout{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(310px,.85fr);gap:24px;align-items:start}.cp-editor,.cp-preview{background:linear-gradient(180deg,#111827,#0d1422);border:1px solid #252f43;border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.24)}
  .cp-editor{padding:26px}.cp-editor.card{padding:26px}.cp-editor h1{display:none}.cp-editor>p:first-of-type{margin-top:0}.cp-editor label{margin-top:20px}.cp-editor input{height:48px;padding:0 14px;background:#080e19;border:1px solid #303b52}.cp-editor input:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.15)}.cp-editor button{background:linear-gradient(135deg,#7657ff,#5f7cff)}.cp-editor a{display:none}
  .cp-preview{overflow:hidden}.cp-preview-head{padding:22px 24px;border-bottom:1px solid #242e41}.cp-preview-head h2{margin:0;font-size:19px}.cp-preview-head p{margin:7px 0 0}.cp-preview-body{padding:26px}.cp-card{overflow:hidden;border:1px solid #30333b;border-radius:16px;background:#16181d}.cp-banner{height:96px;background:radial-gradient(circle at 18% 30%,rgba(154,119,255,.8),transparent 30%),linear-gradient(135deg,#322367,#19274f)}.cp-profile{padding:0 18px 20px}.cp-avatar{width:74px;height:74px;margin-top:-37px;border:6px solid #16181d;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#7657ff,#35446d);font-size:28px;font-weight:900}.cp-name{margin-top:11px;font-size:21px;font-weight:900}.cp-original{margin-top:2px;color:#929aa8;font-size:12px}.cp-divider{height:1px;margin:16px 0;background:#33363d}.cp-label{color:#b9bec8;font-size:11px;font-weight:850;text-transform:uppercase}.cp-value{margin-top:5px}.cp-help{margin-top:16px;color:#7f8ba0;font-size:13px}
  @media(max-width:820px){.cp-shell{grid-template-columns:1fr}.cp-sidebar{height:auto;position:static;padding:14px}.cp-brand{padding-bottom:12px}.cp-nav{grid-template-columns:repeat(4,minmax(0,1fr))}.cp-nav a{justify-content:center;font-size:0}.cp-nav svg{width:21px;height:21px}.cp-spacer,.cp-foot,.cp-topbar{display:none}.cp-content{width:min(100% - 28px,720px);padding-top:28px}.cp-layout{grid-template-columns:1fr}}
  `;

  body = body.replace("</style>", `${dashboardCss}</style>`);
  body = body.replace(
    '<body><main class="wrap"><section class="card">',
    `<body><div class="cp-shell"><aside class="cp-sidebar"><a class="cp-brand" href="/"><span class="cp-mark"></span><span>Jadges</span></a><nav class="cp-nav"><a href="/dashboard"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v9H4v-9Z"/><path d="M9 20v-6h6v6"/></svg>Dashboard</a><a href="/dashboard#badges"><svg viewBox="0 0 24 24"><path d="m12 3 7 3v5c0 4.6-2.8 8.2-7 10-4.2-1.8-7-5.4-7-10V6l7-3Z"/></svg>Badges</a><a href="/dashboard#appearance"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-1 1.5-2-.7-1.5.4-3 2-3h2.2A3.3 3.3 0 0 0 21 12.7 9.7 9.7 0 0 0 12 3Z"/></svg>Appearance</a><a class="active" href="/custom-profile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.4 3.5-7 8-7s7.2 2.6 8 7"/><path d="M18 4v4M16 6h4"/></svg>Custom Profile</a></nav><div class="cp-spacer"></div><div class="cp-foot">Jadges Dashboard • Custom profiles</div></aside><main class="cp-main"><header class="cp-topbar"><a href="/dashboard">← Back to dashboard</a></header><div class="cp-content"><div class="cp-heading"><div class="cp-eyebrow">Cosmetic identity</div><h1>Custom Profile</h1><p>Change how your username and account creation date look inside supported Jadges clients. Your real Discord account is never changed.</p></div><div class="cp-layout"><section class="card cp-editor">`,
  );
  body = body.replace(
    "</section></main></body>",
    `</section><aside class="cp-preview"><div class="cp-preview-head"><h2>Live preview</h2><p>A different visual style for your cosmetic identity.</p></div><div class="cp-preview-body"><div class="cp-card"><div class="cp-banner"></div><div class="cp-profile"><div class="cp-avatar">J</div><div class="cp-name" id="cp-preview-name">Custom name</div><div class="cp-original">Originally, your Discord username</div><div class="cp-divider"></div><div class="cp-label">Member Since</div><div class="cp-value" id="cp-preview-date">Custom creation date</div><div class="cp-original">Originally, your real account creation date</div></div></div><p class="cp-help">This preview is visual only. Authentication and Discord account data remain unchanged.</p></div></aside></div></div></main></div></body>`,
  );
  body = body.replace(
    "document.getElementById('profile').addEventListener",
    `const cpForm=document.getElementById('profile');const cpName=cpForm.elements.username;const cpDate=cpForm.elements.createdAt;const cpUpdate=()=>{document.getElementById('cp-preview-name').textContent=cpName.value.trim()||'Custom name';document.getElementById('cp-preview-date').textContent=cpDate.value||'Custom creation date'};cpName.addEventListener('input',cpUpdate);cpDate.addEventListener('input',cpUpdate);cpUpdate();document.getElementById('profile').addEventListener`,
  );
  return body;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.onrender.com");
    if (request.method === "GET" && url.pathname === "/vencord-update.json") {
      sendManifest(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard") {
      interceptHtml(response, addDashboardLink);
    } else if (request.method === "GET" && url.pathname === "/custom-profile") {
      interceptHtml(response, dashboardCustomProfile);
    }
    listener(request, response);
  };
}

export function installVencordUpdateDashboardIntegration(): void {
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
