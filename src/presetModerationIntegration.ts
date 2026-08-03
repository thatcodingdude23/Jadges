import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  MessageFlags,
  TextChannel,
} from "discord.js";
import http, { type RequestListener, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { presetsPage } from "./presetPages.js";
import {
  createPreset,
  listPresets,
  presetImagePath,
  presetImageUrl,
  type PresetRecord,
  type PresetUploadPayload,
} from "./presetStore.js";
import {
  discordBotUser,
  originAllowed,
  readJson,
  requirePageLogin,
  sendHtml,
  sendJson,
  sessionUserId,
} from "./presetWeb.js";

interface ModerationEntry {
  presetId: string;
  status: "pending" | "approved";
  submittedAt: string;
  approvedAt?: string;
}

interface ModerationStore {
  entries: Record<string, ModerationEntry>;
}

interface RawPresetStore {
  presets: PresetRecord[];
}

const MODERATION_FILE = path.join(config.dataDir, "preset-moderation.json");
const PRESET_STORE_FILE = path.join(config.dataDir, "presets.json");
let moderationQueue: Promise<void> = Promise.resolve();
let installed = false;

async function ensureModerationStore(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    await readFile(MODERATION_FILE, "utf8");
  } catch {
    await writeFile(MODERATION_FILE, JSON.stringify({ entries: {} }, null, 2), "utf8");
  }
}

async function readModeration(): Promise<ModerationStore> {
  await ensureModerationStore();
  const parsed = JSON.parse(await readFile(MODERATION_FILE, "utf8")) as Partial<ModerationStore>;
  return { entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {} };
}

