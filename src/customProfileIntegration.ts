import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import path from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel,
  type User,
} from "discord.js";
import { config } from "./config.js";

interface CustomProfile {
  username?: string;
  createdAt?: string;
}

type CustomProfiles = Record<string, CustomProfile>;
type RequestStatus = "pending" | "processing" | "approved" | "denied";

interface CustomProfileRequest {
  id: string;
  userId: string;
  username?: string;
  createdAt?: string;
  status: RequestStatus;
  submittedAt: string;
  reviewedAt?: string;
  reviewerId?: string;
  reviewMessageId?: string;
  authorizedDisplayName: string;
  authorizedUsername: string;
  authorizedAvatarUrl: string;
}

interface RequestStore {
  requests: Record<string, CustomProfileRequest>;
  latestByUser: Record<string, string>;
}

const STORE_FILE = path.join(config.dataDir, "custom-profiles.json");
const REQUEST_STORE_FILE = path.join(config.dataDir, "custom-profile-requests.json");
const SESSION_COOKIE = "jadges_session";
const REVIEW_CHANNEL_ID = "1534597761993805904";
const PENDING_MESSAGE = "your custom profile is now waiting for approval";
const DENIED_MESSAGE = "your custom profile has been denied";
const APPROVED_MESSAGE = "your custom profile has been accepted";
let installed = false;
let moderationInstalled = false;
let moderationClient: Client | undefined;
let profileWriteQueue: Promise<void> = Promise.resolve();
let requestWriteQueue: Promise<void> = Promise.resolve();

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret).update(value).digest("base64url");
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const cookie = (request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const raw = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    const token = decodeURIComponent(raw);
    const [body, suppliedSignature, extra] = token.split(".");
    if (!body || !suppliedSignature || extra) return undefined;
    const expected = Buffer.from(signature(body));
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { kind?: unknown; userId?: unknown; expiresAt?: unknown };
    if (payload.kind !== "session" || typeof payload.userId !== "string" || !/^\d{15,22}$/.test(payload.userId) || typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return undefined;
    return payload.userId;
  } catch {
    return undefined;
  }
}

async function ensureJsonFile(filename: string, fallback: unknown): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    await readFile(filename, "utf8");
  } catch {
    await writeFile(filename, JSON.stringify(fallback, null, 2), "utf8");
  }
}

async function readProfilesUnsafe(): Promise<CustomProfiles> {
  await ensureJsonFile(STORE_FILE, {});
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CustomProfiles : {};
  } catch {
    return {};
  }
}

async function readProfiles(): Promise<CustomProfiles> {
  await profileWriteQueue;
  return readProfilesUnsafe();
}

