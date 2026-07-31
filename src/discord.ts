import {
  ActionRowBuilder,
  ActivityType,
  Attachment,
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
import {
  addPendingBadge,
  addPendingNitro,
  approveBadge,
  approveNitro,
  getUser,
  removeBadgeById,
  removeBadgeByName,
  removeNitroForUser,
  removePendingNitro,
  setBlocked,
} from "./store.js";
import {
  deleteStoredImage,
  isSupportedImage,
  publicImageUrl,
  saveDiscordAttachment,
} from "./storage.js";
import type { BadgeRecord, NitroRecord } from "./types.js";

const UNLIMITED_BADGES_ROLE_ID = "1531693367639937075";

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
      .setName("delete")
      .setDescription("Delete one of your custom badges")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Exact badge name")
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

function hasVerifierRole(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): boolean {
  return (
    interaction.inCachedGuild() &&
    interaction.member.roles.cache.has(config.verifierRole)
  );
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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
  const preset = NITRO_PRESETS[request.preset];
  const heading = approved
    ? "## Your Nitro preset got accepted!"
    : "## Your Nitro preset was denied";
  const message = approved
    ? "After review, a member of the staff team has approved your Nitro preset. It is now equipped through Jadges. Refresh or restart Discord to see it. Other users with the Jadges plugin installed will also see the selected tier."
    : "After review, a member of the staff team has decided not to approve your Nitro preset. Your currently equipped Nitro appearance has not been changed.";

  let subscriberLine = "";
  if (approved) {
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
        `${heading}\n${message}\n\n**Preset:** ${preset.label} Nitro${subscriberLine}`,
      ),
      new TextDisplayBuilder().setContent("-# Jadges • Nitro preset review"),
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
      { name: "Preset", value: `${preset.label} Nitro` },
      { name: "Request ID", value: request.id },
    )
    .setThumbnail(preset.profileIcon)
    .setImage(preset.hoverImage)
    .setColor(0xf0b232)
    .setTimestamp(new Date(request.createdAt));

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
      `${NITRO_PRESETS[selected].label} Nitro is already equipped.`,
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
      `${NITRO_PRESETS[selected].label} Nitro was sent for staff approval.`,
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
        : "Your Jadges Nitro badge was removed.",
    );
  } catch (error) {
    console.error("Nitro removal failed:", error);
    await interaction.editReply(
      "I could not remove your Nitro badge. Check the Render logs.",
    );
  }
}

async function deleteBadge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const name = cleanName(interaction.options.getString("name", true));
  try {
    const badge = await removeBadgeByName(interaction.user.id, name);
    await deleteStoredImage(badge.filename);
    await interaction.reply({
      content: "Badge deleted.",
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    await interaction.reply({
      content: "I could not find a badge with that exact name.",
      flags: MessageFlags.Ephemeral,
    });
  }
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
    lines.push(`• **${NITRO_PRESETS[user.nitro.preset].label} Nitro**`);
  } else if (user.pendingNitro) {
    lines.push(
      `• **${NITRO_PRESETS[user.pendingNitro.preset].label} Nitro** — pending`,
    );
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
    case "delete":
      await deleteBadge(interaction);
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
      if (interaction.isChatInputCommand()) {
        await handleCommand(client, interaction);
      } else if (interaction.isButton()) {
        await handleButton(client, interaction);
      }
    } catch (error) {
      console.error("Interaction failed:", error);
    }
  });

  await client.login(config.discordToken);
  return client;
}
