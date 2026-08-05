import http, { type RequestListener, type ServerResponse } from "node:http";

const UPDATE_VERSION = 47;
let installed = false;

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

function dashboardTabScript(): string {
  return `<script>
(() => {
  const nav = document.querySelector('.sidebar-nav');
  const wrap = document.querySelector('.dashboard-wrap');
  const dataNode = document.getElementById('jadges-data');
  if (!nav || !wrap || !dataNode || nav.querySelector('[data-dashboard-tab="customprofile"]')) return;

  let dashboardData = {};
  try { dashboardData = JSON.parse(dataNode.textContent || '{}'); } catch {}
  const userId = dashboardData && dashboardData.profile && dashboardData.profile.id;
  const realName = dashboardData && dashboardData.profile
    ? (dashboardData.profile.displayName || dashboardData.profile.username || 'Discord user')
    : 'Discord user';

  const link = document.createElement('a');
  link.className = 'nav-link';
  link.href = '#customprofile';
  link.dataset.dashboardTab = 'customprofile';
  link.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.4 3.5-7 8-7s7.2 2.6 8 7"/><path d="M18 4v4M16 6h4"/></svg>Custom Profile';
  const adminLink = Array.from(nav.querySelectorAll('.nav-link')).find(item => item.getAttribute('href') === '/admin');
  nav.insertBefore(link, adminLink || null);

  const style = document.createElement('style');
  style.textContent = '.custom-profile-page{padding-bottom:70px}.custom-profile-grid{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(320px,.88fr);gap:24px;align-items:start}.custom-profile-panel{background:linear-gradient(180deg,#111827,#0d1422);border:1px solid #252f43;border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.24)}.custom-profile-editor{padding:26px}.custom-profile-editor h2,.custom-profile-preview h2{margin:0;font-size:20px}.custom-profile-subtitle{margin:7px 0 22px;color:#909cb1}.custom-profile-field{display:block;margin-top:18px;font-weight:800}.custom-profile-field span{display:block;margin-bottom:8px}.custom-profile-field small{display:block;margin-top:7px;color:#77849a;font-weight:550}.custom-profile-input{width:100%;height:48px;padding:0 14px;border:1px solid #303b52;border-radius:11px;background:#080e19;color:#fff;font:inherit;outline:none}.custom-profile-input:focus{border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.15)}.custom-profile-note{margin-top:20px;padding:14px 15px;border:1px solid #2a3550;border-radius:12px;background:#0a1221;color:#aeb8ca}.custom-profile-actions{display:flex;align-items:center;gap:12px;margin-top:22px;flex-wrap:wrap}.custom-profile-save,.custom-profile-clear{padding:12px 18px;border-radius:11px;font:inherit;font-weight:850;cursor:pointer}.custom-profile-save{border:0;background:linear-gradient(135deg,#7657ff,#5f7cff);color:#fff}.custom-profile-clear{border:1px solid #303b52;background:transparent;color:#cbd2df}.custom-profile-status{color:#8ee3b0;font-weight:700}.custom-profile-preview{overflow:hidden}.custom-profile-preview-head{padding:22px 24px;border-bottom:1px solid #242e41}.custom-profile-preview-body{padding:26px}.custom-discord-card{overflow:hidden;border-radius:16px;background:#16181d;border:1px solid #30333b}.custom-profile-banner{height:98px;background:radial-gradient(circle at 18% 30%,rgba(154,119,255,.8),transparent 30%),linear-gradient(135deg,#322367,#19274f)}.custom-profile-card-body{padding:0 18px 20px}.custom-profile-avatar{width:74px;height:74px;margin-top:-37px;border:6px solid #16181d;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#7657ff,#35446d);font-size:28px;font-weight:900}.custom-profile-name{margin-top:11px;font-size:21px;font-weight:900}.custom-profile-original{margin-top:2px;color:#929aa8;font-size:12px}.custom-profile-divider{height:1px;margin:16px 0;background:#33363d}.custom-profile-label{color:#b9bec8;font-size:11px;font-weight:850;text-transform:uppercase}.custom-profile-value{margin-top:5px}.custom-profile-help{margin-top:16px;color:#7f8ba0;font-size:13px}@media(max-width:900px){.custom-profile-grid{grid-template-columns:1fr}}';
  document.head.append(style);

  function escapeAttribute(value) {
    return String(value || '').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  }

  function activateCustomLink() {
    nav.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
  }

  async function openCustomProfile() {
    activateCustomLink();
    let profile = {};
    try {
      const response = await fetch('/custom-profiles.json?t=' + Date.now(), { cache: 'no-store' });
      const profiles = await response.json();
      profile = profiles && profiles[userId] ? profiles[userId] : {};
    } catch {}

    const username = profile.username || '';
    const date = profile.createdAt ? String(profile.createdAt).slice(0, 10) : '';
    wrap.innerHTML = '<div class="custom-profile-page"><div class="page-heading"><h1>Custom Profile</h1><p>Change your cosmetic username and account creation date without leaving the dashboard. Your real Discord account is never changed.</p></div><div class="custom-profile-grid"><section class="custom-profile-panel custom-profile-editor"><h2>Profile details</h2><p class="custom-profile-subtitle">Leave a field blank to use the original Discord value.</p><form id="custom-profile-form"><label class="custom-profile-field"><span>Custom username</span><input class="custom-profile-input" id="custom-profile-name" maxlength="32" value="' + escapeAttribute(username) + '" placeholder="Enter a cosmetic name"><small>Used across supported Jadges profiles, messages, and sidebars.</small></label><label class="custom-profile-field"><span>Custom account creation date</span><input class="custom-profile-input" id="custom-profile-date" type="date" min="1900-01-01" value="' + escapeAttribute(date) + '"><small>Shown as the cosmetic Member Since date.</small></label><div class="custom-profile-note">Jadges keeps the original username and original creation date visible underneath the cosmetic values.</div><div class="custom-profile-actions"><button class="custom-profile-save" type="submit">Save changes</button><button class="custom-profile-clear" id="custom-profile-clear" type="button">Clear custom profile</button><span class="custom-profile-status" id="custom-profile-status"></span></div></form></section><aside class="custom-profile-panel custom-profile-preview"><div class="custom-profile-preview-head"><h2>Live preview</h2><p class="custom-profile-subtitle">A separate visual style inside the dashboard.</p></div><div class="custom-profile-preview-body"><div class="custom-discord-card"><div class="custom-profile-banner"></div><div class="custom-profile-card-body"><div class="custom-profile-avatar">J</div><div class="custom-profile-name" id="custom-profile-preview-name"></div><div class="custom-profile-original">Originally, ' + realName + '</div><div class="custom-profile-divider"></div><div class="custom-profile-label">Member Since</div><div class="custom-profile-value" id="custom-profile-preview-date"></div><div class="custom-profile-original">Originally, your real Discord account creation date</div></div></div><p class="custom-profile-help">This is visual only. Authentication and Discord account data remain unchanged.</p></div></aside></div></div>';

    const nameInput = document.getElementById('custom-profile-name');
    const dateInput = document.getElementById('custom-profile-date');
    const status = document.getElementById('custom-profile-status');
    const updatePreview = () => {
      document.getElementById('custom-profile-preview-name').textContent = nameInput.value.trim() || realName;
      document.getElementById('custom-profile-preview-date').textContent = dateInput.value || 'Original Discord date';
    };
    nameInput.addEventListener('input', updatePreview);
    dateInput.addEventListener('input', updatePreview);
    updatePreview();

    document.getElementById('custom-profile-form').addEventListener('submit', async event => {
      event.preventDefault();
      status.textContent = 'Saving…';
      const response = await fetch('/api/custom-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: nameInput.value, createdAt: dateInput.value }),
      });
      const result = await response.json().catch(() => ({}));
      status.textContent = response.ok ? 'Saved' : (result.error || 'Could not save');
    });

    document.getElementById('custom-profile-clear').addEventListener('click', async () => {
      nameInput.value = '';
      dateInput.value = '';
      updatePreview();
      status.textContent = 'Clearing…';
      const response = await fetch('/api/custom-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: '', createdAt: '' }),
      });
      status.textContent = response.ok ? 'Cleared' : 'Could not clear';
    });
  }

  link.addEventListener('click', event => {
    event.preventDefault();
    history.pushState(null, '', '/dashboard#customprofile');
    void openCustomProfile();
  });

  nav.querySelectorAll('.nav-link:not([data-dashboard-tab="customprofile"])').forEach(item => {
    item.addEventListener('click', () => {
      if (location.hash === '#customprofile' && item.getAttribute('href')?.startsWith('#')) location.reload();
    });
  });

  window.addEventListener('hashchange', () => {
    if (location.hash === '#customprofile') void openCustomProfile();
  });

  if (location.hash === '#customprofile') void openCustomProfile();
})();
</script>`;
}

function injectDashboardTab(response: ServerResponse): void {
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

    const nextBody = body.includes("data-dashboard-tab=\"customprofile\"")
      ? body
      : body.replace("</body>", `${dashboardTabScript()}</body>`);
    originalEnd(nextBody, "utf8", callback);
    return response;
  }) as typeof response.end;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.onrender.com");
    if (request.method === "GET" && url.pathname === "/vencord-update.json") {
      sendManifest(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard") {
      injectDashboardTab(response);
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
