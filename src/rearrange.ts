import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { NITRO_PRESETS } from "./presets.js";
import { publicImageUrl } from "./storage.js";
import { setObservedNativeBadges } from "./nativeStore.js";
import {
  getUser,
  readStore,
  setBadgeOrder,
  setBadgeSide,
} from "./store.js";
import type {
  BadgeSide,
  NativeBadgeObservation,
  UserRecord,
} from "./types.js";

const TICKET_LIFETIME_MS = 30 * 60 * 1000;
const SESSION_LIFETIME_MS = 60 * 60 * 1000;
const MAX_BODY_SIZE = 64 * 1024;
const SESSION_COOKIE = "jadges_session";
const NATIVE_REPORT_COOLDOWN_MS = 1_500;
const nativeReportTimes = new Map<string, number>();

interface TicketPayload {
  kind: "ticket";
  userId: string;
  expiresAt: number;
  nonce: string;
}

interface StatePayload {
  kind: "state";
  ticket: string;
  expiresAt: number;
  nonce: string;
}

interface SessionPayload {
  kind: "session";
  userId: string;
  expiresAt: number;
}

type SignedPayload = TicketPayload | StatePayload | SessionPayload;

interface RearrangeBadge {
  key: string;
  name: string;
  image: string;
  movable: boolean;
  subtitle: string;
}

interface RearrangePageData {
  badges: RearrangeBadge[];
  order: string[];
  side?: BadgeSide;
  hasNativeBadges: boolean;
}

type SystemStaffBadge = "staff" | "admin";
type ResolveSystemStaffBadge = (
  userId: string,
  user: UserRecord,
) => SystemStaffBadge | undefined;

interface PublicBadgeSettings {
  side?: BadgeSide;
  animationMode?: "always" | "hover" | "off";
  order: string[];
  nativeBadges: Array<{ key: string; name: string; image: string; }>;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret)
    .update(value)
    .digest("base64url");
}

function signPayload(payload: SignedPayload): string {
  const body = encode(JSON.stringify(payload));
  return `${body}.${signature(body)}`;
}

function verifyPayload<T extends SignedPayload>(
  token: string | null | undefined,
  kind: T["kind"],
): T | undefined {
  if (!token) return undefined;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return undefined;

  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decode(body)) as SignedPayload;
    if (payload.kind !== kind || payload.expiresAt <= Date.now()) return undefined;
    return payload as T;
  } catch {
    return undefined;
  }
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const session = verifyPayload<SessionPayload>(
    parseCookies(request)[SESSION_COOKIE],
    "session",
  );
  return session?.userId;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src https: data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
  response.end(html);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  cors = false,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": cors ? "*" : config.publicUrl,
    ...(cors
      ? {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        }
      : {}),
  });
  response.end(JSON.stringify(body));
}