async function mutateProfiles(change: (profiles: CustomProfiles) => void): Promise<void> {
  const operation = profileWriteQueue.then(async () => {
    const profiles = await readProfilesUnsafe();
    change(profiles);
    const temporary = `${STORE_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(profiles, null, 2), "utf8");
    await rename(temporary, STORE_FILE);
  });
  profileWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function emptyRequestStore(): RequestStore {
  return { requests: {}, latestByUser: {} };
}

async function readRequestStoreUnsafe(): Promise<RequestStore> {
  await ensureJsonFile(REQUEST_STORE_FILE, emptyRequestStore());
  try {
    const parsed = JSON.parse(await readFile(REQUEST_STORE_FILE, "utf8")) as Partial<RequestStore>;
    return {
      requests: parsed.requests && typeof parsed.requests === "object" ? parsed.requests : {},
      latestByUser: parsed.latestByUser && typeof parsed.latestByUser === "object" ? parsed.latestByUser : {},
    };
  } catch {
    return emptyRequestStore();
  }
}

async function readRequestStore(): Promise<RequestStore> {
  await requestWriteQueue;
  return readRequestStoreUnsafe();
}

async function mutateRequestStore<T>(change: (store: RequestStore) => T | Promise<T>): Promise<T> {
  const operation = requestWriteQueue.then(async () => {
    const store = await readRequestStoreUnsafe();
    const result = await change(store);
    const temporary = `${REQUEST_STORE_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
    await rename(temporary, REQUEST_STORE_FILE);
    return result;
  });
  requestWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function latestRequest(userId: string): Promise<CustomProfileRequest | undefined> {
  const store = await readRequestStore();
  const requestId = store.latestByUser[userId];
  return requestId ? store.requests[requestId] : undefined;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new Error("Request is too large");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Record<string, unknown>;
}

function cleanUsername(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Custom username must be text");
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  if (cleaned.length > 32) throw new Error("Custom username can contain up to 32 characters");
  return cleaned;
}

function cleanDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Choose a valid date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid date");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1900 || date > new Date()) throw new Error("Choose a date between 1900 and today");
  return date.toISOString();
}

function requestedUsername(request: CustomProfileRequest): string {
  return request.username || "Use the original Discord username";
}

function requestedDate(request: CustomProfileRequest): string {
  if (!request.createdAt) return "Use the original Discord account date";
  return new Date(request.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function statusMessage(status: RequestStatus): string {
  if (status === "approved") return APPROVED_MESSAGE;
  if (status === "denied") return DENIED_MESSAGE;
  return PENDING_MESSAGE;
}

function publicRequest(request: CustomProfileRequest | undefined): unknown {
  if (!request) return null;
  return {
    id: request.id,
    username: request.username,
    createdAt: request.createdAt,
    status: request.status === "processing" ? "pending" : request.status,
    submittedAt: request.submittedAt,
    reviewedAt: request.reviewedAt,
    message: statusMessage(request.status),
  };
}

function alertMarkup(request: CustomProfileRequest | undefined): string {
  if (!request) return "";
  const status = request.status === "processing" ? "pending" : request.status;
  const kind = status === "approved" ? "accepted" : status;
  return `<div class="approval-alert ${kind}">${escapeHtml(statusMessage(request.status))}</div>`;
}

function page(profile: CustomProfile, request: CustomProfileRequest | undefined): string {
  const date = profile.createdAt ? profile.createdAt.slice(0, 10) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Custom Profile • Jadges</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#080b13;color:#f7f8fc;font:15px/1.5 Inter,system-ui,sans-serif}.wrap{width:min(720px,calc(100% - 28px));margin:40px auto}.card{background:#111827;border:1px solid #2a344a;border-radius:20px;padding:24px}h1{margin:0 0 8px;font-size:34px}p{color:#aeb7c8}label{display:block;margin-top:18px;font-weight:800}input{width:100%;margin-top:7px;padding:13px;border:1px solid #33405a;border-radius:11px;background:#090e19;color:white;font:inherit}button,a{display:inline-block;margin-top:20px;padding:11px 15px;border-radius:11px;text-decoration:none;font-weight:800}button{border:0;background:#7c5cff;color:white;cursor:pointer}a{color:#d6dcf0;border:1px solid #33405a;margin-left:8px}.note{padding:12px;border-radius:11px;background:#0b1222}.approval-alert{margin:16px 0;padding:13px 15px;border:1px solid;border-radius:12px;font-weight:800}.approval-alert.pending{background:#3b3212;border-color:#8b7628;color:#ffe58a}.approval-alert.denied{background:#3b1519;border-color:#8f3038;color:#ff9ca4}.approval-alert.accepted{background:#123523;border-color:#267d4e;color:#8aebb0}</style></head><body><main class="wrap"><section class="card"><h1>Custom Profile</h1><p>These values are cosmetic and only appear to people using a supported Jadges client. Your real Discord account is never changed.</p>${alertMarkup(request)}<form id="profile"><label>Custom username<input name="username" maxlength="32" value="${escapeHtml(profile.username || "")}" placeholder="Luck"></label><label>Custom account creation date<input name="createdAt" type="date" min="1900-01-01" value="${escapeHtml(date)}"></label><p class="note">Jadges will also show <b>Originally, your real username</b> and the original Discord account creation date.</p><button type="submit">Submit for approval</button><a href="/dashboard#customprofile">Dashboard</a></form><script>document.getElementById('profile').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const r=await fetch('/api/custom-profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.get('username'),createdAt:f.get('createdAt')})});const j=await r.json().catch(()=>({}));if(!r.ok){alert(j.error||'Could not submit');return}location.reload()});</script></section></main></body></html>`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function accountDisplayName(user: User): string {
  return user.globalName?.trim() || user.username;
}

function approvalEmbed(request: CustomProfileRequest, state: "pending" | "approved" | "denied", reviewerId?: string): EmbedBuilder {
  const color = state === "approved" ? 0x57f287 : state === "denied" ? 0xed4245 : 0xfee75c;
  const title = state === "approved"
    ? "Custom profile accepted"
    : state === "denied"
      ? "Custom profile denied"
      : "Custom profile approval request";
  const description = state === "pending"
    ? "Review this cosmetic profile request. Nothing changes unless **Approve** is pressed."
    : `This request was **${state}**${reviewerId ? ` by <@${reviewerId}>` : ""}.`;

  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: title, iconURL: request.authorizedAvatarUrl })
    .setThumbnail(request.authorizedAvatarUrl)
    .setDescription(description)
    .addFields(
      { name: "Requested username", value: requestedUsername(request), inline: true },
      { name: "Requested account date", value: requestedDate(request), inline: true },
      {
        name: "Authorized account",
        value: `<@${request.userId}>\n**Display name:** ${request.authorizedDisplayName}\n**Username:** @${request.authorizedUsername}\n**User ID:** \`${request.userId}\``,
      },
    )
    .setFooter({ text: `Request ${request.id}` })
    .setTimestamp(new Date(state === "pending" ? request.submittedAt : request.reviewedAt || Date.now()));
}

function reviewButtons(requestId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`custom-profile:approve:${requestId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`custom-profile:deny:${requestId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
}

function outcomeDmEmbed(request: CustomProfileRequest, approved: boolean): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(approved ? 0x57f287 : 0xed4245)
    .setAuthor({
      name: approved ? "Custom profile accepted" : "Custom profile denied",
      iconURL: request.authorizedAvatarUrl,
    })
    .setDescription(approved ? APPROVED_MESSAGE : DENIED_MESSAGE)
    .addFields(
      { name: "Requested username", value: requestedUsername(request), inline: true },
      { name: "Requested account date", value: requestedDate(request), inline: true },
    )
    .setFooter({ text: "Jadges • Custom profile review" })
    .setTimestamp();
}

async function submitApprovalRequest(userId: string, username?: string, createdAt?: string): Promise<CustomProfileRequest> {
  if (!moderationClient) throw new Error("Custom profile approvals are not ready yet");
  const account = await moderationClient.users.fetch(userId);
  const request: CustomProfileRequest = {
    id: randomUUID(),
    userId,
    username,
    createdAt,
    status: "pending",
    submittedAt: new Date().toISOString(),
    authorizedDisplayName: accountDisplayName(account),
    authorizedUsername: account.username,
    authorizedAvatarUrl: account.displayAvatarURL({ size: 256 }),
  };

  await mutateRequestStore((store) => {
    const previousId = store.latestByUser[userId];
    const previous = previousId ? store.requests[previousId] : undefined;
    if (previous?.status === "pending" || previous?.status === "processing") {
      throw new Error("You already have a custom profile request waiting for approval");
    }
    store.requests[request.id] = request;
    store.latestByUser[userId] = request.id;
  });

  try {
    const channel = await moderationClient.channels.fetch(REVIEW_CHANNEL_ID);
    if (!(channel instanceof TextChannel)) throw new Error(`Channel ${REVIEW_CHANNEL_ID} is not a text channel`);
    const message = await channel.send({ embeds: [approvalEmbed(request, "pending")], components: [reviewButtons(request.id)] });
    await mutateRequestStore((store) => {
      const saved = store.requests[request.id];
      if (saved) saved.reviewMessageId = message.id;
    });
    request.reviewMessageId = message.id;
    return request;
  } catch (error) {
    await mutateRequestStore((store) => {
      delete store.requests[request.id];
      if (store.latestByUser[userId] === request.id) delete store.latestByUser[userId];
    });
    throw new Error(error instanceof Error ? `Could not send the approval request: ${error.message}` : "Could not send the approval request");
  }
}

function canReview(interaction: ButtonInteraction): boolean {
  if (!interaction.inCachedGuild()) return false;
  return interaction.member.roles.cache.has(config.verifierRole)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

async function claimRequest(requestId: string, reviewerId: string): Promise<CustomProfileRequest | undefined> {
  return mutateRequestStore((store) => {
    const request = store.requests[requestId];
    if (!request || request.status !== "pending") return undefined;
    request.status = "processing";
    request.reviewerId = reviewerId;
    return { ...request };
  });
}

async function finishRequest(requestId: string, status: "approved" | "denied", reviewerId: string): Promise<CustomProfileRequest> {
  return mutateRequestStore((store) => {
    const request = store.requests[requestId];
    if (!request) throw new Error("Request no longer exists");
    request.status = status;
    request.reviewerId = reviewerId;
    request.reviewedAt = new Date().toISOString();
    return { ...request };
  });
}

async function restorePending(requestId: string): Promise<void> {
  await mutateRequestStore((store) => {
    const request = store.requests[requestId];
    if (request?.status === "processing") {
      request.status = "pending";
      delete request.reviewerId;
    }
  });
}

async function processReview(interaction: ButtonInteraction, requestId: string, approve: boolean): Promise<void> {
  if (interaction.channelId !== REVIEW_CHANNEL_ID) {
    await interaction.reply({ content: "Custom profile reviews can only be processed in the configured review channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canReview(interaction)) {
    await interaction.reply({ content: "You do not have permission to review custom profiles.", flags: MessageFlags.Ephemeral });
    return;
  }

  const request = await claimRequest(requestId, interaction.user.id);
  if (!request) {
    await interaction.reply({ content: "This custom profile request has already been processed.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  try {
    if (approve) {
      await mutateProfiles((profiles) => {
        if (!request.username && !request.createdAt) delete profiles[request.userId];
        else profiles[request.userId] = { username: request.username, createdAt: request.createdAt };
      });
    }

    const finished = await finishRequest(requestId, approve ? "approved" : "denied", interaction.user.id);
    await interaction.message.edit({
      embeds: [approvalEmbed(finished, approve ? "approved" : "denied", interaction.user.id)],
      components: [],
    });

    try {
      const user = await interaction.client.users.fetch(finished.userId);
      await user.send({ embeds: [outcomeDmEmbed(finished, approve)] });
    } catch (error) {
      console.warn(`Could not DM custom profile ${approve ? "approval" : "denial"} to ${finished.userId}:`, error);
    }

    await interaction.followUp({
      content: approve ? "Custom profile approved and applied." : "Custom profile denied. No profile values were changed.",
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await restorePending(requestId);
    console.error("Could not process custom profile review:", error);
    await interaction.followUp({ content: "Could not process this request. It has been returned to pending.", flags: MessageFlags.Ephemeral });
  }
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", config.publicUrl);
    if (request.method === "GET" && url.pathname === "/custom-profiles.json") {
      void readProfiles().then((profiles) => sendJson(response, 200, profiles));
      return;
    }
    if (url.pathname === "/api/custom-profile/status" && request.method === "GET") {
      const userId = sessionUserId(request);
      if (!userId) {
        sendJson(response, 401, { error: "Login required" });
        return;
      }
      void Promise.all([readProfiles(), latestRequest(userId)])
        .then(([profiles, latest]) => sendJson(response, 200, { profile: profiles[userId] || null, request: publicRequest(latest) }))
        .catch((error) => sendJson(response, 500, { error: error instanceof Error ? error.message : "Could not load custom profile status" }));
      return;
    }
    if (url.pathname === "/custom-profile" && request.method === "GET") {
      const userId = sessionUserId(request);
      if (!userId) {
        response.writeHead(302, { location: "/login", "cache-control": "no-store" });
        response.end();
        return;
      }
      void Promise.all([readProfiles(), latestRequest(userId)]).then(([profiles, latest]) => {
        const html = page(profiles[userId] || {}, latest);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        });
        response.end(html);
      });
      return;
    }
    if (url.pathname === "/api/custom-profile" && request.method === "POST") {
      const userId = sessionUserId(request);
      if (!userId) {
        sendJson(response, 401, { error: "Login required" });
        return;
      }
      void readBody(request)
        .then((body) => submitApprovalRequest(userId, cleanUsername(body.username), cleanDate(body.createdAt)))
        .then((approvalRequest) => sendJson(response, 202, {
          ok: true,
          status: "pending",
          requestId: approvalRequest.id,
          message: PENDING_MESSAGE,
        }))
        .catch((error) => sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not submit custom profile" }));
      return;
    }
    listener(request, response);
  };
}

export function installCustomProfileIntegration(): void {
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

export function installCustomProfileModeration(client: Client): void {
  moderationClient = client;
  if (moderationInstalled) return;
  moderationInstalled = true;
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) return;
    const match = /^custom-profile:(approve|deny):([0-9a-f-]{36})$/i.exec(interaction.customId);
    if (!match) return;
    void processReview(interaction, match[2], match[1] === "approve");
  });
}
