import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, Events } from "discord.js";
import { config } from "./config.js";
import { isRearrangeConfigured } from "./rearrange.js";
import { readStore } from "./store.js";

const STATUS_CHANNEL_ID = "1533052236685639720";
const STATUS_FILE = path.join(config.dataDir, "status-panel.json");
const UPDATE_INTERVAL_MS = 60_000;
const ONLINE_EMOJI = "<a:uppp:1533083696343552040>";
const OFFLINE_EMOJI = "<a:downwnnnn:1533083825192697866>";
const FOOTER_TEXT = "Jadges • Live Service Status • Checked every minute";
const VENCORD_MANIFEST_URL =
  "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const REVENGE_VERSION_URL =
  "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/version.json";

interface ServiceCheck {
  online: boolean;
  latency?: number;
  version?: string;
}

interface DatabaseSnapshot {
  online: boolean;
  users: number;
  activeBadges: number;
  pendingReviews: number;
  nativeBadges: number;
  blockedUsers: number;
}

interface DiscordMessage {
  id: string;
  author?: { id?: string };
  embeds?: Array<{ footer?: { text?: string } }>;
}

interface DiscordChannel {
  id?: string;
  type?: number;
}

interface StatusEmbed {
  title: string;
  description: string;
  color: number;
  thumbnail: { url: string };
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer: { text: string };
  timestamp: string;
}

export interface StatusPanelHandle {
  stop(markOffline?: boolean): Promise<void>;
}

function statusLine(label: string, online: boolean, detail?: string): string {
  const emoji = online ? ONLINE_EMOJI : OFFLINE_EMOJI;
  const status = online ? "Online" : "Offline";
  return `**${label}:** ${status} ${emoji}${detail ? ` • ${detail}` : ""}`;
}

function enabledLine(label: string, enabled: boolean): string {
  return `**${label}:** ${enabled ? "Enabled" : "Disabled"} ${
    enabled ? ONLINE_EMOJI : OFFLINE_EMOJI
  }`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatMemory(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function applicationVersion(): Promise<string> {
  try {
    const file = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(file) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "1.0.0";
  } catch {
    return "1.0.0";
  }
}

async function checkJsonEndpoint(url: string): Promise<ServiceCheck> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = response.ok
      ? await response.json() as { version?: unknown }
      : undefined;
    const rawVersion = body?.version;
    return {
      online: response.ok,
      latency: Date.now() - startedAt,
      version:
        typeof rawVersion === "string" || typeof rawVersion === "number"
          ? String(rawVersion)
          : undefined,
    };
  } catch {
    return { online: false };
  }
}

