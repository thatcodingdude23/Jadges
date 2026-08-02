import {
  MAX_PRESET_NAME_LENGTH,
  MAX_PRESET_UPLOAD_SIZE,
  presetImageUrl,
  type PresetRecord,
} from "./presetStore.js";

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function logoMarkup(): string {
  return `<svg class="logo-mark" viewBox="0 0 48 54" aria-hidden="true">
    <defs><linearGradient id="preset-logo" x1="5" y1="3" x2="43" y2="49"><stop stop-color="#b89cff"/><stop offset=".5" stop-color="#7c4dff"/><stop offset="1" stop-color="#5b8cff"/></linearGradient></defs>
    <path d="M24 2.8 43 10v14.2c0 12.2-7.7 22.3-19 27.1C12.7 46.5 5 36.4 5 24.2V10l19-7.2Z" fill="url(#preset-logo)"/>
    <path d="M24 7.4 38.5 13v11.1c0 9.4-5.6 17.3-14.5 21.5C15.1 41.4 9.5 33.5 9.5 24.1V13L24 7.4Z" fill="#0b1020" opacity=".92"/>
    <path d="m24 14.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9 2.9-5.9Z" fill="white"/>
  </svg>`;
}

function pageHead(title: string, description: string): string {
  return `<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#070b14">
    <meta name="description" content="${escapeHtml(description)}">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/assets/jadges.css">
    <link rel="stylesheet" href="/assets/presets.css">
  </head>`;
}

function defaultAvatarIndex(userId: string): number {
  try {
    return Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    return 0;
  }
}

