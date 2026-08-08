import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http, { type RequestListener, type ServerResponse } from "node:http";
import path from "node:path";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type Client,
  MessageFlags,
  Routes,
} from "discord.js";
import { config } from "./config.js";

const PARTNER_GUILD_MANAGER_ROLE_ID = "1532572957778645082";
const PARTNER_GUILDS_PATH = "/partner-guilds.json";
const PARTNER_GUILDS_FILE = path.join(config.dataDir, "partner-guilds.json");
const DISCORD_ID = /^\d{15,22}$/;

let httpInstalled = false;
let commandInstalled = false;
let cachedGuildIds: Set<string> | undefined;
let mutationQueue: Promise<void> = Promise.resolve();

interface StoredPartnerGuilds {
  guildIds: string[];
  updatedAt?: string;
}

interface ApiCommand {
  id: string;
  name: string;
  options?: unknown[];
}

function normalizeGuildIds(value: unknown): Set<string> {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as StoredPartnerGuilds).guildIds)
      ? (value as StoredPartnerGuilds).guildIds
      : [];

  return new Set(
    source.filter((guildId): guildId is string =>
      typeof guildId === "string" && DISCORD_ID.test(guildId)
    ),
  );
}

async function partnerGuildIds(): Promise<Set<string>> {
  if (cachedGuildIds) return cachedGuildIds;

  try {
    cachedGuildIds = normalizeGuildIds(
      JSON.parse(await readFile(PARTNER_GUILDS_FILE, "utf8")),
    );
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      console.error("Could not read partner guild storage:", error);
    }
    cachedGuildIds = new Set<string>();
  }

  return cachedGuildIds;
}

async function savePartnerGuildIds(ids: Set<string>): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const temporary = `${PARTNER_GUILDS_FILE}.${process.pid}.${Date.now()}.tmp`;
  const stored: StoredPartnerGuilds = {
    guildIds: [...ids].sort(),
    updatedAt: new Date().toISOString(),
  };

  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await rename(temporary, PARTNER_GUILDS_FILE);
}

export function addPartnerGuildId(guildId: string): Promise<boolean> {
  let added = false;

  const operation = mutationQueue.then(async () => {
    const ids = await partnerGuildIds();
    if (ids.has(guildId)) return;

    ids.add(guildId);
    try {
      await savePartnerGuildIds(ids);
      added = true;
    } catch (error) {
      ids.delete(guildId);
      throw error;
    }
  });

  mutationQueue = operation.catch(() => undefined);
  return operation.then(() => added);
}

async function sendPartnerGuilds(response: ServerResponse): Promise<void> {
  const ids = await partnerGuildIds();
  const body = JSON.stringify({ guildIds: [...ids].sort() });
  response.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store, no-cache, must-revalidate",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", config.publicUrl);
    if (request.method === "GET" && url.pathname === PARTNER_GUILDS_PATH) {
      void sendPartnerGuilds(response).catch((error) => {
        console.error("Could not serve partner guilds:", error);
        if (!response.headersSent) {
          response.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
        }
        response.end(JSON.stringify({ error: "Could not load partner guilds" }));
      });
      return;
    }
    listener(request, response);
  };
}

export function installPartnerGuildHttpIntegration(): void {
  if (httpInstalled) return;
  httpInstalled = true;

  const mutable = http as typeof http & {
    createServer: (...args: any[]) => http.Server;
  };
  const original = mutable.createServer.bind(http) as (...args: any[]) => http.Server;

  mutable.createServer = ((...args: any[]): http.Server => {
    const listenerIndex = typeof args[0] === "function"
      ? 0
      : typeof args[1] === "function"
        ? 1
        : -1;
    if (listenerIndex !== -1) {
      args[listenerIndex] = wrap(args[listenerIndex] as RequestListener);
    }
    return original(...args);
  }) as typeof http.createServer;
}

function hasPartnerGuildRole(interaction: ChatInputCommandInteraction): boolean {
  return interaction.inCachedGuild()
    && interaction.member.roles.cache.has(PARTNER_GUILD_MANAGER_ROLE_ID);
}

async function handlePartnerGuildCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasPartnerGuildRole(interaction)) {
    await interaction.reply({
      content: "You cannot use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.options.getString("guildid", true).trim();
  if (!DISCORD_ID.test(guildId)) {
    await interaction.reply({
      content: "Enter a valid Discord guild ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const added = await addPartnerGuildId(guildId);
    await interaction.reply({
      content: added
        ? `Discord Partner styling is now enabled for guild \`${guildId}\` for Jadges plugin users.`
        : `Guild \`${guildId}\` already has Discord Partner styling enabled for Jadges plugin users.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error("Could not add partner guild:", error);
    await interaction.reply({
      content: "I could not save that partner guild. Check the Render logs.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function registerPartnerSubcommand(client: Client): Promise<void> {
  const listRoute = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
  const commands = await client.rest.get(listRoute) as ApiCommand[];
  const badge = commands.find((command) => command.name === "badge");
  if (!badge) throw new Error("The /badge command was not found after registration");

  const options = Array.isArray(badge.options) ? [...badge.options] : [];
  if (
    options.some((option) =>
      option &&
      typeof option === "object" &&
      (option as { name?: unknown }).name === "partner"
    )
  ) {
    return;
  }

  options.push({
    type: ApplicationCommandOptionType.Subcommand,
    name: "partner",
    description: "Staff: show the Discord Partner badge for a guild",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "guildid",
        description: "Discord guild ID to mark as partnered",
        required: true,
        min_length: 15,
        max_length: 22,
      },
    ],
  });

  const commandRoute = config.guildId
    ? Routes.applicationGuildCommand(config.clientId, config.guildId, badge.id)
    : Routes.applicationCommand(config.clientId, badge.id);
  await client.rest.patch(commandRoute, { body: { options } });
  console.log("Registered /badge partner guildid:<id>.");
}

export async function installPartnerGuildCommand(client: Client): Promise<void> {
  if (commandInstalled) return;
  commandInstalled = true;

  client.on("interactionCreate", (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "badge") return;
    if (interaction.options.getSubcommand(false) !== "partner") return;
    void handlePartnerGuildCommand(interaction).catch((error) => {
      console.error("Partner guild command failed:", error);
    });
  });

  try {
    await registerPartnerSubcommand(client);
  } catch (error) {
    commandInstalled = false;
    throw error;
  }
}
