import {
  ActionRowBuilder,
  ActivityType,
  Attachment,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  TextDisplayBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  isNitroPreset,
  NITRO_PRESET_CHOICES,
  NITRO_PRESETS,
  publicNitroPreset,
} from "./presets.js";
import { createRearrangeTicket, isRearrangeConfigured } from "./rearrange.js";
import {
  addPendingBadge,
  addPendingNitro,
  approveBadge,
  approveNitro,
  getUser,
  removeBadgeById,
  removeBadgeByName,
  removeBadgeForUserById,
  removeEquippedNitroForUser,
  removeNitroForUser,
  removePendingNitro,
  removePendingNitroForUser,
  setBlocked,
  setStaffBadgeMode,
} from "./store.js";
import {
  deleteStoredImage,
  isSupportedImage,
  publicImageUrl,
  saveDiscordAttachment,
} from "./storage.js";
import type { BadgeRecord, NitroRecord } from "./types.js";

const UNLIMITED_BADGES_ROLE_ID = "1531693367639937075";
const JAYCORD_STAFF_ROLE_ID = "1532572957778645082";
const JAYCORD_ADMIN_ROLE_ID = "1531693475181887580";

const badgeCommand = new SlashCommandBuilder()
  .setName("badge")
  .setDescription("Create and manage Jadges badges")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Submit a custom badge for approval")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Badge tooltip/name")
          .setMaxLength(64)
          .setRequired(true),
      )
      .addAttachmentOption((option) =>
        option
          .setName("image")
          .setDescription("PNG, JPG, WEBP, GIF, or APNG image")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove one of your own custom badges")
      .addStringOption((option) =>
        option
          .setName("badge")
          .setDescription("Badge to remove")
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Admin: delete a badge from a user")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("User whose badge should be deleted")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("badge")
          .setDescription("Select one of the user's badges")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("reason")
          .setDescription("Reason shown to the user")
          .setMaxLength(500)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rearrange")
      .setDescription("Open your private badge rearrangement page"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("staff")
      .setDescription("Choose your pinned Jaycord staff badge")
      .addStringOption((option) =>
        option
          .setName("badge")
          .setDescription("Staff badge to equip")
          .addChoices(
            { name: "Jaycord Admin", value: "admin" },
            { name: "Default", value: "default" },
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List a user's Jadges badges")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Defaults to you")
          .setRequired(false),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("nitro")
      .setDescription("Manage your Jadges Nitro badge")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Submit a Nitro badge preset for approval")
          .addStringOption((option) =>
            option
              .setName("preset")
              .setDescription("Nitro tier to display through Jadges")
              .addChoices(...NITRO_PRESET_CHOICES)
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove your equipped or pending Jadges Nitro badge"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("block")
      .setDescription("Block a user from submitting badges")
      .addUserOption((option) =>
        option.setName("user").setDescription("User to block").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("unblock")
      .setDescription("Unblock a user")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("User to unblock")
          .setRequired(true),
      ),
  );

const botPresence = {
  status: "dnd" as const,
  afk: false,
  activities: [
    {
      name: "Badges being made",
      type: ActivityType.Watching,
      url: "https://discord.gg/jaycord",
    },
  ],
};

type StaffInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | AutocompleteInteraction;

function hasVerifierRole(interaction: StaffInteraction): boolean {
  return (
    interaction.inCachedGuild() &&
    interaction.member.roles.cache.has(config.verifierRole)
  );
}

function hasRole(
  interaction: ChatInputCommandInteraction,
  roleId: string,
): boolean {
  return (
    interaction.inCachedGuild() &&
    interaction.member.roles.cache.has(roleId)
  );
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function nitroDisplayName(request: NitroRecord): string {
  const preset = NITRO_PRESETS[request.preset];
  return request.preset === "remove"
    ? "Remove Nitro Badge"
    : `${preset.label} Nitro`;
}

function noticeContainer(
  title: string,
  description: string,
  accentColor: number,
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}\n${description}`),
      new TextDisplayBuilder().setContent("-# Jadges • Staff badge selection"),
    );
}

async function replyWithNotice(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  accentColor: number,
): Promise<void> {
  await interaction.reply({
    components: [noticeContainer(title, description, accentColor)],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });
}

function reviewDmContainer(
  badge: BadgeRecord,
  outcome: "approved" | "denied",
): ContainerBuilder {
  const approved = outcome === "approved";
  const heading = approved
    ? "## Your badge got accepted!"
    : "## Your badge was denied";
  const message = approved
    ? "After review, a member of the staff team has approved your badge. It is now equipped on your profile. Refresh or restart Discord to see it. Other users with the Jadges plugin installed will also be able to see your badge."
    : "After review, a member of the staff team has decided not to approve your badge. It has not been equipped on your profile. You may submit a new badge that follows the server's badge guidelines.";

  return new ContainerBuilder()
    .setAccentColor(approved ? 0x57f287 : 0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${heading}\n${message}\n\n**Badge:** ${badge.name}`,
      ),
      new TextDisplayBuilder().setContent("-# Jadges • Badge review update"),
    );
}

function nitroReviewDmContainer(
  request: NitroRecord,
  outcome: "approved" | "denied",
): ContainerBuilder {
  const approved = outcome === "approved";
  const removing = request.preset === "remove";
  const heading = approved
    ? removing
      ? "## Native Nitro badges will now be hidden"
      : "## Your Nitro preset got accepted!"
    : "## Your Nitro preset was denied";
  const message = approved
    ? removing
      ? "After review, Jadges will hide your native Nitro and server-boosting profile badges for people using the Jadges plugin."
      : "After review, a member of the staff team has approved your Nitro preset. It is now equipped through Jadges. Refresh or restart Discord to see it. Other users with the Jadges plugin installed will also see the selected tier."
    : "After review, a member of the staff team has decided not to approve your Nitro preset. Your currently equipped Nitro appearance has not been changed.";

  let subscriberLine = "";
  if (approved && !removing) {
    const publicPreset = publicNitroPreset(
      request.preset,
      request.approvedAt || request.createdAt,
    );
    const subscriberSince = new Date(
      publicPreset.subscriberSince,
    ).toLocaleDateString("en-US");
    subscriberLine = `\n**Subscriber since:** ${subscriberSince}`;
  }

  return new ContainerBuilder()
    .setAccentColor(approved ? 0x57f287 : 0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${heading}\n${message}\n\n**Selection:** ${nitroDisplayName(request)}${subscriberLine}`,
      ),
      new TextDisplayBuilder().setContent("-# Jadges • Nitro preset review"),
    );
}

function adminDeletionDmContainer(
  badgeName: string,
  reason: string,
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## A badge was removed from your profile\nA member of the staff team removed **${badgeName}** from your Jadges profile.\n\n**Reason:** ${reason}`,
      ),
      new TextDisplayBuilder().setContent("-# Jadges • Administrative badge removal"),
    );
}

async function sendReviewDm(
  client: Client,
  badge: BadgeRecord,
  outcome: "approved" | "denied",
): Promise<void> {
  try {
    const user = await client.users.fetch(badge.userId);
    await user.send({
      components: [reviewDmContainer(badge, outcome)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    console.warn(`Could not DM badge ${outcome} notice to ${badge.userId}:`, error);
  }
}

async function sendNitroReviewDm(
  client: Client,
  request: NitroRecord,
  outcome: "approved" | "denied",
): Promise<void> {
  try {
    const user = await client.users.fetch(request.userId);
    await user.send({
      components: [nitroReviewDmContainer(request, outcome)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    console.warn(`Could not DM Nitro ${outcome} notice to ${request.userId}:`, error);
  }
}

async function sendAdminDeletionDm(
  client: Client,
  userId: string,
  badgeName: string,
  reason: string,
): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({
      components: [adminDeletionDmContainer(badgeName, reason)],
      flags: MessageFlags.IsComponentsV2,
    });
    return true;
  } catch (error) {
    console.warn(`Could not DM administrative deletion notice to ${userId}:`, error);
    return false;
  }
}

async function approvalChannel(client: Client): Promise<TextChannel> {
  const channel = await client.channels.fetch(config.promptChannel);
  if (!(channel instanceof TextChannel)) {
    throw new Error("PROMPT_CHANNEL must point to a text channel");
  }
  return channel;
}

async function sendVerification(
  client: Client,
  badge: BadgeRecord,
): Promise<void> {
  const channel = await approvalChannel(client);
  const embed = new EmbedBuilder()
    .setTitle("Badge approval request")
    .setDescription(`Submitted by <@${badge.userId}>`)
    .addFields(
      { name: "Badge name", value: badge.name },
      { name: "Badge ID", value: badge.id },
    )
    .setImage(publicImageUrl(badge.filename))
    .setColor(0xf0b232)
    .setTimestamp(new Date(badge.createdAt));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`badge:approve:${badge.id}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`badge:deny:${badge.id}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function sendNitroVerification(
  client: Client,
  request: NitroRecord,
): Promise<void> {
  const channel = await approvalChannel(client);
  const preset = NITRO_PRESETS[request.preset];
  const embed = new EmbedBuilder()
    .setTitle("Nitro preset approval request")
    .setDescription(`Submitted by <@${request.userId}>`)
    .addFields(
      { name: "Selection", value: nitroDisplayName(request) },
      { name: "Request ID", value: request.id },
    )
    .setThumbnail(preset.profileIcon)
    .setColor(0xf0b232)
    .setTimestamp(new Date(request.createdAt));

  if (request.preset !== "remove") embed.setImage(preset.hoverImage);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`nitro:approve:${request.id}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`nitro:deny:${request.id}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function createBadge(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const user = await getUser(userId);
  if (user.blocked) {
    await interaction.editReply("You are blocked from submitting badges.");
    return;
  }

  const member = interaction.member as GuildMember;
  const hasUnlimitedBadges = member.roles.cache.has(UNLIMITED_BADGES_ROLE_ID);
  const limit = config.maxBadges +
    (member.premiumSince ? config.extraBoostBadges : 0);

  if (!hasUnlimitedBadges && user.badges.length >= limit) {
    await interaction.editReply(
      `You already have the maximum of ${limit} badges, including pending badges.`,
    );
    return;
  }

  const name = cleanName(interaction.options.getString("name", true));
  const attachment = interaction.options.getAttachment("image", true) as Attachment;
  const contentType = attachment.contentType?.split(";")[0] || "";

  if (
    !name ||
    config.blacklistedWords.some((word) => name.toLowerCase().includes(word))
  ) {
    await interaction.editReply("That badge name is not allowed.");
    return;
  }
  if (
    user.badges.some(
      (badge) => badge.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    await interaction.editReply("You already have a badge with that name.");
    return;
  }
  if (attachment.size > config.maxBadgeSize) {
    await interaction.editReply(
      `The image is larger than ${Math.floor(config.maxBadgeSize / 1024 / 1024)} MB.`,
    );
    return;
  }
  if (!isSupportedImage(contentType)) {
    await interaction.editReply("Use a PNG, JPG, WEBP, GIF, or APNG image.");
    return;
  }

  let badge: BadgeRecord | undefined;
  try {
    const stored = await saveDiscordAttachment(attachment.url, contentType);
    badge = {
      id: randomUUID(),
      userId,
      name,
      filename: stored.filename,
      mimeType: stored.mimeType,
      pending: true,
      createdAt: new Date().toISOString(),
    };
    await addPendingBadge(badge);
    await sendVerification(client, badge);
    await interaction.editReply("Badge saved and sent for approval.");
  } catch (error) {
    console.error("Badge submission failed:", error);
    if (badge) {
      try {
        await removeBadgeById(badge.id);
        await deleteStoredImage(badge.filename);
      } catch (cleanupError) {
        console.error("Submission cleanup failed:", cleanupError);
      }
    }
    await interaction.editReply(
      "I could not save or submit that badge. Check the Render logs.",
    );
  }
}

async function createNitroRequest(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const user = await getUser(userId);
  if (user.blocked) {
    await interaction.editReply("You are blocked from submitting Nitro presets.");
    return;
  }

  const selected = interaction.options.getString("preset", true);
  if (!isNitroPreset(selected)) {
    await interaction.editReply("That Nitro preset is not valid.");
    return;
  }
  if (user.pendingNitro) {
    await interaction.editReply(
      "You already have a Nitro preset waiting for staff approval.",
    );
    return;
  }
  if (user.nitro?.preset === selected) {
    await interaction.editReply(
      selected === "remove"
        ? "Native Nitro badge removal is already enabled."
        : `${NITRO_PRESETS[selected].label} Nitro is already equipped.`,
    );
    return;
  }

  const request: NitroRecord = {
    id: randomUUID(),
    userId,
    preset: selected,
    pending: true,
    createdAt: new Date().toISOString(),
  };

  let saved = false;
  try {
    await addPendingNitro(request);
    saved = true;
    await sendNitroVerification(client, request);
    await interaction.editReply(
      `${nitroDisplayName(request)} was sent for staff approval.`,
    );
  } catch (error) {
    console.error("Nitro preset submission failed:", error);
    if (saved) {
      try {
        await removePendingNitro(request.id);
      } catch (cleanupError) {
        console.error("Nitro submission cleanup failed:", cleanupError);
      }
    }
    await interaction.editReply(
      "I could not submit that Nitro preset. Check the Render logs.",
    );
  }
}

async function removeNitroBadge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const removed = await removeNitroForUser(interaction.user.id);
    const removedAnything =
      removed.removedEquipped || removed.removedPending || removed.removedLegacy;

    if (!removedAnything) {
      await interaction.editReply(
        "You do not have an equipped or pending Jadges Nitro badge.",
      );
      return;
    }

    if (removed.removedPending && !removed.removedEquipped && !removed.removedLegacy) {
      await interaction.editReply("Your pending Nitro preset request was removed.");
      return;
    }

    await interaction.editReply(
      removed.removedPending
        ? "Your Jadges Nitro badge and pending request were removed."
        : "Your Jadges Nitro badge was removed. Native Discord badges will be restored for Jadges users.",
    );
  } catch (error) {
    console.error("Nitro removal failed:", error);
    await interaction.editReply(
      "I could not remove your Nitro badge. Check the Render logs.",
    );
  }
}

async function setStaffBadge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const selection = interaction.options.getString("badge", true);
  const hasAdminRole = hasRole(interaction, JAYCORD_ADMIN_ROLE_ID);
  const hasStaffRole = hasRole(interaction, JAYCORD_STAFF_ROLE_ID);
  const user = await getUser(interaction.user.id);

  if (selection === "admin") {
    if (!hasAdminRole) {
      await replyWithNotice(
        interaction,
        "No permission",
        "You are not allowed to use this command with the selected option. Please choose another option and try again.",
        0xed4245,
      );
      return;
    }

    if (user.staffBadgeMode === "admin") {
      await replyWithNotice(
        interaction,
        "No changes made",
        "The selected badge is already equipped on your profile, so no changes were made.",
        0xfee75c,
      );
      return;
    }

    await setStaffBadgeMode(interaction.user.id, "admin");
    await replyWithNotice(
      interaction,
      "Badge updated",
      "Jaycord Admin is now equipped as your pinned staff badge. It replaces Jaycord Staff for Jadges users.",
      0x57f287,
    );
    return;
  }

  if (selection !== "default") {
    await replyWithNotice(
      interaction,
      "Invalid option",
      "That staff badge option is not available. Please choose one of the listed options.",
      0xed4245,
    );
    return;
  }

  if (!hasStaffRole && !hasAdminRole) {
    await replyWithNotice(
      interaction,
      "No permission",
      "You are not allowed to use this command with the selected option. Please choose another option and try again.",
      0xed4245,
    );
    return;
  }

  if (user.staffBadgeMode !== "admin") {
    await replyWithNotice(
      interaction,
      "No changes made",
      "Jaycord Staff is already equipped on your profile, so no changes were made.",
      0xfee75c,
    );
    return;
  }

  await setStaffBadgeMode(interaction.user.id, "default");
  await replyWithNotice(
    interaction,
    "Badge updated",
    "Jaycord Staff has been restored as your pinned staff badge.",
    0x57f287,
  );
}

async function removeOwnBadge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const value = interaction.options.getString("badge", true);
  const badgeId = value.startsWith("custom:") ? value.slice("custom:".length) : undefined;

  try {
    const badge = badgeId
      ? await removeBadgeForUserById(interaction.user.id, badgeId)
      : await removeBadgeByName(interaction.user.id, cleanName(value));
    await deleteStoredImage(badge.filename);
    await interaction.reply({
      content: `**${badge.name}** was removed from your profile.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    await interaction.reply({
      content: "I could not find that badge on your profile.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function adminDeleteBadge(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!hasVerifierRole(interaction)) {
    await interaction.editReply("You cannot use this command.");
    return;
  }

  const target = interaction.options.getUser("user", true);
  const selected = interaction.options.getString("badge", true);
  const reason = cleanName(interaction.options.getString("reason", true));

  try {
    let badgeName: string;

    if (selected.startsWith("custom:")) {
      const badge = await removeBadgeForUserById(
        target.id,
        selected.slice("custom:".length),
      );
      badgeName = badge.name;
      await deleteStoredImage(badge.filename).catch((error) => {
        console.warn(`Could not remove stored image for ${badge.id}:`, error);
      });
    } else if (selected === "nitro:equipped") {
      const request = await removeEquippedNitroForUser(target.id);
      badgeName = nitroDisplayName(request);
    } else if (selected === "nitro:pending") {
      const request = await removePendingNitroForUser(target.id);
      badgeName = `${nitroDisplayName(request)} (pending)`;
    } else {
      throw new Error("Badge selection is invalid");
    }

    const dmSent = await sendAdminDeletionDm(
      client,
      target.id,
      badgeName,
      reason,
    );

    await interaction.editReply(
      `Deleted **${badgeName}** from ${target.username}'s Jadges profile.${
        dmSent ? " The user was notified by DM." : " I could not DM the user."
      }`,
    );
  } catch (error) {
    console.error("Administrative badge deletion failed:", error);
    await interaction.editReply(
      "That badge could not be found or has already been removed.",
    );
  }
}

async function openRearrangePage(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!isRearrangeConfigured()) {
    await interaction.reply({
      content:
        "The rearrangement website is not configured yet. Add `DISCORD_CLIENT_SECRET` on Render and set the Discord OAuth redirect URI to `" +
        `${config.publicUrl}/oauth/callback` +
        "`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ticket = createRearrangeTicket(interaction.user.id);
  const url = `${config.publicUrl}/rearrange?ticket=${encodeURIComponent(ticket)}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open badge rearranger")
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );

  await interaction.reply({
    content:
      "Open your private badge rearrangement page below. You must authorize the same Discord account that ran this command. The link expires in 30 minutes.",
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function listBadges(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const target = interaction.options.getUser("user") || interaction.user;
  const user = await getUser(target.id);
  const lines = user.badges.map(
    (badge) => `• **${badge.name}**${badge.pending ? " — pending" : ""}`,
  );

  if (user.nitro) {
    lines.push(`• **${nitroDisplayName(user.nitro)}**`);
  } else if (user.pendingNitro) {
    lines.push(`• **${nitroDisplayName(user.pendingNitro)}** — pending`);
  }

  if (user.staffBadgeMode === "admin") {
    lines.push("• **Jaycord Admin** — pinned staff badge selection");
  }

  if (user.badgeSide) {
    lines.push(`\n**Placement:** ${user.badgeSide === "left" ? "Left side" : "Right side"}`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`${target.username}'s badges`)
    .setDescription(lines.length ? lines.join("\n") : "No badges found.")
    .setColor(0x5865f2);

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

async function setUserBlock(
  interaction: ChatInputCommandInteraction,
  blocked: boolean,
): Promise<void> {
  if (!hasVerifierRole(interaction)) {
    await interaction.reply({
      content: "You cannot use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getUser("user", true);
  await setBlocked(target.id, blocked);
  await interaction.reply({
    content: `${target.username} has been ${blocked ? "blocked" : "unblocked"}.`,
    flags: MessageFlags.Ephemeral,
  });
}

function truncateChoice(value: string): string {
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (interaction.commandName !== "badge") return;

  const subcommand = interaction.options.getSubcommand(false);
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "badge") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value || "").toLowerCase();

  if (subcommand === "remove") {
    const user = await getUser(interaction.user.id);
    const choices = user.badges
      .filter((badge) => badge.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((badge) => ({
        name: truncateChoice(`${badge.name}${badge.pending ? " (pending)" : ""}`),
        value: `custom:${badge.id}`,
      }));
    await interaction.respond(choices);
    return;
  }

  if (subcommand !== "delete" || !hasVerifierRole(interaction)) {
    await interaction.respond([]);
    return;
  }

  const targetValue = interaction.options.get("user")?.value;
  const targetId = typeof targetValue === "string" ? targetValue : undefined;
  if (!targetId) {
    await interaction.respond([]);
    return;
  }

  const user = await getUser(targetId);
  const choices: Array<{ name: string; value: string }> = user.badges.map((badge) => ({
    name: truncateChoice(`${badge.name}${badge.pending ? " (pending)" : ""}`),
    value: `custom:${badge.id}`,
  }));

  if (user.nitro) {
    choices.push({ name: truncateChoice(nitroDisplayName(user.nitro)), value: "nitro:equipped" });
  }
  if (user.pendingNitro) {
    choices.push({
      name: truncateChoice(`${nitroDisplayName(user.pendingNitro)} (pending)`),
      value: "nitro:pending",
    });
  }

  await interaction.respond(
    choices
      .filter((choice) => choice.name.toLowerCase().includes(query))
      .slice(0, 25),
  );
}

async function handleCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== "badge") return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === "nitro") {
    if (subcommand === "set") {
      await createNitroRequest(client, interaction);
    } else if (subcommand === "remove") {
      await removeNitroBadge(interaction);
    }
    return;
  }

  switch (subcommand) {
    case "create":
      await createBadge(client, interaction);
      break;
    case "remove":
      await removeOwnBadge(interaction);
      break;
    case "delete":
      await adminDeleteBadge(client, interaction);
      break;
    case "rearrange":
      await openRearrangePage(interaction);
      break;
    case "staff":
      await setStaffBadge(interaction);
      break;
    case "list":
      await listBadges(interaction);
      break;
    case "block":
      await setUserBlock(interaction, true);
      break;
    case "unblock":
      await setUserBlock(interaction, false);
      break;
  }
}

async function handleBadgeButton(
  client: Client,
  interaction: ButtonInteraction,
  action: string,
  badgeId: string,
): Promise<void> {
  if (action === "approve") {
    const badge = await approveBadge(badgeId);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]!)
      .setColor(0x57f287)
      .setFooter({ text: `Approved by ${interaction.user.username}` });
    await interaction.update({ embeds: [embed], components: [] });
    await sendReviewDm(client, badge, "approved");
    return;
  }

  if (action === "deny") {
    const badge = await removeBadgeById(badgeId);
    await deleteStoredImage(badge.filename);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]!)
      .setColor(0xed4245)
      .setFooter({ text: `Denied by ${interaction.user.username}` });
    await interaction.update({ embeds: [embed], components: [] });
    await sendReviewDm(client, badge, "denied");
  }
}

async function handleNitroButton(
  client: Client,
  interaction: ButtonInteraction,
  action: string,
  requestId: string,
): Promise<void> {
  if (action === "approve") {
    const request = await approveNitro(requestId);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]!)
      .setColor(0x57f287)
      .setFooter({ text: `Approved by ${interaction.user.username}` });
    await interaction.update({ embeds: [embed], components: [] });
    await sendNitroReviewDm(client, request, "approved");
    return;
  }

  if (action === "deny") {
    const request = await removePendingNitro(requestId);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]!)
      .setColor(0xed4245)
      .setFooter({ text: `Denied by ${interaction.user.username}` });
    await interaction.update({ embeds: [embed], components: [] });
    await sendNitroReviewDm(client, request, "denied");
  }
}

