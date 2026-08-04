import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config.js";
import { listPresets } from "./presetStore.js";
import { getOrCreateUser, getUser, mutateStore } from "./store.js";
import type { BadgeRecord, UserRecord } from "./types.js";

const QUEST_SYNC_INTERVAL = 5 * 60 * 1000;
const QUEST_BADGE_PREFIX = "quest:";

interface QuestDefinition {
  id: string;
  name: string;
  description: string;
  rewardName: string;
  filename: string;
  color: string;
  icon: string;
  permanent: boolean;
}

interface QuestProgress {
  quest: QuestDefinition;
  completed: boolean;
  claimed: boolean;
  progress: string;
}

const QUESTS: QuestDefinition[] = [
  {
    id: "first-badge",
    name: "First Badge",
    description: "Own at least one approved custom Jadges badge.",
    rewardName: "Quest: First Badge",
    filename: "10000000-0000-4000-8000-000000000001.png",
    color: "#7C4DFF",
    icon: "star",
    permanent: true,
  },
  {
    id: "badge-collector",
    name: "Badge Collector",
    description: "Collect at least three approved Jadges badges.",
    rewardName: "Quest: Badge Collector",
    filename: "10000000-0000-4000-8000-000000000002.png",
    color: "#5B8CFF",
    icon: "collection",
    permanent: true,
  },
  {
    id: "preset-explorer",
    name: "Preset Explorer",
    description: "Claim a community badge preset.",
    rewardName: "Quest: Preset Explorer",
    filename: "10000000-0000-4000-8000-000000000003.png",
    color: "#46D483",
    icon: "compass",
    permanent: true,
  },
  {
    id: "preset-creator",
    name: "Preset Creator",
    description: "Publish an approved badge preset for the community.",
    rewardName: "Quest: Preset Creator",
    filename: "10000000-0000-4000-8000-000000000004.png",
    color: "#FFB84D",
    icon: "brush",
    permanent: true,
  },
  {
    id: "server-booster",
    name: "Server Booster",
    description: "Actively boost the Jaycord server.",
    rewardName: "Jaycord Server Booster",
    filename: "10000000-0000-4000-8000-000000000005.png",
    color: "#F47FFF",
    icon: "boost",
    permanent: false,
  },
];

export const questsCommand = new SlashCommandBuilder()
  .setName("quests")
  .setDescription("View Badge Quests, progress, and rewards");

function questBadgeId(questId: string): string {
  return `${QUEST_BADGE_PREFIX}${questId}`;
}

function nonQuestApprovedBadges(user: UserRecord): BadgeRecord[] {
  return user.badges.filter(
    (badge) => !badge.pending && !badge.id.startsWith(QUEST_BADGE_PREFIX),
  );
}

function customApprovedBadges(user: UserRecord): BadgeRecord[] {
  return nonQuestApprovedBadges(user).filter(
    (badge) => !badge.id.startsWith("preset-"),
  );
}

