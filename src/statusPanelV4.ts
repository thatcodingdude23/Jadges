import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, Events, REST, Routes } from "discord.js";
import { config } from "./config.js";
import { isRearrangeConfigured } from "./rearrange.js";
import { readStore } from "./store.js";

const STATUS_CHANNEL_ID = "1533052236685639720";
const STATUS_FILE = path.join(config.dataDir, "status-panel-v4.json");
const UPDATE_INTERVAL_MS = 60_000;
const ONLINE = "<a:uppp:1533083696343552040>";
const OFFLINE = "<a:downwnnnn:1533083825192697866>";
const FOOTER_PREFIX = "Jadges • Live Service Status";
const VENCORD_FEED = "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const MOBILE_FEED = "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/version.json";

type PublishResult = "created" | "updated" | "unchanged";

interface Check {
  online: boolean;
  latency?: number;
  version?: string;
}

interface Stats {
  online: boolean;
  users: number;
  activeBadges: number;
  pending: number;
  nativeBadges: number;
  blockedUsers: number;
}

interface CommandStatus {
  online: boolean;
  badge: boolean;
  customProfile: boolean;
  quests: boolean;
}

interface StateFile {
  channelId: string;
  messageId?: string;
  signature?: string;
}

interface DiscordMessage {
  id: string;
  author?: { id?: string };
  embeds?: Array<{ footer?: { text?: string } }>;
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

function line(label: string, online: boolean, detail?: string): string {
  return `**${label}:** ${online ? "Online" : "Offline"} ${online ? ONLINE : OFFLINE}${detail ? ` • ${detail}` : ""}`;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function memory(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function appVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "1.0.0";
  } catch {
    return "1.0.0";
  }
}

async function checkUrl(url: string, expected?: (response: Response) => boolean): Promise<Check> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      headers: { "user-agent": "Jadges-Status/4" },
      signal: AbortSignal.timeout(10_000),
    });
    return {
      online: expected ? expected(response) : response.ok,
      latency: Date.now() - started,
    };
  } catch {
    return { online: false };
  }
}

async function checkFeed(url: string): Promise<Check> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "Jadges-Status/4" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = response.ok ? await response.json() as { version?: unknown } : undefined;
    return {
      online: response.ok,
      latency: Date.now() - started,
      version: typeof body?.version === "string" || typeof body?.version === "number" ? String(body.version) : undefined,
    };
  } catch {
    return { online: false };
  }
}

async function readStats(): Promise<Stats> {
  try {
    const store = await readStore();
    const users = Object.values(store.users);
    let activeBadges = 0;
    let pending = 0;
    let nativeBadges = 0;
    let blockedUsers = 0;
    for (const user of users) {
      activeBadges += user.badges.filter(badge => !badge.pending).length;
      pending += user.badges.filter(badge => badge.pending).length;
      if (user.nitro && !user.nitro.pending) activeBadges += 1;
      if (user.pendingNitro || user.nitro?.pending) pending += 1;
      nativeBadges += user.nativeBadges?.length || 0;
      if (user.blocked) blockedUsers += 1;
    }
    return { online: true, users: users.length, activeBadges, pending, nativeBadges, blockedUsers };
  } catch {
    return { online: false, users: 0, activeBadges: 0, pending: 0, nativeBadges: 0, blockedUsers: 0 };
  }
}

async function commandStatus(): Promise<CommandStatus> {
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.clientId, config.guildId)
      : Routes.applicationCommands(config.clientId);
    const commands = await rest.get(route) as Array<{ name?: unknown }>;
    const names = new Set(commands.map(command => typeof command.name === "string" ? command.name : ""));
    return {
      online: true,
      badge: names.has("badge"),
      customProfile: names.has("customprofile"),
      quests: names.has("quests") || names.has("badgequests") || names.has("quest"),
    };
  } catch {
    return { online: false, badge: false, customProfile: false, quests: false };
  }
}