export function discordAvatar(user: DiscordUser): string {
  if (user.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${extension}?size=256`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(user.id)}.png`;
}

function accountHeader(user: DiscordUser): string {
  const displayName = user.global_name?.trim() || user.username?.trim() || "Discord User";
  const username = user.username?.trim() || "discord-user";
  return `<header class="preset-header">
    <a class="site-logo" href="/">${logoMarkup()}<span>Jadges</span></a>
    <nav class="preset-nav" aria-label="Main navigation">
      <a href="/dashboard">Dashboard</a>
      <a class="active" href="/presets">Presets</a>
    </nav>
    <div class="preset-account">
      <img src="${escapeHtml(discordAvatar(user))}" alt="">
      <div><strong>${escapeHtml(displayName)}</strong><span>@${escapeHtml(username)}</span></div>
      <form action="/logout" method="post"><button type="submit">Log out</button></form>
    </div>
  </header>`;
}

function profilePreview(user: DiscordUser, preset: PresetRecord): string {
  const displayName = user.global_name?.trim() || user.username?.trim() || "Discord User";
  const username = user.username?.trim() || "discord-user";
  return `<div class="preset-profile-card large">
    <div class="preset-profile-banner"></div>
    <div class="preset-profile-content">
      <img class="preset-profile-avatar" src="${escapeHtml(discordAvatar(user))}" alt="">
      <div class="preset-profile-badges"><img src="${escapeHtml(presetImageUrl(preset))}" alt="${escapeHtml(preset.name)}"></div>
      <strong class="preset-profile-name">${escapeHtml(displayName)}</strong>
      <span class="preset-profile-username">${escapeHtml(username)}</span>
      <div class="preset-profile-divider"></div>
      <small>BADGE PREVIEW</small>
      <p>This is how <strong>${escapeHtml(preset.name)}</strong> will appear with Jadges enabled.</p>
    </div>
  </div>`;
}

function shell(
  title: string,
  description: string,
  user: DiscordUser,
  body: string,
  scriptData?: unknown,
): string {
  const data = scriptData === undefined
    ? ""
    : `<script id="preset-data" type="application/json">${JSON.stringify(scriptData).replaceAll("<", "\\u003c")}</script>`;
  return `<!doctype html><html lang="en">${pageHead(title, description)}<body class="preset-body">
    ${accountHeader(user)}
    <main class="preset-main">${body}</main>
    ${data}<script src="/assets/presets.js" defer></script>
  </body></html>`;
}

export function presetsPage(user: DiscordUser, presets: PresetRecord[], uploaded: boolean): string {
  const toast = uploaded
    ? `<div class="preset-toast success" role="status"><span class="preset-check">✓</span><span>image uploaded successfully</span></div>`
    : "";
  const content = presets.length === 0
    ? `<section class="preset-empty">
        <div class="preset-empty-icon">✦</div>
        <h2>No presets have been uploaded yet.</h2>
        <p>Be the first to share a badge with the Jadges community.</p>
        <a class="discord-button" href="/presets/upload">Upload Badge</a>
      </section>`
    : `<section class="preset-grid" aria-label="Community presets">
        ${presets.map((preset) => `<a class="preset-card" href="/presets/${encodeURIComponent(preset.id)}">
          <div class="preset-card-image"><img src="${escapeHtml(presetImageUrl(preset))}" alt=""></div>
          <div class="preset-card-copy"><strong>${escapeHtml(preset.name)}</strong><span>by @${escapeHtml(preset.uploaderUsername)}</span></div>
          <div class="preset-card-meta">${preset.claims} ${preset.claims === 1 ? "claim" : "claims"}</div>
        </a>`).join("")}
      </section>`;

  return shell(
    "Presets — Jadges",
    "Browse and share community-made Jadges badge presets.",
    user,
    `${toast}<section class="preset-heading-row">
      <div><h1>Community Presets</h1><p>Discover badge icons shared by the Jadges community and add them to your profile instantly.</p></div>
      <a class="discord-button" href="/presets/upload">Upload Badge</a>
    </section>${content}`,
  );
}

export function uploadPage(user: DiscordUser): string {
  return shell(
    "Upload a preset — Jadges",
    "Upload and preview a community Jadges badge preset.",
    user,
    `<a class="preset-back" href="/presets">← Back to Presets</a>
    <section class="preset-upload-layout">
      <div class="preset-upload-panel">
        <div class="preset-upload-copy"><h1>Upload a badge preset</h1><p>Choose an image, give it a name, and review exactly how it will look before sharing it.</p></div>
        <div class="preset-picker" id="preset-picker">
          <input id="preset-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/apng" hidden>
          <div class="preset-picker-icon">＋</div><strong>Add an image</strong>
          <span>PNG, JPG, WEBP, GIF, or APNG up to ${Math.floor(MAX_PRESET_UPLOAD_SIZE / 1024 / 1024)} MB</span>
          <button class="discord-button" id="choose-preset-image" type="button">Choose Image</button>
        </div>
        <form class="preset-confirm-form is-hidden" id="preset-confirm-form">
          <label for="preset-name">Badge name</label>
          <input id="preset-name" maxlength="${MAX_PRESET_NAME_LENGTH}" autocomplete="off" required placeholder="Enter a badge name">
          <div class="preset-selected-image"><img id="selected-preset-image" alt="Selected badge preview"></div>
          <button class="discord-button" id="confirm-preset-upload" type="submit">Confirm Upload</button>
          <button class="secondary-button" id="change-preset-image" type="button">Choose a different image</button>
          <p class="preset-form-error" id="preset-form-error" role="alert"></p>
        </form>
      </div>
      <aside class="preset-preview-column">
        <h2>Profile preview</h2><p>The preview updates after you choose an image.</p>
        <div class="preset-profile-card large" id="upload-profile-preview">
          <div class="preset-profile-banner"></div><div class="preset-profile-content">
            <img class="preset-profile-avatar" src="${escapeHtml(discordAvatar(user))}" alt="">
            <div class="preset-profile-badges"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt=""></div>
            <strong class="preset-profile-name">${escapeHtml(user.global_name || user.username || "Discord User")}</strong>
            <span class="preset-profile-username">${escapeHtml(user.username || "discord-user")}</span>
            <div class="preset-profile-divider"></div><small>BADGE PREVIEW</small><p>This is how Your badge will appear with Jadges enabled.</p>
          </div>
        </div>
      </aside>
    </section>`,
    { page: "upload", maxBytes: MAX_PRESET_UPLOAD_SIZE },
  );
}

export function detailPage(user: DiscordUser, preset: PresetRecord): string {
  return shell(
    `${preset.name} — Jadges Presets`,
    `Preview and add the ${preset.name} badge preset to your Jadges profile.`,
    user,
    `<a class="preset-back" href="/presets">← Back to Presets</a>
    <section class="preset-detail-layout">
      <div class="preset-detail-copy">
        <div class="preset-detail-icon"><img src="${escapeHtml(presetImageUrl(preset))}" alt=""></div>
        <span class="preset-detail-label">Community preset</span><h1>${escapeHtml(preset.name)}</h1>
        <p>Uploaded by <strong>@${escapeHtml(preset.uploaderUsername)}</strong>. Add a personal copy directly to your Jadges profile.</p>
        <button class="discord-button" id="get-preset-badge" type="button">Get Badge</button>
        <div class="preset-claim-message" id="preset-claim-message" role="status"></div>
      </div>
      <aside class="preset-preview-column"><h2>Profile preview</h2><p>This badge will be added immediately after you confirm.</p>${profilePreview(user, preset)}</aside>
    </section>`,
    { page: "detail", presetId: preset.id },
  );
}

export function errorPage(user: DiscordUser | undefined, title: string, message: string): string {
  if (user) {
    return shell(
      `${title} — Jadges`,
      message,
      user,
      `<section class="preset-empty"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="secondary-button" href="/presets">Return to Presets</a></section>`,
    );
  }
  return `<!doctype html><html lang="en">${pageHead(`${title} — Jadges`, message)}<body class="preset-body"><main class="preset-main"><section class="preset-empty"><a class="site-logo" href="/">${logoMarkup()}<span>Jadges</span></a><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="secondary-button" href="/">Return home</a></section></main></body></html>`;
}
