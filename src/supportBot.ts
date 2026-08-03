import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { config } from "./config.js";

const SUPPORT_CHANNEL_ID = "1532718405440901230";
const USER_COOLDOWN_MS = 1_500;
const HISTORY_TTL_MS = 30 * 60 * 1_000;
const MAX_HISTORY_TURNS = 8;
const AI_TIMEOUT_MS = 15_000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const OPENAI_SUPPORT_MODEL =
  process.env.OPENAI_SUPPORT_MODEL?.trim() || "gpt-5-mini";

const VENCORD_PLUGIN_URL =
  "https://github.com/thatcodingdude23/Jadges/tree/main/vencord-plugin/jadgesBadges";
const REVENGE_PLUGIN_URL =
  "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/";
const KETTU_PLUGIN_URL =
  "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/kettu-plugin/";

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface ConversationHistory {
  updatedAt: number;
  turns: ConversationTurn[];
}

interface OpenAIResponsePayload {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

export interface JadgesSupportBotHandle {
  stop(): void;
}

const lastReplyAt = new Map<string, number>();
const conversationHistory = new Map<string, ConversationHistory>();
const activeRequests = new Set<string>();

const SUPPORT_INSTRUCTIONS = `You are the official Jadges support bot inside the Jaycord Discord server.

Your job is to understand natural wording, spelling mistakes, slang, incomplete questions, and follow-up messages about Jadges. Give a direct, useful answer instead of asking the user to repeat themselves when their intent can reasonably be inferred.

Only answer questions related to Jadges, its Discord bot, its website, its badge system, its Presets marketplace, and installing or troubleshooting its supported client plugins. For unrelated questions, briefly say this channel is for Jadges support.

Use these confirmed Jadges facts:
- Jadges adds custom profile badges that are visible to people using the Jadges plugin.
- Supported clients are Vencord on desktop, Revenge on Android, and Kettu on Android and iOS.
- Vencord is a custom userplugin. Copy the jadgesBadges folder from ${VENCORD_PLUGIN_URL} into Vencord/src/userplugins/jadgesBadges, rebuild Vencord, restart Discord, then enable JadgesBadges in Vencord Settings > Plugins. It is not installed from Vencord's normal built-in plugin list.
- Revenge plugin source: ${REVENGE_PLUGIN_URL}
- Kettu: open Kettu Settings > Plugins, add a plugin from URL, and paste ${KETTU_PLUGIN_URL}
- Create a custom badge with /badge create and attach PNG, JPG, WEBP, GIF, or APNG up to 5 MB.
- Submissions remain pending until staff approve or deny them. There is no guaranteed review time.
- Normal users have 5 custom badge slots. Server boosters get 5 extra slots. The unlimited-badges role bypasses the limit.
- Remove a custom badge with /badge remove. List badges with /badge list. Rearrange them with /badge rearrange.
- Set a Jadges Nitro appearance with /badge nitro set and remove it with /badge nitro remove.
- Presets are at ${config.publicUrl}/presets. Users can browse approved community presets, claim them, upload their own, preview them, and see creator and claim information.
- Preset uploads require staff approval. Only the uploader can delete a preset. Delete Preset Everywhere removes the listing and all claimed copies from profiles.
- Badges not showing: confirm approval, restart or refresh Discord, enable the Jadges plugin, and remember users without the plugin cannot see Jadges badges.
- The official website is ${config.publicUrl}.
- Never ask users to share bot tokens, API keys, passwords, session cookies, or other secrets.
- Do not invent staff decisions, approval times, server permissions, account data, or outage status. When account-specific information is required, tell the user what to check or ask staff to inspect it.

Keep replies clear and usually under 1,200 characters. Use Discord markdown when helpful. Do not ping anyone.`;

function normalizeMessage(content: string): string {
  return content
    .toLowerCase()
    .replace(/<@!?\d+>/g, " ")
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9\s?/_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function isAcknowledgement(text: string): boolean {
  return /^(thanks|thank you|ty|thx|ok|okay|alr|alright|got it|fixed|solved|works|working|nice|cool|great|perfect)[!. ]*$/.test(
    text,
  );
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|sup|salam|assalamualaikum|as-salamu alaykum)( there)?[!. ]*$/.test(
    text,
  );
}

function soundsLikeSupportRequest(text: string): boolean {
  return (
    text.includes("?")
    || /^(how|what|why|when|where|who|can|could|do|does|did|is|are|will|would|should|help)\b/.test(
      text,
    )
    || includesAny(text, [
      "jadges",
      "badge",
      "preset",
      "nitro",
      "plugin",
      "vencord",
      "revenge",
      "kettu",
      "not working",
      "doesn't work",
      "doesnt work",
      "error",
      "issue",
      "problem",
      "support",
      "install",
    ])
  );
}

function isBadgeCreationQuestion(text: string): boolean {
  return (
    /\b(?:create|make|add|submit|upload|get)\s+(?:(?:me|my|a|an|new|custom|own)\s+)*badges?\b/.test(
      text,
    )
    || (/\bhow\s+(?:do|can|could|would|should)\s+i\s+(?:create|make|add|submit|upload|get)\b/.test(
      text,
    )
      && /\bbadges?\b/.test(text))
  );
}

function isBadgeRemovalQuestion(text: string): boolean {
  return (
    /\b(?:remove|delete|unequip)\s+(?:(?:my|a|an|the|this|custom|own)\s+)*badges?\b/.test(
      text,
    )
    || /\bget rid of\s+(?:(?:my|a|an|the|this|custom|own)\s+)*badges?\b/.test(
      text,
    )
  );
}

function deterministicResponse(rawContent: string): string | undefined {
  const text = normalizeMessage(rawContent);
  if (!text || isAcknowledgement(text)) return undefined;

  if (isGreeting(text)) {
    return "Hey! Ask me anything about Jadges, including installing the plugin, creating badges, approvals, Presets, Nitro badges, visibility, removal, or rearranging your profile.";
  }

  if (
    text.includes("vencord")
    && includesAny(text, [
      "install",
      "download",
      "setup",
      "set up",
      "add plugin",
      "get plugin",
    ])
  ) {
    return `Jadges is a **custom Vencord userplugin**, so it will not appear in the normal built-in plugin list.\n\n1. Get the \`jadgesBadges\` folder here: ${VENCORD_PLUGIN_URL}\n2. Put it in \`Vencord/src/userplugins/jadgesBadges\`.\n3. Rebuild Vencord using your normal Vencord build command.\n4. Restart Discord.\n5. Open **Vencord Settings → Plugins**, search **JadgesBadges**, and enable it.`;
  }

  if (
    text.includes("kettu")
    && includesAny(text, ["install", "download", "setup", "plugin", "url"])
  ) {
    return `Open **Kettu Settings → Plugins**, choose **Add plugin from URL**, and paste:\n${KETTU_PLUGIN_URL}`;
  }

  if (
    text.includes("revenge")
    && includesAny(text, ["install", "download", "setup", "plugin", "url"])
  ) {
    return `In Revenge, add this plugin source URL:\n${REVENGE_PLUGIN_URL}`;
  }

  if (
    includesAny(text, [
      "what is jadges",
      "what does jadges",
      "what's jadges",
      "whats jadges",
      "tell me about jadges",
      "jadges purpose",
      "jadges bot",
    ])
  ) {
    return "Jadges lets users create and equip custom Discord profile badges. It also includes community Presets, Nitro badge appearances, badge rearranging and placement, staff badges, and a public badge leaderboard. Jadges customizations are visible to users with the Jadges plugin installed.";
  }

  if (
    includesAny(text, [
      "not showing",
      "not visible",
      "can't see",
      "cant see",
      "cannot see",
      "doesn't show",
      "doesnt show",
      "isn't showing",
      "isnt showing",
      "not appearing",
    ])
  ) {
    return "Make sure the badge was approved and is not still pending, then fully restart or refresh Discord. Confirm the Jadges plugin is installed and enabled on the account viewing the profile. Users without the plugin cannot see Jadges badges.";
  }

  if (
    text.includes("preset")
    && includesAny(text, ["create", "upload", "make", "submit", "publish"])
  ) {
    return `Open ${config.publicUrl}/presets, sign in with Discord, create the preset, add its name and image, check the preview, and submit it. Staff must approve it before it becomes public.`;
  }

  if (
    text.includes("preset")
    && includesAny(text, ["get", "claim", "use", "add", "equip"])
  ) {
    return `Go to ${config.publicUrl}/presets, open an approved preset, and press **Get Badge**. It will be added to your Jadges profile.`;
  }

  if (
    text.includes("preset")
    && includesAny(text, ["delete", "remove everywhere", "remove from everyone"])
  ) {
    return "Only the uploader can delete a preset. Open your preset and use **Delete Preset Everywhere**. This removes the listing and every claimed copy from Jadges profiles.";
  }

  if (text.includes("preset")) {
    return `Jadges Presets are community-made badge designs. Browse, claim, and create them at ${config.publicUrl}/presets.`;
  }

  if (
    includesAny(text, [
      "how long",
      "when approved",
      "still pending",
      "pending for",
      "approval time",
      "approve my",
    ])
  ) {
    return "Submissions stay pending until a staff member reviews them. There is no guaranteed approval time. Jadges sends a DM when a custom badge or Nitro request is approved or denied.";
  }

  if (isBadgeCreationQuestion(text)) {
    return "Run `/badge create`, enter the badge name, and attach its image. Jadges accepts PNG, JPG, WEBP, GIF, and APNG files up to 5 MB. The badge is equipped after staff approve it.";
  }

  if (
    includesAny(text, [
      "image format",
      "file format",
      "supported image",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "gif",
      "apng",
      "5 mb",
      "file size",
    ])
    && text.includes("badge")
  ) {
    return "Jadges accepts PNG, JPG, WEBP, GIF, and APNG badge images up to 5 MB.";
  }

  if (
    includesAny(text, [
      "badge limit",
      "how many badges",
      "maximum badges",
      "max badges",
      "too many badges",
    ])
  ) {
    return "The normal limit is 5 custom badges, including pending submissions. Server boosters receive 5 extra slots, for a total of 10. The unlimited-badges role bypasses the limit.";
  }

  if (
    text.includes("nitro")
    && includesAny(text, ["remove", "restore", "disable", "native"])
  ) {
    return "Use `/badge nitro remove` to remove an equipped or pending Jadges Nitro badge. This also restores native Discord Nitro and boosting badges for Jadges users when they were hidden.";
  }

  if (text.includes("nitro")) {
    return "Use `/badge nitro set` and select the appearance you want. Staff review the request before it is equipped. Use `/badge nitro remove` to remove it.";
  }

  if (isBadgeRemovalQuestion(text)) {
    return "Use `/badge remove` and select the custom badge you want to delete. For a Jadges Nitro badge, use `/badge nitro remove`.";
  }

  if (
    includesAny(text, [
      "rearrange",
      "badge order",
      "order badges",
      "move badges",
      "left side",
      "right side",
      "placement",
    ])
  ) {
    return "Run `/badge rearrange` to receive a private link. Authorize the same Discord account that ran the command. The link expires after 30 minutes and lets you change badge order and profile placement.";
  }

  if (
    includesAny(text, [
      "list badges",
      "see my badges",
      "check badges",
      "which badges",
      "my badges",
    ])
  ) {
    return "Run `/badge list` to see your badges and whether any are pending. You can optionally select another user.";
  }

  if (
    includesAny(text, [
      "who can see",
      "everyone see",
      "others see",
      "without plugin",
      "need plugin",
      "visible to",
    ])
  ) {
    return "Jadges badges are visible to users with the Jadges plugin installed. People without the plugin see the normal Discord profile without Jadges customizations.";
  }

  if (
    includesAny(text, [
      "blocked",
      "blacklisted",
      "name not allowed",
      "can't submit",
      "cant submit",
      "cannot submit",
    ])
  ) {
    return "A submission can fail because the account is blocked, the name contains a restricted word, the same name already exists, the image is unsupported or over 5 MB, or the badge limit was reached. Send the exact error message so it can be narrowed down.";
  }

  if (includesAny(text, ["website", "site", "link", "url", "presets page"])) {
    return `Jadges website: ${config.publicUrl}\nPresets: ${config.publicUrl}/presets`;
  }

  return undefined;
}

function historyKey(message: Message): string {
  return `${message.guildId || "dm"}:${message.author.id}`;
}

function getHistory(key: string): ConversationTurn[] {
  const history = conversationHistory.get(key);
  if (!history || Date.now() - history.updatedAt > HISTORY_TTL_MS) {
    conversationHistory.delete(key);
    return [];
  }
  return history.turns;
}

function rememberExchange(
  key: string,
  userContent: string,
  assistantContent: string,
): void {
  const turns = [
    ...getHistory(key),
    { role: "user" as const, content: userContent },
    { role: "assistant" as const, content: assistantContent },
  ].slice(-MAX_HISTORY_TURNS);

  conversationHistory.set(key, {
    updatedAt: Date.now(),
    turns,
  });
}

function extractOpenAIText(payload: OpenAIResponsePayload): string | undefined {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text?.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  const combined = parts.join("\n").trim();
  return combined || undefined;
}

function cleanDiscordReply(text: string): string {
  const cleaned = text
    .replace(/@everyone/gi, "@ everyone")
    .replace(/@here/gi, "@ here")
    .trim();
  return cleaned.length <= 1_800 ? cleaned : `${cleaned.slice(0, 1_797)}...`;
}

async function askSupportAI(
  key: string,
  userContent: string,
): Promise<string | undefined> {
  if (!OPENAI_API_KEY) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_SUPPORT_MODEL,
        instructions: SUPPORT_INSTRUCTIONS,
        input: [
          ...getHistory(key).map((turn) => ({
            role: turn.role,
            content: turn.content,
          })),
          {
            role: "user",
            content: userContent,
          },
        ],
        max_output_tokens: 350,
        store: false,
      }),
    });

    const payload = (await response.json()) as OpenAIResponsePayload;
    if (!response.ok) {
      console.error(
        `Jadges support AI request failed (${response.status}):`,
        payload.error?.message || "Unknown OpenAI API error",
      );
      return undefined;
    }

    const answer = extractOpenAIText(payload);
    return answer ? cleanDiscordReply(answer) : undefined;
  } catch (error) {
    console.error("Jadges support AI request failed:", error);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function answerSupportMessage(message: Message): Promise<void> {
  if (message.channelId !== SUPPORT_CHANNEL_ID) return;
  if (message.author.bot || message.system || message.webhookId) return;

  const normalized = normalizeMessage(message.content);
  if (!normalized || isAcknowledgement(normalized)) return;

  const key = historyKey(message);
  const now = Date.now();
  const previous = lastReplyAt.get(key) || 0;
  if (now - previous < USER_COOLDOWN_MS || activeRequests.has(key)) return;

  const immediate = deterministicResponse(message.content);
  if (!immediate && !soundsLikeSupportRequest(normalized)) return;

  activeRequests.add(key);
  lastReplyAt.set(key, now);

  try {
    const response =
      immediate
      || (await askSupportAI(key, message.content))
      || "I could not confidently answer that yet. Please include what you were trying to do, which client you use (Vencord, Revenge, or Kettu), and any exact error message or screenshot so staff can help.";

    rememberExchange(key, message.content, response);
    await message.reply({
      content: response,
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });
  } finally {
    activeRequests.delete(key);
  }
}

export async function startJadgesSupportBot(): Promise<JadgesSupportBotHandle> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const onMessage = (message: Message): void => {
    void answerSupportMessage(message).catch((error) => {
      console.error("Jadges support response failed:", error);
    });
  };

  client.on(Events.MessageCreate, onMessage);
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Jadges support responder connected as ${readyClient.user.tag}.`);
    console.log(
      OPENAI_API_KEY
        ? `Jadges AI support enabled with ${OPENAI_SUPPORT_MODEL}.`
        : "Jadges AI support is disabled because OPENAI_API_KEY is not set.",
    );
  });

  try {
    await client.login(config.discordToken);
  } catch (error) {
    console.error(
      "Jadges support responder could not connect. Make sure the Message Content Intent is enabled in the Discord Developer Portal:",
      error,
    );
    client.destroy();
  }

  return {
    stop(): void {
      client.off(Events.MessageCreate, onMessage);
      client.destroy();
    },
  };
}