async function mutateModeration(
  mutation: (store: ModerationStore) => void | Promise<void>,
): Promise<void> {
  const operation = moderationQueue.then(async () => {
    const store = await readModeration();
    await mutation(store);
    const temporary = `${MODERATION_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
    await rename(temporary, MODERATION_FILE);
  });
  moderationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function statusFor(presetId: string): Promise<"pending" | "approved" | "legacy"> {
  await moderationQueue;
  const entry = (await readModeration()).entries[presetId];
  return entry?.status || "legacy";
}

async function approvedPresets(): Promise<PresetRecord[]> {
  const [presets, moderation] = await Promise.all([listPresets(), readModeration()]);
  return presets.filter((preset) => moderation.entries[preset.id]?.status !== "pending");
}

async function markPending(presetId: string): Promise<void> {
  await mutateModeration((store) => {
    store.entries[presetId] = {
      presetId,
      status: "pending",
      submittedAt: new Date().toISOString(),
    };
  });
}

async function approvePreset(presetId: string): Promise<PresetRecord> {
  const preset = (await listPresets()).find((item) => item.id === presetId);
  if (!preset) throw new Error("Preset not found");
  await mutateModeration((store) => {
    const current = store.entries[presetId];
    if (!current || current.status !== "pending") throw new Error("Preset is not pending");
    current.status = "approved";
    current.approvedAt = new Date().toISOString();
  });
  return preset;
}

async function denyPreset(presetId: string): Promise<PresetRecord> {
  const operation = moderationQueue.then(async () => {
    const moderation = await readModeration();
    const current = moderation.entries[presetId];
    if (!current || current.status !== "pending") throw new Error("Preset is not pending");

    const raw = JSON.parse(await readFile(PRESET_STORE_FILE, "utf8")) as RawPresetStore;
    const index = raw.presets.findIndex((preset) => preset.id === presetId);
    if (index === -1) throw new Error("Preset not found");
    const [preset] = raw.presets.splice(index, 1);
    if (!preset) throw new Error("Preset not found");

    const presetTemporary = `${PRESET_STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(presetTemporary, JSON.stringify(raw, null, 2), "utf8");
    await rename(presetTemporary, PRESET_STORE_FILE);
    await rm(presetImagePath(preset.filename), { force: true });

    delete moderation.entries[presetId];
    const moderationTemporary = `${MODERATION_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(moderationTemporary, JSON.stringify(moderation, null, 2), "utf8");
    await rename(moderationTemporary, MODERATION_FILE);
    return preset;
  });
  moderationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function hasVerifierRole(interaction: ButtonInteraction): boolean {
  return interaction.inCachedGuild()
    && interaction.member.roles.cache.has(config.verifierRole);
}

async function reviewChannel(client: Client): Promise<TextChannel> {
  const channel = await client.channels.fetch(config.promptChannel);
  if (!(channel instanceof TextChannel)) {
    throw new Error("PROMPT_CHANNEL must point to a text channel");
  }
  return channel;
}

async function sendReviewRequest(client: Client, preset: PresetRecord): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Preset approval request")
    .setDescription(`Submitted by <@${preset.uploaderId}>`)
    .addFields(
      { name: "Preset name", value: preset.name },
      { name: "Preset ID", value: preset.id },
    )
    .setImage(`${config.publicUrl}${presetImageUrl(preset)}`)
    .setColor(0xf0b232)
    .setTimestamp(new Date(preset.createdAt));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`preset:approve:${preset.id}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`preset:deny:${preset.id}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
  await (await reviewChannel(client)).send({ embeds: [embed], components: [row] });
}

async function dmOutcome(
  client: Client,
  preset: PresetRecord,
  outcome: "approved" | "denied",
): Promise<void> {
  try {
    const user = await client.users.fetch(preset.uploaderId);
    await user.send({
      embeds: [new EmbedBuilder()
        .setTitle(outcome === "approved" ? "Your preset was accepted!" : "Your preset was denied")
        .setDescription(
          outcome === "approved"
            ? `Great news! Your preset **${preset.name}** has been reviewed and approved by the Jadges staff team. It is now live on the Jadges Presets website, where members of the community can view it and add it directly to their Jadges profiles.\n\nThank you for contributing to Jadges and helping the Presets collection grow! You can view your preset and explore the community collection on the [Jadges Presets website](${config.publicUrl}/presets).`
            : `**${preset.name}** was not accepted and has not been added to the Jadges Presets website.`,
        )
        .setColor(outcome === "approved" ? 0x57f287 : 0xed4245)],
    });
  } catch (error) {
    console.warn(`Could not DM preset ${outcome} notice to ${preset.uploaderId}:`, error);
  }
}

async function handleReviewButton(client: Client, interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith("preset:")) return;
  if (!hasVerifierRole(interaction)) {
    await interaction.reply({ content: "You cannot review presets.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, presetId] = interaction.customId.split(":");
  if (!presetId || (action !== "approve" && action !== "deny")) return;

  try {
    const preset = action === "approve"
      ? await approvePreset(presetId)
      : await denyPreset(presetId);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]!)
      .setColor(action === "approve" ? 0x57f287 : 0xed4245)
      .setFooter({ text: `${action === "approve" ? "Accepted" : "Denied"} by ${interaction.user.username}` });
    await interaction.update({ embeds: [embed], components: [] });
    await dmOutcome(client, preset, action === "approve" ? "approved" : "denied");
  } catch (error) {
    console.error("Preset review failed:", error);
    await interaction.reply({ content: "That preset is no longer pending.", flags: MessageFlags.Ephemeral });
  }
}

function submittedToast(html: string): string {
  return html.replace(
    '<section class="preset-heading-row">',
    '<div class="preset-toast success" role="status"><span class="preset-check">✓</span><span>Preset submitted for review</span></div><section class="preset-heading-row">',
  );
}

async function handleWebsite(
  request: http.IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
  client: Client | undefined,
): Promise<boolean> {
  if (url.pathname === "/presets" && request.method === "GET") {
    const userId = requirePageLogin(request, response, `${url.pathname}${url.search}`);
    if (!userId) return true;
    const [profile, presets] = await Promise.all([discordBotUser(userId), approvedPresets()]);
    let html = presetsPage(profile, presets, false);
    if (url.searchParams.get("uploaded") === "1") html = submittedToast(html);
    sendHtml(response, 200, html);
    return true;
  }

  const detailMatch = /^\/presets\/([a-f0-9-]+)$/.exec(url.pathname);
  if (detailMatch?.[1] && request.method === "GET" && await statusFor(detailMatch[1]) === "pending") {
    sendHtml(response, 404, "<!doctype html><html><body style='background:#070b14;color:white;font-family:system-ui;padding:48px'><h1>Preset under review</h1><p>This preset is waiting for staff approval.</p><a style='color:#8b7cff' href='/presets'>Return to Presets</a></body></html>");
    return true;
  }

  const claimMatch = /^\/api\/presets\/([a-f0-9-]+)\/claim$/.exec(url.pathname);
  if (claimMatch?.[1] && await statusFor(claimMatch[1]) === "pending") {
    sendJson(response, 404, { error: "This preset is still waiting for staff approval" });
    return true;
  }

  if (url.pathname !== "/api/presets/upload" || request.method !== "POST") return false;
  const userId = sessionUserId(request);
  if (!userId) {
    sendJson(response, 401, { error: "Login required" });
    return true;
  }
  if (!originAllowed(request, origin)) {
    sendJson(response, 403, { error: "Origin check failed" });
    return true;
  }
  if (!client) {
    sendJson(response, 503, { error: "Preset review is temporarily unavailable" });
    return true;
  }

  try {
    const profile = await discordBotUser(userId);
    const username = profile.username?.trim() || "discord-user";
    const displayName = profile.global_name?.trim() || username;
    const preset = await createPreset(
      userId,
      { id: userId, username, displayName },
      await readJson(request) as PresetUploadPayload,
    );
    try {
      await markPending(preset.id);
      await sendReviewRequest(client, preset);
    } catch (error) {
      await denyPreset(preset.id).catch(() => undefined);
      throw error;
    }
    sendJson(response, 202, { preset: { id: preset.id, name: preset.name }, pending: true });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Upload failed" });
  }
  return true;
}

let discordClient: Client | undefined;

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    void handleWebsite(request, response, url, config.publicUrl, discordClient)
      .then((handled) => { if (!handled) listener(request, response); })
      .catch((error) => {
        console.error("Preset moderation website error:", error);
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ error: "Preset moderation failed" }));
      });
  };
}

export function installPresetModerationWebsite(): void {
  if (installed) return;
  installed = true;
  const mutable = http as typeof http & { createServer: (...args: any[]) => http.Server };
  const original = mutable.createServer.bind(http);
  mutable.createServer = ((...args: any[]): http.Server => {
    const index = args.findIndex((value) => typeof value === "function");
    if (index !== -1) args[index] = wrap(args[index] as RequestListener);
    return original(...args);
  }) as typeof mutable.createServer;
}

export function installPresetModerationDiscord(client: Client): void {
  discordClient = client;
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith("preset:")) {
      await handleReviewButton(client, interaction);
    }
  });
}
