import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Client,
  EmbedBuilder,
  Events,
  TextChannel,
} from "discord.js";
import { config } from "./config.js";
import { isRearrangeConfigured } from "./rearrange.js";
import { readStore } from "./store.js";

const STATUS_CHANNEL_ID = "1533052236685639720";
const STATUS_FILE = path.join(config.dataDir, "status-panel.json");
const UPDATE_INTERVAL_MS = 60_000;
const PLUGIN_CHECK_INTERVAL_MS = 5 * 60_000;
const ONLINE_EMOJI = "<a:uppp:1533083696343552040>";
const OFFLINE_EMOJI = "<a:downwnnnn:1533083825192697866>";
const FOOTER_TEXT = "Jadges • Live Service Status • Updates every 60 seconds";
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

interface PluginSnapshot {
  checkedAt: number;
  vencord: ServiceCheck;
  revenge: ServiceCheck;
}

export interface StatusPanelHandle {
  stop(markOffline?: boolean): Promise<void>;
}

let pluginSnapshot: PluginSnapshot | undefined;

function statusLine(label: string, online: boolean, detail?: string): string {
  return `**${label}:** ${online ? "Online" : "Offline"} ${
    online ? ONLINE_EMOJI : OFFLINE_EMOJI
  }${detail ? ` • ${detail}` : ""}`;
}

function enabledLine(label: string, enabled: boolean): string {
  return `**${label}:** ${enabled ? "Enabled" : "Disabled"} ${
    enabled ? ONLINE_EMOJI : OFFLINE_EMOJI
  }`;
}

function formatDuration(totalMilliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMilliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

async function checkJsonEndpoint(
  url: string,
  versionField = "version",
): Promise<ServiceCheck> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(8_000),
    });
    const body = response.ok
      ? await response.json() as Record<string, unknown>
      : undefined;
    const rawVersion = body?.[versionField];
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
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
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

async function textChannelAvailable(client: Client, channelId: string): Promise<boolean> {
  try {
    const channel =
      client.channels.cache.get(channelId) ||
      await client.channels.fetch(channelId);
    return channel instanceof TextChannel;
  } catch {
    return false;
  }
}

async function checkPlugins(force = false): Promise<PluginSnapshot> {
  if (
    !force &&
    pluginSnapshot &&
    Date.now() - pluginSnapshot.checkedAt < PLUGIN_CHECK_INTERVAL_MS
  ) {
    return pluginSnapshot;
  }

  const [vencord, revenge] = await Promise.all([
    checkJsonEndpoint(VENCORD_MANIFEST_URL),
    checkJsonEndpoint(REVENGE_VERSION_URL),
  ]);
  pluginSnapshot = { checkedAt: Date.now(), vencord, revenge };
  return pluginSnapshot;
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

async function resolveStatusChannel(client: Client): Promise<TextChannel> {
  const channel =
    client.channels.cache.get(STATUS_CHANNEL_ID) ||
    await client.channels.fetch(STATUS_CHANNEL_ID);
  if (!(channel instanceof TextChannel)) {
    throw new Error(`Status channel ${STATUS_CHANNEL_ID} is not a text channel`);
  }
  return channel;
}

async function publishStatus(
  client: Client,
  startedAt: number,
  forceOffline: boolean,
): Promise<void> {
  const botUser = client.user;
  if (!botUser) return;

  const appVersionPromise = applicationVersion();
  const pluginsPromise = checkPlugins(forceOffline);

  const [api, database, reviewOnline, appVersion, plugins] = forceOffline
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
        appVersionPromise,
        pluginsPromise,
      ])
    : await Promise.all([
        checkApi(),
        databaseSnapshot(),
        textChannelAvailable(client, config.promptChannel),
        appVersionPromise,
        pluginsPromise,
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
  const allOnline =
    botOnline &&
    api.online &&
    database.online &&
    reviewOnline &&
    staffSyncOnline &&
    rearrangerOnline &&
    plugins.vencord.online &&
    plugins.revenge.online;

  const gatewayLatency =
    botOnline && Number.isFinite(client.ws.ping) && client.ws.ping >= 0
      ? `${Math.round(client.ws.ping)} ms`
      : "Unavailable";
  const apiLatency = api.latency !== undefined ? `${api.latency} ms` : "Unavailable";
  const checkedAt = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setTitle("Jadges Service Status")
    .setDescription(
      allOnline
        ? `${ONLINE_EMOJI} All Jadges systems are currently operational.`
        : `${OFFLINE_EMOJI} One or more Jadges systems are currently unavailable.`,
    )
    .setColor(allOnline ? 0x57f287 : 0xed4245)
    .setThumbnail(botUser.displayAvatarURL({ size: 128 }))
    .addFields(
      {
        name: "Core Services",
        value: [
          statusLine("Bot", botOnline),
          statusLine("API", api.online),
          statusLine("Database / Storage", database.online),
          statusLine("Badge Review System", reviewOnline),
          statusLine("Staff Badge Sync", staffSyncOnline),
          statusLine("Rearranger", rearrangerOnline),
        ].join("\n"),
      },
      {
        name: "Client Plugins",
        value: [
          statusLine(
            "Vencord",
            plugins.vencord.online,
            `V.${plugins.vencord.version || "Unknown"}`,
          ),
          statusLine(
            "Revenge",
            plugins.revenge.online,
            `V.${plugins.revenge.version || "Unknown"}`,
          ),
        ].join("\n"),
      },
      {
        name: "Versions",
        value: [
          `**Bot:** V.${appVersion}`,
          `**API:** V.${appVersion}`,
          `**Vencord:** V.${plugins.vencord.version || "Unknown"}`,
          `**Revenge:** V.${plugins.revenge.version || "Unknown"}`,
          "**Status Panel:** V.1",
        ].join("\n"),
        inline: true,
      },
      {
        name: "Performance",
        value: [
          `**Gateway latency:** ${gatewayLatency}`,
          `**API response:** ${apiLatency}`,
          `**Uptime:** ${forceOffline ? "Offline" : formatDuration(Date.now() - startedAt)}`,
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
        ].join("\n"),
      },
      {
        name: "Last Checked",
        value: `<t:${checkedAt}:F> • <t:${checkedAt}:R>`,
      },
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();

  const channel = await resolveStatusChannel(client);
  const storedMessageId = await loadStatusMessageId();
  let message = storedMessageId
    ? await channel.messages.fetch(storedMessageId).catch(() => undefined)
    : undefined;

  if (!message) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => undefined);
    message = recent?.find((candidate) =>
      candidate.author.id === botUser.id &&
      candidate.embeds.some((existingEmbed) =>
        existingEmbed.footer?.text === FOOTER_TEXT
      )
    );
  }

  if (message) {
    await message.edit({ content: "", embeds: [embed] });
  } else {
    message = await channel.send({ embeds: [embed] });
  }

  await saveStatusMessageId(message.id);
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
        } catch (error) {
          console.warn("Could not update the Jadges status panel:", error);
        }
      });
    return queue;
  };

  const begin = (): void => {
    if (started || stopped) return;
    started = true;
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
      if (markOffline && client.isReady()) await refresh(true);
    },
  };
}
