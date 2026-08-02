import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  ContainerBuilder,
  Events,
  MessageFlags,
  REST,
  Routes,
  TextDisplayBuilder,
} from "discord.js";
import { config } from "./config.js";
import { NITRO_PRESETS } from "./presets.js";
import {
  getUser,
  removeBadgeForUserById,
  removeEquippedNitroForUser,
  removePendingNitroForUser,
} from "./store.js";
import { deleteStoredImage } from "./storage.js";
import type { NitroRecord } from "./types.js";

interface CommandOptionLike {
  type?: number;
  name?: string;
  description?: string;
  required?: boolean;
  autocomplete?: boolean;
  options?: CommandOptionLike[];
}

interface CommandLike {
  id?: string;
  name?: string;
  description?: string;
  options?: CommandOptionLike[];
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseUserId(value: string): string | undefined {
  const normalized = value.trim();
  const mention = /^<@!?(\d{15,22})>$/.exec(normalized)?.[1];
  if (mention) return mention;
  return /^\d{15,22}$/.test(normalized) ? normalized : undefined;
}

function hasVerifierRole(interaction: ChatInputCommandInteraction | AutocompleteInteraction): boolean {
  return interaction.inCachedGuild()
    && interaction.member.roles.cache.has(config.verifierRole);
}

function nitroDisplayName(request: NitroRecord): string {
  const preset = NITRO_PRESETS[request.preset];
  return request.preset === "remove"
    ? "Remove Nitro Badge"
    : `${preset.label} Nitro`;
}

function truncateChoice(value: string): string {
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

async function handleDeleteAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (!hasVerifierRole(interaction)) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "badge") {
    await interaction.respond([]);
    return;
  }

  const rawTarget = interaction.options.getString("user") || "";
  const targetId = parseUserId(rawTarget);
  if (!targetId) {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value || "").toLowerCase();
  const user = await getUser(targetId);
  const choices: Array<{ name: string; value: string }> = user.badges.map((badge) => ({
    name: truncateChoice(`${badge.name}${badge.pending ? " (pending)" : ""}`),
    value: `custom:${badge.id}`,
  }));

  if (user.nitro) {
    choices.push({
      name: truncateChoice(nitroDisplayName(user.nitro)),
      value: "nitro:equipped",
    });
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

function deletionNotice(badgeName: string, reason: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## A badge was removed from your profile\nA member of the staff team removed **${badgeName}** from your Jadges profile.\n\n**Reason:** ${reason}`,
      ),
      new TextDisplayBuilder().setContent("-# Jadges • Administrative badge removal"),
    );
}

async function sendDeletionDm(
  client: Client,
  userId: string,
  badgeName: string,
  reason: string,
): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({
      components: [deletionNotice(badgeName, reason)],
      flags: MessageFlags.IsComponentsV2,
    });
    return true;
  } catch (error) {
    console.warn(`Could not DM administrative deletion notice to ${userId}:`, error);
    return false;
  }
}

async function handleDeleteCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!hasVerifierRole(interaction)) {
    await interaction.editReply("You cannot use this command.");
    return;
  }

  const rawTarget = interaction.options.getString("user", true);
  const targetId = parseUserId(rawTarget);
  if (!targetId) {
    await interaction.editReply("Enter a valid Discord user ID or user mention.");
    return;
  }

  const selected = interaction.options.getString("badge", true);
  const reason = clean(interaction.options.getString("reason", true));

  try {
    let badgeName: string;

    if (selected.startsWith("custom:")) {
      const badge = await removeBadgeForUserById(
        targetId,
        selected.slice("custom:".length),
      );
      badgeName = badge.name;
      await deleteStoredImage(badge.filename).catch((error) => {
        console.warn(`Could not remove stored image for ${badge.id}:`, error);
      });
    } else if (selected === "nitro:equipped") {
      badgeName = nitroDisplayName(await removeEquippedNitroForUser(targetId));
    } else if (selected === "nitro:pending") {
      badgeName = `${nitroDisplayName(await removePendingNitroForUser(targetId))} (pending)`;
    } else {
      throw new Error("Badge selection is invalid");
    }

    const target = await client.users.fetch(targetId).catch(() => undefined);
    const dmSent = await sendDeletionDm(client, targetId, badgeName, reason);
    const targetLabel = target?.username
      ? `@${target.username}`
      : `user ID ${targetId}`;

    await interaction.editReply(
      `Deleted **${badgeName}** from ${targetLabel}'s Jadges profile.${
        dmSent ? " The user was notified by DM." : " I could not DM the user."
      }`,
    );
  } catch (error) {
    console.error("Administrative badge deletion by user ID failed:", error);
    await interaction.editReply(
      "That badge could not be found or has already been removed.",
    );
  }
}

function isDeleteInteraction(
  interaction: unknown,
): interaction is ChatInputCommandInteraction | AutocompleteInteraction {
  if (!(interaction instanceof ChatInputCommandInteraction)
    && !(interaction instanceof AutocompleteInteraction)) {
    return false;
  }
  if (interaction.commandName !== "badge") return false;
  return interaction.options.getSubcommand(false) === "delete";
}

async function updateDeleteCommandOption(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const listRoute = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
  const commands = await rest.get(listRoute) as CommandLike[];
  const badgeCommand = commands.find((command) => command.name === "badge");
  if (!badgeCommand?.id || !badgeCommand.options) {
    throw new Error("Could not find the registered /badge command");
  }

  const deleteCommand = badgeCommand.options.find((option) =>
    option.type === ApplicationCommandOptionType.Subcommand
    && option.name === "delete"
  );
  const userOption = deleteCommand?.options?.find((option) => option.name === "user");
  if (!deleteCommand || !userOption) {
    throw new Error("Could not find the /badge delete user option");
  }

  userOption.type = ApplicationCommandOptionType.String;
  userOption.description = "Discord user ID or user mention";
  userOption.required = true;

  const commandRoute = config.guildId
    ? Routes.applicationGuildCommand(config.clientId, config.guildId, badgeCommand.id)
    : Routes.applicationCommand(config.clientId, badgeCommand.id);
  await rest.patch(commandRoute, {
    body: {
      name: badgeCommand.name,
      description: badgeCommand.description,
      options: badgeCommand.options,
    },
  });
}

export async function installBadgeDeleteUserIdSupport(client: Client): Promise<void> {
  await updateDeleteCommandOption();

  const originalListeners = client.listeners(Events.InteractionCreate);
  client.removeAllListeners(Events.InteractionCreate);

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (isDeleteInteraction(interaction)) {
        if (interaction.isAutocomplete()) {
          await handleDeleteAutocomplete(interaction);
        } else if (interaction.isChatInputCommand()) {
          await handleDeleteCommand(client, interaction);
        }
        return;
      }

      for (const listener of originalListeners) {
        await Promise.resolve(listener.call(client, interaction));
      }
    } catch (error) {
      console.error("Badge delete user-ID integration failed:", error);
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => undefined);
      } else if (
        interaction.isChatInputCommand()
        && !interaction.replied
        && !interaction.deferred
      ) {
        await interaction.reply({
          content: "That command could not be completed.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => undefined);
      }
    }
  });

  console.log("Enabled /badge delete support for Discord user IDs and mentions.");
}