function sendEmptyCors(response: ServerResponse): void {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  });
  response.end();
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  response.end();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pageShell(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0f1015; color: #f5f6f7; }
    .page { width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0; }
    .panel { background: #17181f; border: 1px solid #2a2c36; border-radius: 22px; padding: 28px; box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 42px); }
    .sub { color: #b5b8c4; margin-top: 10px; line-height: 1.55; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 46px; padding: 0 18px; margin-top: 22px; border: 0; border-radius: 12px; background: #5865f2; color: white; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
    .error { color: #ffb4ab; }
    .controls { display: grid; gap: 8px; margin: 26px 0; }
    label { font-weight: 700; }
    select { width: min(360px, 100%); padding: 12px 14px; border: 1px solid #343743; border-radius: 11px; background: #20222b; color: white; font: inherit; }
    .hint { color: #8f93a3; font-size: 13px; }
    .notice { margin: 16px 0; padding: 13px 15px; border: 1px solid #3b3e4b; border-radius: 12px; background: #20222b; color: #c5c8d2; line-height: 1.45; }
    .status { min-height: 22px; color: #9ee6b3; font-size: 14px; margin-bottom: 8px; }
    .badge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; }
    .badge-card { position: relative; min-height: 150px; padding: 18px; border: 1px solid #313440; border-radius: 16px; background: #20222a; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; user-select: none; transition: transform 120ms ease, outline-color 120ms ease; }
    .badge-card[data-movable="true"] { cursor: grab; }
    .badge-card[data-movable="true"]:active { cursor: grabbing; }
    .badge-card.dragging { opacity: .4; }
    .badge-card.over { outline: 2px solid #5865f2; transform: translateY(-2px); }
    .badge-card img { width: 58px; height: 58px; object-fit: contain; }
    .badge-name { font-weight: 800; }
    .badge-subtitle { color: #989cab; font-size: 12px; }
    .pin { position: absolute; top: 10px; right: 10px; padding: 4px 7px; border-radius: 999px; background: #2c2f3a; color: #c6c8d1; font-size: 10px; font-weight: 800; text-transform: uppercase; }
  </style>
</head>
<body><main class="page"><section class="panel">${content}</section></main></body>
</html>`;
}

function renderAuthorizationPage(ticket: string): string {
  const authorizeUrl = `/oauth/start?ticket=${encodeURIComponent(ticket)}`;
  return pageShell(
    "Authorize Jadges",
    `<h1>Authorize your Discord account</h1>
     <p class="sub">This private page can only be opened by the Discord account that ran <strong>/badge rearrange</strong>.</p>
     <a class="button" href="${authorizeUrl}">Continue with Discord</a>`,
  );
}

function renderErrorPage(message: string): string {
  return pageShell(
    "Jadges Error",
    `<h1>That link cannot be used</h1><p class="sub error">${escapeHtml(message)}</p>`,
  );
}

function renderRearrangePage(ticket: string, data: RearrangePageData): string {
  const safeData = JSON.stringify(data).replaceAll("<", "\\u003c");
  const safeTicket = JSON.stringify(ticket).replaceAll("<", "\\u003c");

  return pageShell(
    "Rearrange Jadges",
    `<h1>Rearrange your badges</h1>
     <p class="sub">Drag one badge onto another to swap their positions. Changes are saved immediately and only affect people using the Jadges plugin. The Jaycord Staff badge stays pinned first.</p>
     ${
       data.hasNativeBadges
         ? `<div class="notice">Native Discord badges detected by Jadges are included below and can be moved between your custom and Nitro badges.</div>`
         : `<div class="notice">No native Discord badges have been detected yet. Open your Discord profile once with the updated Jadges plugin enabled, wait a few seconds, then refresh this page.</div>`
     }
     <div class="controls">
       <label for="badge-side">Where should the badges appear?</label>
       <select id="badge-side">
         <option value="">Keep the current placement</option>
         <option value="left">Show Jadges badges on the left by default</option>
         <option value="right">Show Jadges badges on the right by default</option>
       </select>
       <div class="hint">This optional choice is used as the fallback for newly detected badges.</div>
     </div>
     <div id="status" class="status" aria-live="polite"></div>
     <div id="badge-grid" class="badge-grid"></div>
     <script>
       const ticket = ${safeTicket};
       let state = ${safeData};
       const grid = document.getElementById("badge-grid");
       const status = document.getElementById("status");
       const side = document.getElementById("badge-side");
       let draggingKey = null;
       let saving = false;

       side.value = state.side || "";

       function setStatus(text, isError = false) {
         status.textContent = text;
         status.style.color = isError ? "#ffb4ab" : "#9ee6b3";
       }

       async function save(patch) {
         if (saving) throw new Error("A badge change is already being saved.");
         saving = true;
         setStatus("Saving…");

         try {
           const response = await fetch("/api/rearrange?ticket=" + encodeURIComponent(ticket), {
             method: "POST",
             headers: { "content-type": "application/json" },
             credentials: "same-origin",
             body: JSON.stringify(patch)
           });
           const body = await response.json().catch(() => ({}));
           if (!response.ok) throw new Error(body.error || "Could not save changes");
           state = body;
           setStatus("Saved instantly.");
         } finally {
           saving = false;
         }
       }

       function render() {
         grid.replaceChildren();
         const byKey = new Map(state.badges.map(badge => [badge.key, badge]));
         const pinned = state.badges.filter(badge => !badge.movable);
         const movable = state.order.map(key => byKey.get(key)).filter(Boolean);

         for (const badge of [...pinned, ...movable]) {
           const card = document.createElement("article");
           card.className = "badge-card";
           card.dataset.key = badge.key;
           card.dataset.movable = String(badge.movable);
           card.draggable = badge.movable;

           const image = document.createElement("img");
           image.src = badge.image;
           image.alt = "";
           const name = document.createElement("div");
           name.className = "badge-name";
           name.textContent = badge.name;
           const subtitle = document.createElement("div");
           subtitle.className = "badge-subtitle";
           subtitle.textContent = badge.subtitle;

           card.append(image, name, subtitle);
           if (!badge.movable) {
             const pin = document.createElement("span");
             pin.className = "pin";
             pin.textContent = "Pinned";
             card.append(pin);
           }

           card.addEventListener("dragstart", event => {
             if (!badge.movable) return;
             draggingKey = badge.key;
             card.classList.add("dragging");
             event.dataTransfer.effectAllowed = "move";
           });
           card.addEventListener("dragend", () => {
             draggingKey = null;
             card.classList.remove("dragging");
             document.querySelectorAll(".over").forEach(item => item.classList.remove("over"));
           });
           card.addEventListener("dragover", event => {
             if (!badge.movable || !draggingKey || draggingKey === badge.key) return;
             event.preventDefault();
             card.classList.add("over");
           });
           card.addEventListener("dragleave", () => card.classList.remove("over"));
           card.addEventListener("drop", async event => {
             event.preventDefault();
             card.classList.remove("over");
             if (!badge.movable || !draggingKey || draggingKey === badge.key) return;

             const from = state.order.indexOf(draggingKey);
             const to = state.order.indexOf(badge.key);
             if (from === -1 || to === -1) return;

             const previousOrder = [...state.order];
             [state.order[from], state.order[to]] = [state.order[to], state.order[from]];
             render();

             try {
               await save({ order: state.order });
               render();
             } catch (error) {
               state.order = previousOrder;
               render();
               setStatus(error instanceof Error ? error.message : "Could not save changes", true);
             }
           });

           grid.append(card);
         }

         if (state.badges.length === 0) {
           const empty = document.createElement("p");
           empty.className = "sub";
           empty.textContent = "You do not have any badges available to rearrange yet.";
           grid.append(empty);
         }
       }

       side.addEventListener("change", async () => {
         const value = side.value;
         if (!value) return;
         try {
           await save({ side: value });
         } catch (error) {
           side.value = state.side || "";
           setStatus(error instanceof Error ? error.message : "Could not save placement", true);
         }
       });

       render();
     </script>`,
  );
}

function nativeBadgeIsVisible(user: UserRecord, key: string): boolean {
  if (key === "discord:nitro" && user.nitro) return false;
  if (
    key === "discord:boosting" &&
    user.nitro?.preset === "remove"
  ) {
    return false;
  }
  return true;
}

function orderedMovableKeys(user: UserRecord): string[] {
  const available = [
    ...user.badges
      .filter((badge) => !badge.pending)
      .map((badge) => `custom:${badge.id}`),
    ...(user.nitro && !user.nitro.pending && user.nitro.preset !== "remove"
      ? ["nitro"]
      : []),
    ...(user.nativeBadges || [])
      .filter((badge) => nativeBadgeIsVisible(user, badge.key))
      .map((badge) => badge.key),
  ];

  const availableSet = new Set(available);
  const ordered = (user.badgeOrder || []).filter((key) => availableSet.has(key));
  for (const key of available) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return ordered;
}

async function buildPageData(
  userId: string,
  origin: string,
  resolveSystemStaffBadge: ResolveSystemStaffBadge,
): Promise<RearrangePageData> {
  const user = await getUser(userId);
  const badges: RearrangeBadge[] = [];
  const systemStaffBadge = resolveSystemStaffBadge(userId, user);

  if (systemStaffBadge) {
    const isAdmin = systemStaffBadge === "admin";
    badges.push({
      key: "staff",
      name: isAdmin ? "Jaycord Admin" : "Jaycord Staff",
      image: isAdmin ? config.jaycordAdminBadgeUrl : config.jaycordStaffBadgeUrl,
      movable: false,
      subtitle: "Pinned first",
    });
  }

  for (const badge of user.badges.filter((item) => !item.pending)) {
    badges.push({
      key: `custom:${badge.id}`,
      name: badge.name,
      image: publicImageUrl(badge.filename, origin),
      movable: true,
      subtitle: "Custom Jadges badge",
    });
  }

  if (user.nitro && !user.nitro.pending && user.nitro.preset !== "remove") {
    const preset = NITRO_PRESETS[user.nitro.preset];
    badges.push({
      key: "nitro",
      name: `${preset.label} Nitro`,
      image: preset.profileIcon,
      movable: true,
      subtitle: "Jadges Nitro badge",
    });
  }

  for (const badge of user.nativeBadges || []) {
    if (!nativeBadgeIsVisible(user, badge.key)) continue;
    badges.push({
      key: badge.key,
      name: badge.name,
      image: badge.image,
      movable: true,
      subtitle: "Native Discord badge",
    });
  }

  return {
    badges,
    order: orderedMovableKeys(user),
    side: user.badgeSide,
    hasNativeBadges: badges.some((badge) => badge.key.startsWith("discord:")),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authenticate(
  request: IncomingMessage,
  ticketToken: string | null,
): TicketPayload | undefined {
  const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
  if (!ticket) return undefined;
  return sessionUserId(request) === ticket.userId ? ticket : undefined;
}

function cleanNativeBadge(value: unknown): Omit<NativeBadgeObservation, "updatedAt"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const badge = value as { key?: unknown; name?: unknown; image?: unknown };

  const key = typeof badge.key === "string" ? badge.key.trim().toLowerCase() : "";
  const name = typeof badge.name === "string" ? badge.name.trim().slice(0, 100) : "";
  const image = typeof badge.image === "string" ? badge.image.trim().slice(0, 600) : "";

  if (!/^discord:[a-z0-9][a-z0-9._:-]{0,95}$/.test(key)) return undefined;
  if (!name) return undefined;

  try {
    const url = new URL(image);
    if (url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }

  return { key, name, image };
}

async function handleNativeBadgeReport(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "OPTIONS") {
    sendEmptyCors(response);
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" }, true);
    return;
  }

  try {
    const body = await readJson(request) as { userId?: unknown; badges?: unknown };
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!/^\d{15,22}$/.test(userId)) {
      throw new Error("Invalid Discord user ID");
    }

    const now = Date.now();
    const last = nativeReportTimes.get(userId) || 0;
    if (now - last < NATIVE_REPORT_COOLDOWN_MS) {
      sendJson(response, 202, { ok: true, throttled: true }, true);
      return;
    }
    nativeReportTimes.set(userId, now);

    if (!Array.isArray(body.badges) || body.badges.length > 25) {
      throw new Error("Invalid native badge list");
    }

    const updatedAt = new Date().toISOString();
    const unique = new Map<string, NativeBadgeObservation>();
    for (const value of body.badges) {
      const badge = cleanNativeBadge(value);
      if (!badge || unique.has(badge.key)) continue;
      unique.set(badge.key, { ...badge, updatedAt });
    }

    await setObservedNativeBadges(userId, [...unique.values()]);
    sendJson(response, 200, { ok: true, count: unique.size }, true);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    }, true);
  }
}

export function isRearrangeConfigured(): boolean {
  return Boolean(config.discordClientSecret && config.publicUrl.startsWith("https://"));
}

export function createRearrangeTicket(userId: string): string {
  return signPayload({
    kind: "ticket",
    userId,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
    nonce: randomBytes(12).toString("hex"),
  });
}

export async function handleRearrangeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
  resolveSystemStaffBadge: ResolveSystemStaffBadge,
): Promise<boolean> {
  if (url.pathname === "/settings.json") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" }, true);
      return true;
    }

    const data = await readStore();
    const result: Record<string, PublicBadgeSettings> = {};

    for (const [userId, user] of Object.entries(data.users)) {
      if (
        !user.badgeSide &&
        !user.badgeAnimationMode &&
        !user.badgeOrder?.length &&
        !user.nativeBadges?.length
      ) {
        continue;
      }

      result[userId] = {
        side: user.badgeSide,
        animationMode: user.badgeAnimationMode || "always",
        order: user.badgeOrder ? [...user.badgeOrder] : [],
        nativeBadges: (user.nativeBadges || []).map((badge) => ({
          key: badge.key,
          name: badge.name,
          image: badge.image,
        })),
      };
    }

    sendJson(response, 200, result, true);
    return true;
  }

  if (url.pathname === "/api/native-badges") {
    await handleNativeBadgeReport(request, response);
    return true;
  }

  if (url.pathname === "/rearrange") {
    const ticketToken = url.searchParams.get("ticket");
    const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
    if (!ticket || !ticketToken) {
      sendHtml(response, 400, renderErrorPage("This rearrangement link is invalid or expired."));
      return true;
    }

    if (sessionUserId(request) !== ticket.userId) {
      sendHtml(response, 200, renderAuthorizationPage(ticketToken));
      return true;
    }

    const data = await buildPageData(
      ticket.userId,
      origin,
      resolveSystemStaffBadge,
    );
    sendHtml(response, 200, renderRearrangePage(ticketToken, data));
    return true;
  }

  if (url.pathname === "/oauth/start") {
    const ticketToken = url.searchParams.get("ticket");
    const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
    if (!ticket || !ticketToken) {
      sendHtml(response, 400, renderErrorPage("This rearrangement link is invalid or expired."));
      return true;
    }
    if (!config.discordClientSecret) {
      sendHtml(response, 503, renderErrorPage("Discord OAuth has not been configured yet."));
      return true;
    }

    const state = signPayload({
      kind: "state",
      ticket: ticketToken,
      expiresAt: Date.now() + 10 * 60 * 1000,
      nonce: randomBytes(12).toString("hex"),
    });
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("redirect_uri", `${config.publicUrl}/oauth/callback`);
    authorize.searchParams.set("scope", "identify");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("prompt", "consent");
    redirect(response, authorize.toString());
    return true;
  }

  if (url.pathname === "/oauth/callback") {
    const state = verifyPayload<StatePayload>(url.searchParams.get("state"), "state");
    const code = url.searchParams.get("code");
    const ticket = state
      ? verifyPayload<TicketPayload>(state.ticket, "ticket")
      : undefined;

    if (!state || !ticket || !code || !config.discordClientSecret) {
      sendHtml(response, 400, renderErrorPage("Discord authorization could not be verified."));
      return true;
    }

    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.discordClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${config.publicUrl}/oauth/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenResponse.ok) {
      sendHtml(response, 502, renderErrorPage("Discord rejected the authorization request."));
      return true;
    }

    const tokenData = await tokenResponse.json() as { access_token?: string };
    if (!tokenData.access_token) {
      sendHtml(response, 502, renderErrorPage("Discord did not return an access token."));
      return true;
    }

    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const discordUser = userResponse.ok
      ? await userResponse.json() as { id?: string }
      : undefined;

    if (!discordUser?.id || discordUser.id !== ticket.userId) {
      sendHtml(
        response,
        403,
        renderErrorPage("You must authorize the same Discord account that ran the command."),
      );
      return true;
    }

    const session = signPayload({
      kind: "session",
      userId: ticket.userId,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    });
    const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
    response.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secure}`,
    );
    redirect(response, `/rearrange?ticket=${encodeURIComponent(state.ticket)}`);
    return true;
  }

  if (url.pathname === "/api/rearrange") {
    const ticketToken = url.searchParams.get("ticket");
    const ticket = authenticate(request, ticketToken);
    if (!ticket) {
      sendJson(response, 401, { error: "Authorization is required or the link expired." });
      return true;
    }

    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await buildPageData(ticket.userId, origin, resolveSystemStaffBadge),
      );
      return true;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }

    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== origin && requestOrigin !== config.publicUrl) {
      sendJson(response, 403, { error: "Origin check failed" });
      return true;
    }

    try {
      const body = await readJson(request) as { order?: unknown; side?: unknown };
      const user = await getUser(ticket.userId);

      if (body.order !== undefined) {
        if (!Array.isArray(body.order) || !body.order.every((item) => typeof item === "string")) {
          throw new Error("Invalid badge order");
        }
        const available = orderedMovableKeys(user);
        const availableSet = new Set(available);
        const supplied = [...new Set(body.order)];

        if (supplied.some((value) => !availableSet.has(value))) {
          throw new Error("One of those badges is no longer available");
        }

        // A profile can detect another native badge while this page is open.
        // Preserve the submitted order and append newly detected badges instead
        // of rejecting the whole save.
        const mergedOrder = [
          ...supplied,
          ...available.filter((value) => !supplied.includes(value)),
        ];
        await setBadgeOrder(ticket.userId, mergedOrder);
      }

      if (body.side !== undefined) {
        if (body.side !== "left" && body.side !== "right") {
          throw new Error("Invalid badge placement");
        }
        await setBadgeSide(ticket.userId, body.side);
      }

      sendJson(
        response,
        200,
        await buildPageData(ticket.userId, origin, resolveSystemStaffBadge),
      );
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid request",
      });
    }
    return true;
  }

  return false;
}
