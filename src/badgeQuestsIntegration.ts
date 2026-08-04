import {
  Client,
  Events,
  REST,
  Routes,
} from "discord.js";
import {
  handleQuestsCommand,
  questsCommand,
  startBadgeQuestSync,
} from "./badgeQuests.js";
import { config } from "./config.js";

export async function installBadgeQuests(client: Client): Promise<{ stop: () => void }> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.post(route, { body: questsCommand.toJSON() });
  console.log("Registered the Badge Quests slash command.");

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "quests") return;
    try {
      await handleQuestsCommand(interaction);
    } catch (error) {
      console.error("Badge Quests command failed:", error);
      const message = "Badge Quests could not be loaded. Please try again shortly.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => undefined);
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
      }
    }
  });

  return startBadgeQuestSync();
}
