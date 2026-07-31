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
  addPendingBadge,
  approveBadge,
  getUser,
  removeBadgeById,
  removeBadgeByName,
  setBlocked,
} from "./store.js";
import {
  deleteStoredImage,
  isSupportedImage,
  publicImageUrl,
  saveDiscordAttachment,
} from "./storage.js";
import type { BadgeRecord } from "./types.js";

const command = new SlashCommandBuilder()
  .setName("badge")
  .setDescription("Create and manage custom badges")
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
      .setDescription("Delete one of your badges")
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
      .setDescription("List a user's badges")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Defaults to you")
          .setRequired(false),
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
    },
  ],
};

function hasVerifierRole(interaction: ChatInputCommandInteraction | ButtonInteraction): boolean {
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

async function sendVerification(
  client: Client,
  interaction: ChatInputCommandInteraction,
  badge: BadgeRecord,
): Promise<void> {
  const channel = await client.channels.fetch(config.promptChannel);
  if (!(channel instanceof TextChannel)) {
    throw new Error("PROMPT_CHANNEL must point to a text channel");
  }

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
  const limit = config.maxBadges + (member.premiumSince ? config.extraBoostBadges : 0);
  if (user.badges.length >= limit) {
    await interaction.editReply(`You already have the maximum of ${limit} badges, including pending badges.`);
    return;
  }

  const name = cleanName(interaction.options.getString("name", true));
  const attachment = interaction.options.getAttachment("image", true) as Attachment;
  const contentType = attachment.contentType?.split(";")[0] || "";

  if (!name || config.blacklistedWords.some((word) => name.toLowerCase().includes(word))) {
    await interaction.editReply("That badge name is not allowed.");
    return;
  }
  if (user.badges.some((badge) => badge.name.toLowerCase() === name.toLowerCase())) {
    await interaction.editReply("You already have a badge with that name.");
    return;
  }
  if (attachment.size > config.maxBadgeSize) {
    await interaction.editReply(`The image is larger than ${Math.floor(config.maxBadgeSize / 1024 / 1024)} MB.`);
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
    await sendVerification(client, interaction, badge);
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
    await interaction.editReply("I could not save or submit that badge. Check the Render logs.");
  }
}

async function deleteBadge(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = cleanName(interaction.options.getString("name", true));
  try {
    const badge = await removeBadgeByName(interaction.user.id, name);
    await deleteStoredImage(badge.filename);
    await interaction.reply({ content: "Badge deleted.", flags: MessageFlags.Ephemeral });
  } catch {
    await interaction.reply({ content: "I could not find a badge with that exact name.", flags: MessageFlags.Ephemeral });
  }
}

async function listBadges(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser("user") || interaction.user;
  const user = await getUser(target.id);
  const description = user.badges.length
    ? user.badges
        .map((badge) => `• **${badge.name}**${badge.pending ? " — pending" : ""}`)
        .join("\n")
    : "No badges found.";

  const embed = new EmbedBuilder()
    .setTitle(`${target.username}'s badges`)
    .setDescription(description)
    .setColor(0x5865f2);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function setUserBlock(
  interaction: ChatInputCommandInteraction,
  blocked: boolean,
): Promise<void> {
  if (!hasVerifierRole(interaction)) {
    await interaction.reply({ content: "You cannot use this command.", flags: MessageFlags.Ephemeral });
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
  const subcommand = interaction.options.getSubcommand();

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

async function handleButton(client: Client, interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith("badge:")) return;
  if (!hasVerifierRole(interaction)) {
    await interaction.reply({ content: "You cannot review badges.", flags: MessageFlags.Ephemeral });
    return;
  }

  const [, action, badgeId] = interaction.customId.split(":");
  if (!badgeId) return;

  try {
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
  } catch (error) {
    console.error("Badge review failed:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "That badge no longer exists.", flags: MessageFlags.Ephemeral });
    }
  }
}

export async function startDiscordBot(): Promise<Client> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body: [command.toJSON()] });
  console.log(`Registered ${config.guildId ? "guild" : "global"} slash commands.`);

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
