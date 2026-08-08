import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config.js";
import { listPresets } from "./presetStore.js";
import { COMPLETED_QUEST_BADGE_PNG_BASE64 } from "./questCompletionAsset.js";
import { getOrCreateUser, getUser, mutateStore } from "./store.js";
import type { BadgeRecord, UserRecord } from "./types.js";

const QUEST_SYNC_INTERVAL = 5 * 60 * 1000;
const QUEST_BADGE_PREFIX = "quest:";
const COMPLETION_BADGE_ID = "quest:completed-any";
const COMPLETION_BADGE_FILENAME = "10000000-0000-4000-8000-000000000099.png";
const COMPLETION_BADGE_NAME = "Jadges Quests";

export interface QuestDefinition {
  id: string;
  name: string;
  description: string;
  rewardName: string;
  permanent: boolean;
}

export interface QuestProgress {
  quest: QuestDefinition;
  completed: boolean;
  claimed: boolean;
  progress: string;
  current: number;
  target: number;
}

export const QUESTS: QuestDefinition[] = [
  {
    id: "first-badge",
    name: "First Badge",
    description: "Own at least one approved custom Jadges badge.",
    rewardName: COMPLETION_BADGE_NAME,
    permanent: true,
  },
  {
    id: "badge-collector",
    name: "Badge Collector",
    description: "Collect at least three approved Jadges badges.",
    rewardName: COMPLETION_BADGE_NAME,
    permanent: true,
  },
  {
    id: "preset-explorer",
    name: "Preset Explorer",
    description: "Claim a community badge preset.",
    rewardName: COMPLETION_BADGE_NAME,
    permanent: true,
  },
  {
    id: "preset-creator",
    name: "Preset Creator",
    description: "Publish an approved badge preset for the community.",
    rewardName: COMPLETION_BADGE_NAME,
    permanent: true,
  },
  {
    id: "server-booster",
    name: "Server Booster",
    description: "Actively boost the Jaycord server.",
    rewardName: COMPLETION_BADGE_NAME,
    permanent: false,
  },
];

export const questsCommand = new SlashCommandBuilder()
  .setName("quests")
  .setDescription("View Badge Quests, progress, and rewards");

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

export async function ensureQuestAssets(): Promise<void> {
  await mkdir(config.imagesDir, { recursive: true });
  const destination = path.join(config.imagesDir, COMPLETION_BADGE_FILENAME);
  const exactBytes = Buffer.from(COMPLETED_QUEST_BADGE_PNG_BASE64, "base64");

  try {
    const file = await stat(destination);
    if (file.isFile() && file.size === exactBytes.length) return;
  } catch {
    // Write the exact uploaded image below.
  }

  await writeFile(destination, exactBytes);
}

function completionBadge(userId: string): BadgeRecord {
  const now = new Date().toISOString();
  return {
    id: COMPLETION_BADGE_ID,
    userId,
    name: COMPLETION_BADGE_NAME,
    filename: COMPLETION_BADGE_FILENAME,
    mimeType: "image/png",
    pending: false,
    createdAt: now,
    approvedAt: now,
    rarity: "quest",
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

export async function evaluateQuests(userId: string): Promise<QuestProgress[]> {
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
    let current = 0;
    let target = 1;
    let progress = "0/1";

    switch (quest.id) {
      case "first-badge":
        current = Math.min(custom.length, 1);
        completed = current >= 1;
        progress = `${current}/1`;
        break;
      case "badge-collector":
        target = 3;
        current = Math.min(approved.length, target);
        completed = current >= target;
        progress = `${current}/${target}`;
        break;
      case "preset-explorer":
        current = hasClaimedPreset ? 1 : 0;
        completed = current === 1;
        progress = `${current}/1`;
        break;
      case "preset-creator":
        current = createdPreset ? 1 : 0;
        completed = current === 1;
        progress = `${current}/1`;
        break;
      case "server-booster":
        current = boosting ? 1 : 0;
        completed = boosting;
        progress = completed ? "Active" : "Not boosting";
        break;
    }

    return {
      quest,
      completed,
      claimed: quest.permanent ? claimed.has(quest.id) : completed,
      progress,
      current,
      target,
    };
  });
}

function removeLegacyQuestBadges(user: UserRecord): void {
  user.badges = user.badges.filter(
    (badge) => !badge.id.startsWith(QUEST_BADGE_PREFIX) || badge.id === COMPLETION_BADGE_ID,
  );
  if (user.badgeOrder) {
    user.badgeOrder = user.badgeOrder.filter(
      (key) => !key.startsWith("custom:quest:") || key === `custom:${COMPLETION_BADGE_ID}`,
    );
  }
}

export async function grantCompletedQuests(
  userId: string,
  progress: QuestProgress[],
): Promise<string[]> {
  const unlocked: string[] = [];

  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    user.questClaims ??= [];
    removeLegacyQuestBadges(user);

    for (const item of progress) {
      if (item.completed && item.quest.permanent && !user.questClaims.includes(item.quest.id)) {
        user.questClaims.push(item.quest.id);
      }
    }

    const hasCompletedAny = progress.some((item) => item.completed);
    const existing = user.badges.find((badge) => badge.id === COMPLETION_BADGE_ID);

    if (existing) {
      existing.name = COMPLETION_BADGE_NAME;
      existing.filename = COMPLETION_BADGE_FILENAME;
      existing.mimeType = "image/png";
      existing.pending = false;
    } else if (hasCompletedAny) {
      user.badges.push(completionBadge(userId));
      user.badgeOrder?.push(`custom:${COMPLETION_BADGE_ID}`);
      unlocked.push(COMPLETION_BADGE_NAME);
    }
  });

  return unlocked;
}

export async function refreshQuestProgress(userId: string): Promise<{
  progress: QuestProgress[];
  unlocked: string[];
}> {
  await ensureQuestAssets();
  const before = await evaluateQuests(userId);
  const unlocked = await grantCompletedQuests(userId, before);
  const progress = await evaluateQuests(userId);
  return { progress, unlocked };
}

export async function handleQuestsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== "quests") return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { progress, unlocked } = await refreshQuestProgress(interaction.user.id);
  const lines = progress.map(({ quest, completed, claimed, progress: amount }) => {
    const state = claimed || completed ? "Completed" : "In progress";
    return `**${quest.name}** — ${state}\n${quest.description}\nProgress: **${amount}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Badge Quests")
    .setDescription(
      `${unlocked.length ? `New reward: **${COMPLETION_BADGE_NAME}**\n\n` : ""}${lines.join("\n\n")}`,
    )
    .setColor(0x7c4dff)
    .setFooter({ text: "For more information, visit jadges.onrender.com/quests" });

  await interaction.editReply({ embeds: [embed] });
}

async function cleanupAllQuestBadges(): Promise<void> {
  await ensureQuestAssets();
  await mutateStore((data) => {
    for (const user of Object.values(data.users)) {
      removeLegacyQuestBadges(user);
      const existing = user.badges.find((badge) => badge.id === COMPLETION_BADGE_ID);
      if (existing) {
        existing.name = COMPLETION_BADGE_NAME;
        existing.filename = COMPLETION_BADGE_FILENAME;
        existing.mimeType = "image/png";
        existing.pending = false;
      }
    }
  });
}

export function startBadgeQuestSync(): { stop: () => void } {
  void cleanupAllQuestBadges().catch((error) => {
    console.error("Badge Quests cleanup failed:", error);
  });
  const timer = setInterval(() => {
    void cleanupAllQuestBadges().catch((error) => {
      console.error("Badge Quests cleanup failed:", error);
    });
  }, QUEST_SYNC_INTERVAL);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