function questSvg(quest: QuestDefinition): string {
  const symbols: Record<string, string> = {
    star: '<path d="m48 14 9.7 19.7 21.7 3.2-15.7 15.3 3.7 21.6L48 63.6 28.6 73.8l3.7-21.6L16.6 36.9l21.7-3.2L48 14Z"/>',
    collection: '<rect x="19" y="23" width="24" height="24" rx="7"/><rect x="38" y="18" width="30" height="30" rx="8"/><rect x="27" y="45" width="38" height="29" rx="9"/>',
    compass: '<circle cx="48" cy="48" r="29"/><path d="m58 36-7 17-17 7 7-17 17-7Z"/>',
    brush: '<path d="M59 18 35 42l19 19 24-24c5-5 5-13 0-18s-14-6-19-1Z"/><path d="M33 45c-11 1-18 8-17 20 6-5 12-3 17-1 8 3 15-1 18-8L33 45Z"/>',
    boost: '<path d="M48 14 58 35l23 3-17 16 4 23-20-11-20 11 4-23-17-16 23-3 10-21Z"/><path d="M48 30v25M36 43h24"/>',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
    <defs><linearGradient id="g" x1="12" y1="10" x2="84" y2="88"><stop stop-color="${quest.color}"/><stop offset="1" stop-color="#171C35"/></linearGradient></defs>
    <circle cx="48" cy="48" r="44" fill="url(#g)" stroke="white" stroke-opacity=".22" stroke-width="3"/>
    <g fill="none" stroke="white" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${symbols[quest.icon] || symbols.star}</g>
  </svg>`;
}

async function ensureQuestAssets(): Promise<void> {
  await mkdir(config.imagesDir, { recursive: true });
  await Promise.all(QUESTS.map(async (quest) => {
    const destination = path.join(config.imagesDir, quest.filename);
    try {
      const file = await stat(destination);
      if (file.isFile() && file.size > 0) return;
    } catch {
      // Create the missing deterministic reward image below.
    }
    await sharp(Buffer.from(questSvg(quest), "utf8"), { density: 288 })
      .resize(96, 96, { fit: "contain" })
      .png()
      .toFile(destination);
  }));
}

function rewardBadge(userId: string, quest: QuestDefinition): BadgeRecord {
  const now = new Date().toISOString();
  return {
    id: questBadgeId(quest.id),
    userId,
    name: quest.rewardName,
    filename: quest.filename,
    mimeType: "image/png",
    pending: false,
    createdAt: now,
    approvedAt: now,
  };
}

async function discordMember(userId: string): Promise<{ premium_since?: string | null } | undefined> {
  if (!config.guildId) return undefined;
  const response = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(userId)}`,
    {
      headers: {
        authorization: `Bot ${config.discordToken}`,
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
  return response.json() as Promise<{ premium_since?: string | null }>;
}

async function isBoosting(userId: string): Promise<boolean> {
  try {
    return Boolean((await discordMember(userId))?.premium_since);
  } catch (error) {
    console.warn(`Could not check booster state for ${userId}:`, error);
    return false;
  }
}

async function evaluateQuests(userId: string): Promise<QuestProgress[]> {
  const [user, presets, boosting] = await Promise.all([
    getUser(userId),
    listPresets(),
    isBoosting(userId),
  ]);
  const approved = nonQuestApprovedBadges(user);
  const custom = customApprovedBadges(user);
  const hasClaimedPreset = approved.some((badge) => badge.id.startsWith("preset-"));
  const createdPreset = presets.some((preset) => preset.uploaderId === userId);
  const claimed = new Set(user.questClaims || []);

  return QUESTS.map((quest) => {
    let completed = false;
    let progress = "0/1";
    switch (quest.id) {
      case "first-badge":
        completed = custom.length >= 1;
        progress = `${Math.min(custom.length, 1)}/1`;
        break;
      case "badge-collector":
        completed = approved.length >= 3;
        progress = `${Math.min(approved.length, 3)}/3`;
        break;
      case "preset-explorer":
        completed = hasClaimedPreset;
        progress = `${completed ? 1 : 0}/1`;
        break;
      case "preset-creator":
        completed = createdPreset;
        progress = `${completed ? 1 : 0}/1`;
        break;
      case "server-booster":
        completed = boosting;
        progress = completed ? "Active" : "Not boosting";
        break;
    }
    return {
      quest,
      completed,
      claimed: quest.permanent
        ? claimed.has(quest.id)
        : user.badges.some((badge) => badge.id === questBadgeId(quest.id)),
      progress,
    };
  });
}

async function grantCompletedQuests(userId: string, progress: QuestProgress[]): Promise<string[]> {
  const unlocked: string[] = [];
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    user.questClaims ??= [];

    for (const item of progress) {
      const badgeId = questBadgeId(item.quest.id);
      const badgeIndex = user.badges.findIndex((badge) => badge.id === badgeId);

      if (!item.quest.permanent) {
        if (item.completed && badgeIndex === -1) {
          user.badges.push(rewardBadge(userId, item.quest));
          user.badgeOrder?.push(`custom:${badgeId}`);
          unlocked.push(item.quest.rewardName);
        } else if (!item.completed && badgeIndex !== -1) {
          user.badges.splice(badgeIndex, 1);
          if (user.badgeOrder) {
            user.badgeOrder = user.badgeOrder.filter((key) => key !== `custom:${badgeId}`);
          }
        }
        continue;
      }

      if (!item.completed || user.questClaims.includes(item.quest.id)) continue;
      user.questClaims.push(item.quest.id);
      if (badgeIndex === -1) {
        user.badges.push(rewardBadge(userId, item.quest));
        user.badgeOrder?.push(`custom:${badgeId}`);
      }
      unlocked.push(item.quest.rewardName);
    }
  });
  return unlocked;
}

export async function handleQuestsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== "quests") return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ensureQuestAssets();

  const before = await evaluateQuests(interaction.user.id);
  const unlocked = await grantCompletedQuests(interaction.user.id, before);
  const after = await evaluateQuests(interaction.user.id);

  const lines = after.map(({ quest, completed, claimed, progress }) => {
    const state = claimed ? "Reward equipped" : completed ? "Completed" : "In progress";
    return `**${quest.name}** — ${state}\n${quest.description}\nProgress: **${progress}** • Reward: **${quest.rewardName}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Badge Quests")
    .setDescription(
      `${unlocked.length ? `New rewards: **${unlocked.join(", ")}**\n\n` : ""}${lines.join("\n\n")}`,
    )
    .setColor(0x7c4dff)
    .setFooter({ text: "Permanent quest rewards can only be earned once. Booster access is synchronized." });

  await interaction.editReply({ embeds: [embed] });
}

async function allBoostingMemberIds(): Promise<Set<string>> {
  const boosting = new Set<string>();
  if (!config.guildId) return boosting;
  let after: string | undefined;

  while (true) {
    const endpoint = new URL(`https://discord.com/api/v10/guilds/${config.guildId}/members`);
    endpoint.searchParams.set("limit", "1000");
    if (after) endpoint.searchParams.set("after", after);
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bot ${config.discordToken}`,
        "user-agent": "Jadges/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Discord member sync returned HTTP ${response.status}`);
    const members = await response.json() as Array<{
      user?: { id?: string };
      premium_since?: string | null;
    }>;
    for (const member of members) {
      if (member.user?.id && member.premium_since) boosting.add(member.user.id);
    }
    if (members.length < 1000) break;
    const last = members.at(-1)?.user?.id;
    if (!last || last === after) break;
    after = last;
  }
  return boosting;
}