async function handleButton(
  client: Client,
  interaction: ButtonInteraction,
): Promise<void> {
  if (
    !interaction.customId.startsWith("badge:") &&
    !interaction.customId.startsWith("nitro:")
  ) {
    return;
  }

  if (!hasVerifierRole(interaction)) {
    await interaction.reply({
      content: "You cannot review requests.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [kind, action, requestId] = interaction.customId.split(":");
  if (!kind || !action || !requestId) return;

  try {
    if (kind === "badge") {
      await handleBadgeButton(client, interaction, action, requestId);
    } else if (kind === "nitro") {
      await handleNitroButton(client, interaction, action, requestId);
    }
  } catch (error) {
    console.error("Review failed:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "That request no longer exists.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

export async function startDiscordBot(): Promise<Client> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body: [badgeCommand.toJSON()] });
  console.log(
    `Registered ${config.guildId ? "guild" : "global"} slash commands.`,
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: botPresence,
  });

  client.once(Events.ClientReady, (readyClient) => {
    readyClient.user.setPresence(botPresence);
    console.log(`Discord bot connected as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
      } else if (interaction.isChatInputCommand()) {
        await handleCommand(client, interaction);
      } else if (interaction.isButton()) {
        await handleButton(client, interaction);
      }
    } catch (error) {
      console.error("Interaction failed:", error);
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => undefined);
      }
    }
  });

  await client.login(config.discordToken);
  return client;
}