async function discordRequest<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.discordToken}`);
  headers.set("user-agent", "Jadges-Status/4");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
  return response.status === 204 ? undefined as T : await response.json() as T;
}

async function loadState(): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await readFile(STATUS_FILE, "utf8")) as Partial<StateFile>;
    return parsed.channelId === STATUS_CHANNEL_ID
      ? { channelId: STATUS_CHANNEL_ID, messageId: parsed.messageId, signature: parsed.signature }
      : { channelId: STATUS_CHANNEL_ID };
  } catch {
    return { channelId: STATUS_CHANNEL_ID };
  }
}

async function saveState(messageId: string, signature: string): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({ channelId: STATUS_CHANNEL_ID, messageId, signature }, null, 2), "utf8");
}

async function findStatusMessage(botId: string): Promise<string | undefined> {
  try {
    const messages = await discordRequest<DiscordMessage[]>(`/channels/${STATUS_CHANNEL_ID}/messages?limit=50`);
    return messages.find(message => message.author?.id === botId && message.embeds?.some(embed => embed.footer?.text?.startsWith(FOOTER_PREFIX)))?.id;
  } catch {
    return undefined;
  }
}

async function publish(botId: string, embed: StatusEmbed, signature: string, force: boolean): Promise<PublishResult> {
  const state = await loadState();
  let messageId = state.messageId || await findStatusMessage(botId);
  if (messageId && !force && state.signature === signature) return "unchanged";
  const payload = JSON.stringify({ content: "", embeds: [embed], allowed_mentions: { parse: [] } });
  if (messageId) {
    try {
      const message = await discordRequest<DiscordMessage>(`/channels/${STATUS_CHANNEL_ID}/messages/${messageId}`, { method: "PATCH", body: payload });
      await saveState(message.id, signature);
      return "updated";
    } catch {
      messageId = undefined;
    }
  }
  const message = await discordRequest<DiscordMessage>(`/channels/${STATUS_CHANNEL_ID}/messages`, { method: "POST", body: payload });
  await saveState(message.id, signature);
  return "created";
}

async function build(client: Client, startedAt: number, forceOffline: boolean): Promise<{ embed: StatusEmbed; signature: string }> {
  if (!client.user) throw new Error("Discord bot is not ready");

  const offline = (): Check => ({ online: false });
  const [website, dashboard, profiles, marketplace, health, vencord, mobile, stats, commands, version] = forceOffline
    ? await Promise.all([
        Promise.resolve(offline()), Promise.resolve(offline()), Promise.resolve(offline()), Promise.resolve(offline()), Promise.resolve(offline()),
        checkFeed(VENCORD_FEED), checkFeed(MOBILE_FEED), Promise.resolve<Stats>({ online: false, users: 0, activeBadges: 0, pending: 0, nativeBadges: 0, blockedUsers: 0 }),
        Promise.resolve<CommandStatus>({ online: false, badge: false, customProfile: false, quests: false }), appVersion(),
      ])
    : await Promise.all([
        checkUrl(config.publicUrl),
        checkUrl(`${config.publicUrl}/dashboard`, response => response.ok || response.status === 302 || response.status === 303),
        checkUrl(`${config.publicUrl}/custom-profiles.json`),
        checkUrl(`${config.publicUrl}/presets`, response => response.ok || response.status === 302 || response.status === 303 || response.status === 404),
        checkUrl(`${config.publicUrl}/health`),
        checkFeed(VENCORD_FEED),
        checkFeed(MOBILE_FEED),
        readStats(),
        commandStatus(),
        appVersion(),
      ]);

  const bot = !forceOffline && client.isReady();
  const rearranger = !forceOffline && health.online && isRearrangeConfigured();
  const allOnline = [bot, website.online, dashboard.online, profiles.online, health.online, stats.online, commands.online, commands.badge, commands.customProfile, vencord.online, mobile.online].every(Boolean);
  const gateway = bot && Number.isFinite(client.ws.ping) ? `${Math.round(client.ws.ping)} ms` : "Unavailable";
  const webLatency = health.latency === undefined ? "Unavailable" : `${health.latency} ms`;
  const updatedAt = Math.floor(Date.now() / 1000);

  const snapshot = {
    startedAt,
    forceOffline,
    bot,
    website,
    dashboard,
    profiles,
    marketplace,
    health,
    vencord,
    mobile,
    stats,
    commands,
    rearranger,
    version,
  };

  const embed: StatusEmbed = {
    title: "Jadges Service Status",
    description: allOnline
      ? `${ONLINE} All major Jadges systems are operational.`
      : `${OFFLINE} One or more Jadges systems are unavailable or degraded.`,
    color: allOnline ? 0x57f287 : 0xed4245,
    thumbnail: { url: client.user.displayAvatarURL({ size: 128 }) },
    fields: [
      {
        name: "Public Services",
        value: [
          line("Website", website.online, website.latency === undefined ? undefined : `${website.latency} ms`),
          line("Dashboard", dashboard.online),
          line("Custom Profiles", profiles.online),
          line("Badge System", stats.online),
          line("Preset Marketplace", marketplace.online),
          line("Badge Rearranger", rearranger),
        ].join("\n"),
      },
      {
        name: "Discord Features",
        value: [
          line("Jadges Bot", bot, gateway),
          line("Slash Commands", commands.online),
          line("/badge", commands.badge),
          line("/customprofile", commands.customProfile),
          line("Badge Quests", commands.quests || commands.online, commands.quests ? "Command detected" : "Service loaded"),
        ].join("\n"),
      },
      {
        name: "Client Plugins",
        value: [
          line("Vencord", vencord.online, `V.${vencord.version || "Unknown"}`),
          line("Mobile", mobile.online, `V.${mobile.version || "Unknown"}`),
          line("Instant Custom Names", profiles.online && vencord.online),
          line("Native Badge Sync", stats.online),
        ].join("\n"),
      },
      {
        name: "Statistics",
        value: [
          `**Registered users:** ${stats.users.toLocaleString()}`,
          `**Active badges:** ${stats.activeBadges.toLocaleString()}`,
          `**Pending requests:** ${stats.pending.toLocaleString()}`,
          `**Detected native badges:** ${stats.nativeBadges.toLocaleString()}`,
          `**Blocked users:** ${stats.blockedUsers.toLocaleString()}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Performance",
        value: [
          `**Gateway:** ${gateway}`,
          `**Web response:** ${webLatency}`,
          `**Uptime:** ${forceOffline ? "Offline" : duration(Date.now() - startedAt)}`,
          `**Memory:** ${memory(process.memoryUsage().rss)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Versions",
        value: [
          `**Jadges:** V.${version}`,
          `**Vencord:** V.${vencord.version || "Unknown"}`,
          `**Mobile:** V.${mobile.version || "Unknown"}`,
          "**Status Panel:** V.4",
        ].join("\n"),
        inline: true,
      },
      {
        name: "Monitoring",
        value: `Checks run every minute. The message is edited only when a service, version, statistic, or runtime state changes.\n\n**Last checked:** <t:${updatedAt}:F> • <t:${updatedAt}:R>`,
      },
    ],
    footer: { text: `${FOOTER_PREFIX} • V.4 • Checks every minute` },
    timestamp: new Date().toISOString(),
  };

  return {
    embed,
    signature: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
}

export function startStatusPanel(client: Client): StatusPanelHandle {
  const startedAt = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let queue = Promise.resolve();

  const refresh = (forceOffline = false): Promise<void> => {
    queue = queue.catch(() => undefined).then(async () => {
      if (stopped && !forceOffline) return;
      try {
        if (!client.user) return;
        const result = await build(client, startedAt, forceOffline);
        const action = await publish(client.user.id, result.embed, result.signature, forceOffline);
        console.log(action === "unchanged" ? "Jadges status checked; no changes detected." : `Jadges status panel ${action}.`);
      } catch (error) {
        console.error("Jadges status panel check failed:", error);
      }
    });
    return queue;
  };

  const begin = (): void => {
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
      if (markOffline && client.user) await refresh(true);
    },
  };
}
