import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  Guild,
  Interaction,
  Message,
  MessageFlags,
  escapeMarkdown,
  type GuildTextBasedChannel,
} from "discord.js";
import { readStore } from "./store.js";
import type { UserRecord } from "./types.js";

const LEADERBOARD_CHANNEL_ID = "1533349869631181032";
const UPDATE_INTERVAL_MS = 60_000;
const USERS_PER_PAGE = 5;
const NAME_CACHE_MS = 10 * 60_000;
const FOOTER_PREFIX = "Jadges • Most Badges Leaderboard";
const FIRST_PLACE_EMOJI = "<:oeuir:1533350484914733196>";
const SECOND_PLACE_EMOJI = "<:twosee:1533350525226057929>";
const THIRD_PLACE_EMOJI = "<:oksatjstes:1533350568914059364>";
const BUTTON_PREFIX = "jadges-leaderboard";

interface LeaderboardEntry {
  userId: string;
  badgeCount: number;
}

interface ResolvedName {
  username: string;
  displayName: string;
}

interface CachedName extends ResolvedName {
  expiresAt: number;
}

export interface BadgeLeaderboardHandle {
  stop(): void;
}

const nameCache = new Map<string, CachedName>();

function activeBadgeCount(user: UserRecord): number {
  const approvedCustomBadges = user.badges.filter((badge) => !badge.pending).length;
  const equippedNitro = Boolean(
    user.nitro &&
    !user.nitro.pending &&
    user.nitro.preset !== "remove",
  );
  return approvedCustomBadges + (equippedNitro ? 1 : 0);
}

async function getLeaderboardEntries(): Promise<LeaderboardEntry[]> {
  const data = await readStore();
  return Object.entries(data.users)
    .map(([userId, user]) => ({
      userId,
      badgeCount: activeBadgeCount(user),
    }))
    .filter((entry) => entry.badgeCount > 0)
    .sort((left, right) =>
      right.badgeCount - left.badgeCount || left.userId.localeCompare(right.userId)
    );
}

async function resolveName(
  client: Client,
  guild: Guild,
  userId: string,
): Promise<ResolvedName> {
  const cached = nameCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let username = "unknown-user";
  let displayName = `Unknown user (${userId})`;

  try {
    const member = await guild.members.fetch(userId);
    username = member.user.username;
    displayName = member.displayName;
  } catch {
    try {
      const user = await client.users.fetch(userId);
      username = user.username;
      displayName = user.globalName || user.username;
    } catch (error) {
      console.warn(`Could not resolve leaderboard user ${userId}:`, error);
    }
  }

  const resolved = { username, displayName };
  nameCache.set(userId, {
    ...resolved,
    expiresAt: Date.now() + NAME_CACHE_MS,
  });
  return resolved;
}

function rankMarker(rank: number): string {
  if (rank === 1) return FIRST_PLACE_EMOJI;
  if (rank === 2) return SECOND_PLACE_EMOJI;
  if (rank === 3) return THIRD_PLACE_EMOJI;
  return `**#${rank}**`;
}

function navigationRow(page: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:previous:${page}`)
      .setLabel("Previous")
      .setEmoji("⬅️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:next:${page}`)
      .setLabel("Next")
      .setEmoji("➡️")
      .setStyle(ButtonStyle.Primary),
  );
}

async function buildPage(
  client: Client,
  guild: Guild,
  entries: LeaderboardEntry[],
  page: number,
): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> }> {
  const totalPages = Math.max(1, Math.ceil(entries.length / USERS_PER_PAGE));
  const start = page * USERS_PER_PAGE;
  const pageEntries = entries.slice(start, start + USERS_PER_PAGE);
  const names = await Promise.all(
    pageEntries.map((entry) => resolveName(client, guild, entry.userId)),
  );

  const lines = pageEntries.map((entry, index) => {
    const rank = start + index + 1;
    const name = names[index]!;
    const username = escapeMarkdown(name.username);
    const displayName = escapeMarkdown(name.displayName);
    const badgeWord = entry.badgeCount === 1 ? "badge" : "badges";

    return [
      `${rankMarker(rank)} **@${username}**  •  ${displayName}`,
      `> ✦ **${entry.badgeCount.toLocaleString()} ${badgeWord}**`,
    ].join("\n");
  });

  const description = lines.length
    ? [
        "Celebrating the collectors with the largest approved Jadges collections.",
        "",
        lines.join("\n\n"),
      ].join("\n")
    : "No approved Jadges badges have been collected yet. The leaderboard will update automatically when the first badge is approved.";

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("🏆 Jadges Badge Collectors Leaderboard")
    .setDescription(description)
    .setFooter({
      text: `${FOOTER_PREFIX} • Page ${page + 1}/${totalPages} • Updates every 60 seconds`,
    })
    .setTimestamp();

  const avatar = client.user?.displayAvatarURL({ size: 128 });
  if (avatar) embed.setThumbnail(avatar);

  return { embed, row: navigationRow(page) };
}

