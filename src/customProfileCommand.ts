import { createHmac } from "node:crypto";
import {
  ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config.js";

const SESSION_COOKIE = "jadges_session";
const PENDING_MESSAGE = "your custom profile is now waiting for approval";
let installed = false;

const customProfileCommand = new SlashCommandBuilder()
  .setName("customprofile")
  .setDescription("Submit a custom profile change for staff approval")
  .addStringOption((option) =>
    option
      .setName("username")
      .setDescription("Custom profile name; leave empty to use your original name")
      .setMaxLength(32)
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("date")
      .setDescription("Custom account creation date in YYYY-MM-DD format")
      .setMinLength(10)
      .setMaxLength(10)
      .setRequired(false),
  );

function commandCollectionRoute(): `/${string}` {
  return config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
}

function commandRoute(commandId: string): `/${string}` {
  return config.guildId
    ? Routes.applicationGuildCommand(config.clientId, config.guildId, commandId)
    : Routes.applicationCommand(config.clientId, commandId);
}

async function registerCommand(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const collectionRoute = commandCollectionRoute();
  const commands = await rest.get(collectionRoute) as Array<{ id?: unknown; name?: unknown }>;
  const existing = commands.find((command) => command.name === customProfileCommand.name);
  const body = customProfileCommand.toJSON();

  if (typeof existing?.id === "string") {
    await rest.patch(commandRoute(existing.id), { body });
  } else {
    await rest.post(collectionRoute, { body });
  }

  console.log(`Registered ${config.guildId ? "guild" : "global"} /customprofile command.`);
}

function signedSessionCookie(userId: string): string {
  const body = Buffer.from(JSON.stringify({
    kind: "session",
    userId,
    expiresAt: Date.now() + 5 * 60 * 1000,
  })).toString("base64url");
  const signature = createHmac("sha256", config.webSessionSecret)
    .update(body)
    .digest("base64url");
  return `${SESSION_COOKIE}=${encodeURIComponent(`${body}.${signature}`)}`;
}

async function submitThroughWebsiteRoute(
  userId: string,
  username: string | null,
  createdAt: string | null,
): Promise<string> {
  const response = await fetch(new URL("/api/custom-profile", config.publicUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: signedSessionCookie(userId),
    },
    body: JSON.stringify({ username, createdAt }),
  });

  const result = await response.json().catch(() => ({})) as {
    error?: unknown;
    message?: unknown;
  };

  if (!response.ok) {
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "Could not submit your custom profile request",
    );
  }

  return typeof result.message === "string" ? result.message : PENDING_MESSAGE;
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const username = interaction.options.getString("username");
  const createdAt = interaction.options.getString("date");

  try {
    const message = await submitThroughWebsiteRoute(
      interaction.user.id,
      username,
      createdAt,
    );
    await interaction.editReply(message);
  } catch (error) {
    await interaction.editReply(
      error instanceof Error
        ? error.message
        : "Could not submit your custom profile request",
    );
  }
}

export async function installCustomProfileCommand(client: Client): Promise<void> {
  if (installed) return;
  installed = true;

  await registerCommand();
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "customprofile") return;
    void handleCommand(interaction).catch((error) => {
      console.error("Custom Profile command failed:", error);
    });
  });
}