async function checkApi(): Promise<ServiceCheck> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.publicUrl}/health`, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = response.ok
      ? await response.json() as { ok?: unknown }
      : undefined;
    return {
      online: response.ok && body?.ok === true,
      latency: Date.now() - startedAt,
    };
  } catch {
    return { online: false };
  }
}

async function databaseSnapshot(): Promise<DatabaseSnapshot> {
  try {
    const data = await readStore();
    const users = Object.values(data.users);
    let activeBadges = 0;
    let pendingReviews = 0;
    let nativeBadges = 0;
    let blockedUsers = 0;

    for (const user of users) {
      activeBadges += user.badges.filter((badge) => !badge.pending).length;
      pendingReviews += user.badges.filter((badge) => badge.pending).length;
      if (user.nitro && !user.nitro.pending) activeBadges += 1;
      if (user.pendingNitro || user.nitro?.pending) pendingReviews += 1;
      nativeBadges += user.nativeBadges?.length || 0;
      if (user.blocked) blockedUsers += 1;
    }

    return {
      online: true,
      users: users.length,
      activeBadges,
      pendingReviews,
      nativeBadges,
      blockedUsers,
    };
  } catch (error) {
    console.warn("Could not read Jadges status statistics:", error);
    return {
      online: false,
      users: 0,
      activeBadges: 0,
      pendingReviews: 0,
      nativeBadges: 0,
      blockedUsers: 0,
    };
  }
}

async function discordRequest<T>(
  endpoint: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.discordToken}`);
  headers.set("user-agent", "Jadges/1.0");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Discord API ${init.method || "GET"} ${endpoint} returned HTTP ${response.status}${
        details ? `: ${details.slice(0, 500)}` : ""
      }`,
    );
  }

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function channelAvailable(channelId: string): Promise<boolean> {
  try {
    const channel = await discordRequest<DiscordChannel>(
      `/channels/${encodeURIComponent(channelId)}`,
    );
    return channel.id === channelId;
  } catch {
    return false;
  }
}

async function loadStatusMessageId(): Promise<string | undefined> {
  try {
    const raw = await readFile(STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { channelId?: unknown; messageId?: unknown };
    return parsed.channelId === STATUS_CHANNEL_ID && typeof parsed.messageId === "string"
      ? parsed.messageId
      : undefined;
  } catch {
    return undefined;
  }
}

async function saveStatusMessageId(messageId: string): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(
    STATUS_FILE,
    `${JSON.stringify({ channelId: STATUS_CHANNEL_ID, messageId }, null, 2)}\n`,
    "utf8",
  );
}

async function findExistingStatusMessage(botUserId: string): Promise<string | undefined> {
  try {
    const messages = await discordRequest<DiscordMessage[]>(
      `/channels/${STATUS_CHANNEL_ID}/messages?limit=50`,
    );
    return messages.find((message) =>
      message.author?.id === botUserId &&
      message.embeds?.some((embed) => embed.footer?.text === FOOTER_TEXT)
    )?.id;
  } catch (error) {
    console.warn("Could not search for the existing Jadges status message:", error);
    return undefined;
  }
}

async function upsertStatusMessage(
  botUserId: string,
  embed: StatusEmbed,
): Promise<void> {
  const payload = JSON.stringify({
    content: "",
    embeds: [embed],
    allowed_mentions: { parse: [] },
  });

  let messageId = await loadStatusMessageId();
  if (!messageId) messageId = await findExistingStatusMessage(botUserId);

  if (messageId) {
    try {
      const edited = await discordRequest<DiscordMessage>(
        `/channels/${STATUS_CHANNEL_ID}/messages/${encodeURIComponent(messageId)}`,
        { method: "PATCH", body: payload },
      );
      await saveStatusMessageId(edited.id);
      return;
    } catch (error) {
      console.warn(
        `Could not edit status message ${messageId}; a new one will be created:`,
        error,
      );
    }
  }

  const created = await discordRequest<DiscordMessage>(
    `/channels/${STATUS_CHANNEL_ID}/messages`,
    { method: "POST", body: payload },
  );
  await saveStatusMessageId(created.id);
  console.log(`Created Jadges status panel message ${created.id}.`);
}

async function buildStatusEmbed(
  client: Client,
  startedAt: number,
  forceOffline: boolean,
): Promise<StatusEmbed> {
  const botUser = client.user;
  if (!botUser) throw new Error("Discord bot user is not ready");

  const [api, database, reviewOnline, vencord, revenge, appVersion] = forceOffline
    ? await Promise.all([
        Promise.resolve<ServiceCheck>({ online: false }),
        Promise.resolve<DatabaseSnapshot>({
          online: false,
          users: 0,
          activeBadges: 0,
          pendingReviews: 0,
          nativeBadges: 0,
          blockedUsers: 0,
        }),
        Promise.resolve(false),
        checkJsonEndpoint(VENCORD_MANIFEST_URL),
        checkJsonEndpoint(REVENGE_VERSION_URL),
        applicationVersion(),
      ])
    : await Promise.all([
        checkApi(),
        databaseSnapshot(),
        channelAvailable(config.promptChannel),
        checkJsonEndpoint(VENCORD_MANIFEST_URL),
        checkJsonEndpoint(REVENGE_VERSION_URL),
        applicationVersion(),
      ]);

  const botOnline = !forceOffline && client.isReady();
  const staffSyncOnline =
    !forceOffline &&
    Boolean(config.guildId && client.guilds.cache.has(config.guildId));
  const rearrangerOnline =
    !forceOffline &&
    api.online &&
    isRearrangeConfigured();
  const securityOnline = rearrangerOnline;
  const statusChannelOnline = !forceOffline;
  const allOnline =
    botOnline &&
    api.online &&
    database.online &&
    reviewOnline &&
    staffSyncOnline &&
    rearrangerOnline &&
    vencord.online &&
    revenge.online;

  const gatewayLatency =
    botOnline && Number.isFinite(client.ws.ping) && client.ws.ping >= 0
      ? `${Math.round(client.ws.ping)} ms`
      : "Unavailable";
  const apiLatency = api.latency !== undefined ? `${api.latency} ms` : "Unavailable";
  const checkedAt = Math.floor(Date.now() / 1000);
  const memory = process.memoryUsage();

  return {
    title: "Jadges Service Status",
    description: allOnline
      ? `${ONLINE_EMOJI} All Jadges systems are currently operational.`
      : `${OFFLINE_EMOJI} One or more Jadges systems are currently unavailable.`,
    color: allOnline ? 0x57f287 : 0xed4245,
    thumbnail: { url: botUser.displayAvatarURL({ size: 128 }) },
    fields: [
      {
        name: "Core Services",
        value: [
          statusLine("Bot", botOnline),
          statusLine("API", api.online, apiLatency),
          statusLine("Database / Storage", database.online),
          statusLine("Badge Review System", reviewOnline),
          statusLine("Staff Badge Sync", staffSyncOnline),
          statusLine("Rearranger", rearrangerOnline),
          statusLine("Status Monitor", statusChannelOnline),
        ].join("\n"),
      },
      {
        name: "Client Plugins",
        value: [
          statusLine(
            "Vencord",
            vencord.online,
            `V.${vencord.version || "Unknown"}`,
          ),
          statusLine(
            "Revenge",
            revenge.online,
            `V.${revenge.version || "Unknown"}`,
          ),
        ].join("\n"),
      },
      {
        name: "Versions",
        value: [
          `**Bot:** V.${appVersion}`,
          `**API:** V.${appVersion}`,
          `**Vencord:** V.${vencord.version || "Unknown"}`,
          `**Revenge:** V.${revenge.version || "Unknown"}`,
          "**Status Panel:** V.2",
        ].join("\n"),
        inline: true,
      },
      {
        name: "Performance",
        value: [
          `**Gateway latency:** ${gatewayLatency}`,
          `**API response:** ${apiLatency}`,
          `**Uptime:** ${forceOffline ? "Offline" : formatDuration(Date.now() - startedAt)}`,
          `**Memory:** ${formatMemory(memory.rss)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Jadges Statistics",
        value: [
          `**Registered users:** ${database.users.toLocaleString()}`,
          `**Active badges:** ${database.activeBadges.toLocaleString()}`,
          `**Pending reviews:** ${database.pendingReviews.toLocaleString()}`,
          `**Detected native badges:** ${database.nativeBadges.toLocaleString()}`,
          `**Blocked users:** ${database.blockedUsers.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Security",
        value: [
          enabledLine("Discord OAuth protection", securityOnline),
          enabledLine("Account-mismatch link termination", securityOnline),
          enabledLine("Owner security-alert DMs", securityOnline),
          enabledLine("Signed private links", securityOnline),
        ].join("\n"),
      },
      {
        name: "Automatic Update Checks",
        value: [
          `**Check interval:** Every minute`,
          `**Vencord feed:** ${vencord.online ? "Reachable" : "Unavailable"}`,
          `**Revenge feed:** ${revenge.online ? "Reachable" : "Unavailable"}`,
          "Any version or service change is reflected in this same embed.",
        ].join("\n"),
      },
      {
        name: "Last Checked",
        value: `<t:${checkedAt}:F> • <t:${checkedAt}:R>`,
      },
    ],
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString(),
  };
}

async function publishStatus(
  client: Client,
  startedAt: number,
  forceOffline: boolean,
): Promise<void> {
  const botUser = client.user;
  if (!botUser) throw new Error("Discord bot user is not ready");
  const embed = await buildStatusEmbed(client, startedAt, forceOffline);
  await upsertStatusMessage(botUser.id, embed);
}

export function startStatusPanel(client: Client): StatusPanelHandle {
  const startedAt = Date.now();
  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();

  const refresh = (forceOffline = false): Promise<void> => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        if (stopped && !forceOffline) return;
        try {
          await publishStatus(client, startedAt, forceOffline);
          if (!forceOffline) console.log("Jadges status panel checked and updated.");
        } catch (error) {
          console.error(
            "Jadges status panel update failed; it will retry in one minute:",
            error,
          );
        }
      });
    return queue;
  };

  const begin = (): void => {
    if (started || stopped) return;
    started = true;

    // Send immediately, then keep checking and updating the same message every minute.
    void refresh();
    timer = setInterval(() => void refresh(), UPDATE_INTERVAL_MS);
    timer.unref();
  };

  if (client.isReady()) begin();
  else client.once(Events.ClientReady, begin);

  return {
    async stop(markOffline = true): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (markOffline && client.user) await refresh(true);
    },
  };
}