async function leaderboardChannel(client: Client): Promise<GuildTextBasedChannel> {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const isSupportedType =
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement;

  if (
    !channel ||
    !isSupportedType ||
    !channel.isTextBased() ||
    channel.isDMBased() ||
    !channel.isSendable()
  ) {
    throw new Error(
      "The Jadges leaderboard channel must be a sendable text or announcement channel",
    );
  }

  return channel as GuildTextBasedChannel;
}

async function findExistingMessage(
  channel: GuildTextBasedChannel,
  botUserId: string,
): Promise<Message | undefined> {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find((message) =>
      message.author.id === botUserId &&
      message.embeds.some((embed) =>
        embed.footer?.text?.startsWith(FOOTER_PREFIX)
      )
    );
  } catch (error) {
    console.warn("Could not search for an existing Jadges leaderboard message:", error);
    return undefined;
  }
}

async function publishLeaderboard(client: Client): Promise<void> {
  const botUser = client.user;
  if (!botUser) throw new Error("Discord bot user is not ready");

  const channel = await leaderboardChannel(client);
  const entries = await getLeaderboardEntries();
  const { embed, row } = await buildPage(client, channel.guild, entries, 0);
  const payload = {
    content: "",
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  };

  const existing = await findExistingMessage(channel, botUser.id);
  if (existing) {
    await existing.edit(payload);
  } else {
    await channel.send(payload);
  }
}

function requestedPage(
  customId: string,
): { direction: "previous" | "next"; currentPage: number } | undefined {
  const match = new RegExp(`^${BUTTON_PREFIX}:(previous|next):(\\d+)$`).exec(customId);
  if (!match) return undefined;

  const currentPage = Number(match[2]);
  if (!Number.isSafeInteger(currentPage) || currentPage < 0) return undefined;

  return {
    direction: match[1] as "previous" | "next",
    currentPage,
  };
}

async function handleButton(
  client: Client,
  interaction: ButtonInteraction,
): Promise<boolean> {
  const request = requestedPage(interaction.customId);
  if (!request) return false;

  const entries = await getLeaderboardEntries();
  const totalPages = Math.max(1, Math.ceil(entries.length / USERS_PER_PAGE));
  const targetPage = request.currentPage + (request.direction === "next" ? 1 : -1);

  if (targetPage < 0) {
    await interaction.reply({
      content: "You are already viewing the first leaderboard page.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (targetPage >= totalPages) {
    await interaction.reply({
      content: "You have reached the end of the leaderboard — there are no more collectors to display after this page.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const channel = await leaderboardChannel(client);
  const { embed, row } = await buildPage(
    client,
    channel.guild,
    entries,
    targetPage,
  );
  const payload = {
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  };

  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.update(payload);
  } else {
    await interaction.reply({
      ...payload,
      flags: MessageFlags.Ephemeral,
    });
  }

  return true;
}

export function startAnnouncementBadgeLeaderboard(
  client: Client,
): BadgeLeaderboardHandle {
  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();

  const refresh = (): void => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        if (stopped) return;
        try {
          await publishLeaderboard(client);
          console.log("Jadges badge leaderboard refreshed.");
        } catch (error) {
          console.error(
            "Jadges badge leaderboard refresh failed; it will retry in one minute:",
            error,
          );
        }
      });
  };

  const onInteraction = (interaction: Interaction): void => {
    if (!interaction.isButton()) return;
    void handleButton(client, interaction).catch(async (error) => {
      console.error("Jadges leaderboard interaction failed:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "The leaderboard could not be loaded right now. Please try again in a moment.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => undefined);
      }
    });
  };

  const begin = (): void => {
    if (started || stopped) return;
    started = true;
    refresh();
    timer = setInterval(refresh, UPDATE_INTERVAL_MS);
    timer.unref();
  };

  client.on(Events.InteractionCreate, onInteraction);
  if (client.isReady()) begin();
  else client.once(Events.ClientReady, begin);

  return {
    stop(): void {
      stopped = true;
      client.off(Events.InteractionCreate, onInteraction);
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