async function syncBoosterBadges(): Promise<void> {
  await ensureQuestAssets();
  const boosterQuest = QUESTS.find((quest) => quest.id === "server-booster")!;
  const boosting = await allBoostingMemberIds();
  await mutateStore((data) => {
    const relevantUsers = new Set([...Object.keys(data.users), ...boosting]);
    for (const userId of relevantUsers) {
      const user = getOrCreateUser(data, userId);
      const badgeId = questBadgeId(boosterQuest.id);
      const index = user.badges.findIndex((badge) => badge.id === badgeId);
      if (boosting.has(userId) && index === -1) {
        user.badges.push(rewardBadge(userId, boosterQuest));
        user.badgeOrder?.push(`custom:${badgeId}`);
      } else if (!boosting.has(userId) && index !== -1) {
        user.badges.splice(index, 1);
        if (user.badgeOrder) {
          user.badgeOrder = user.badgeOrder.filter((key) => key !== `custom:${badgeId}`);
        }
      }
    }
  });
  console.log(`Synchronized Badge Quests booster rewards for ${boosting.size} members.`);
}

export function startBadgeQuestSync(): { stop: () => void } {
  void syncBoosterBadges().catch((error) => {
    console.error("Badge Quests booster sync failed:", error);
  });
  const timer = setInterval(() => {
    void syncBoosterBadges().catch((error) => {
      console.error("Badge Quests booster sync failed:", error);
    });
  }, QUEST_SYNC_INTERVAL);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
