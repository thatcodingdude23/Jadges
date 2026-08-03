import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { config } from "./config.js";
import {
  buildSupportInstructions,
  KETTU_PLUGIN_URL,
  REVENGE_PLUGIN_URL,
  VENCORD_PLUGIN_URL,
} from "./supportKnowledge.js";

const SUPPORT_CHANNEL_ID = "1532718405440901230";
const USER_COOLDOWN_MS = 1_500;
const HISTORY_TTL_MS = 30 * 60 * 1_000;
const MAX_HISTORY_TURNS = 10;
const AI_TIMEOUT_MS = 20_000;
const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();
const GROQ_SUPPORT_MODEL =
  process.env.GROQ_SUPPORT_MODEL?.trim() || "llama-3.3-70b-versatile";
const GROQ_BASE_URL = (
  process.env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1"
).replace(/\/$/, "");

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface ConversationHistory {
  updatedAt: number;
  turns: ConversationTurn[];
}

interface GroqChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string;
    };
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
const SUPPORT_INSTRUCTIONS = buildSupportInstructions(config.publicUrl);

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
  return /^(thanks|thank you|ty|thx|ok|okay|alr|alright|got it|fixed|solved|works|working|nice|cool|great|perfect|bet|w)[!. ]*$/.test(
    text,
  );
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|sup|salam|assalamualaikum|as-salamu alaykum)( there)?[!. ]*$/.test(
    text,
  );
}

function looksLikeSupportRequest(text: string): boolean {
  return (
    text.includes("?")
    || /^(how|what|why|when|where|who|can|could|do|does|did|is|are|will|would|should|help|need)\b/.test(
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
      "jaycord",
      "install",
      "download",
      "approval",
      "pending",
      "not working",
      "doesn't work",
      "doesnt work",
      "error",
      "issue",
      "problem",
      "support",
      "rearrange",
      "rearrangement",
      "profile",
      "private link",
      "share link",
      "send link",
      "is this safe",
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

function isRearrangementLinkSafetyQuestion(text: string): boolean {
  const mentionsRearrangementLink =
    /\b(?:rearrange|rearrangement)\b/.test(text)
    && /\b(?:link|url|ticket)\b/.test(text);

  if (!mentionsRearrangementLink) return false;

  return includesAny(text, [
    "send",
    "share",
    "give",
    "someone",
    "anyone",
    "friend",
    "asked me",
    "told me",
    "should i",
    "is it safe",
    "safe to",
    "can i post",
    "can i dm",
    "staff asked",
  ]);
}

function isSecretSharingQuestion(text: string): boolean {
  const mentionsSecret = includesAny(text, [
    "api key",
    "bot token",
    "discord token",
    "password",
    "session cookie",
    "oauth code",
    "private key",
  ]);
  const mentionsSharing = includesAny(text, [
    "send",
    "share",
    "give",
    "post",
    "dm",
    "asked me",
    "told me",
    "should i",
  ]);
  return mentionsSecret && mentionsSharing;
}

function deterministicResponse(rawContent: string): string | undefined {
  const text = normalizeMessage(rawContent);
  if (!text || isAcknowledgement(text)) return undefined;

  if (isGreeting(text)) {
    return "Hey! Ask me anything about Jadges, including plugin installation, badges, approvals, Presets, Nitro appearances, visibility, removal, or rearranging your profile.";
  }

  // Security decisions must run before broad keyword answers such as "rearrange".
  if (isRearrangementLinkSafetyQuestion(text)) {
    return "**No — never send or share your Jadges rearrangement link with anyone, even if they claim to be staff.** It is a private, temporary link tied to your Discord account. Open it only yourself and authorize with the same account that ran `/badge rearrange`. If you already shared it, stop using that link, generate a fresh one with `/badge rearrange`, and tell staff who requested it.";
  }

  if (isSecretSharingQuestion(text)) {
    return "**Do not send or share that secret.** Jadges staff and the support bot will never need your API key, bot token, password, session cookie, OAuth code, or private key. Remove it anywhere you posted it and rotate or regenerate it immediately.";
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
      "plugin",
    ])
  ) {
    return `Jadges is a **custom Vencord userplugin**, not a normal built-in plugin.\n\n1. Get the \`jadgesBadges\` folder here: ${VENCORD_PLUGIN_URL}\n2. Put it in \`Vencord/src/userplugins/jadgesBadges\`.\n3. Rebuild Vencord.\n4. Fully restart Discord.\n5. Open **Vencord Settings → Plugins**, search **JadgesBadges**, and enable it.\n\nIf it does not appear, make sure the folder is not double-nested and that the rebuild completed successfully.`;
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
    return "Jadges is Jaycord’s custom Discord profile-badge system. It supports custom approved badges, community Presets, Nitro appearances, badge rearranging and placement, automatic staff badges, and a badge leaderboard. Jadges customizations are visible only to people using a compatible Jadges plugin.";
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
    return "Check that the badge was approved rather than pending, then fully refresh or restart Discord. Confirm Jadges is installed and enabled on the account viewing the profile. People without the Jadges plugin cannot see Jadges badges.";
  }

  if (
    text.includes("preset")
    && includesAny(text, ["create", "upload", "make", "submit", "publish"])
  ) {
    return `Open ${config.publicUrl}/presets, sign in with Discord, create the preset, enter a name, upload the image, check the preview, and submit it. Preset names can be up to 40 characters, supported images are capped at 5 MB, and staff must approve the preset before it becomes public.`;
  }

  if (
    text.includes("preset")
    && includesAny(text, ["get", "claim", "use", "add", "equip"])
  ) {
    return `Go to ${config.publicUrl}/presets, open an approved preset, and press **Get Badge**. It is added to your Jadges profile immediately. The same account cannot claim the same preset twice.`;
  }

  if (
    text.includes("preset")
    && includesAny(text, ["delete", "remove everywhere", "remove from everyone"])
  ) {
    return "Only the original uploader can delete a preset. Open it and use **Delete Preset Everywhere**. This removes the listing and every claimed copy from users’ Jadges profiles.";
  }

  if (text.includes("preset")) {
    return `Jadges Presets are approved community-made badge designs. You can browse, claim, upload, preview, and manage them at ${config.publicUrl}/presets.`;
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
    return "Badge, Nitro, and Preset submissions remain pending until staff review them. There is no guaranteed approval time. Badge and Nitro decisions are sent by DM when possible.";
  }

  if (isBadgeCreationQuestion(text)) {
    return "Run `/badge create`, enter the badge name, and attach its image. Jadges accepts PNG, JPG, WEBP, GIF, and APNG files up to 5 MB. The badge becomes equipped after staff approve it.";
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
    return "Jadges accepts PNG, JPG/JPEG, WEBP, GIF, and APNG badge images up to 5 MB.";
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
    return "The normal limit is 5 custom badges, including pending submissions. Server boosters receive 5 extra slots, normally allowing 10. The unlimited-badges role bypasses the limit.";
  }

  if (
    text.includes("nitro")
    && includesAny(text, ["remove", "restore", "disable", "native"])
  ) {
    return "Use `/badge nitro remove` to remove your equipped or pending Jadges Nitro setting. Native Discord Nitro and boosting badges are restored for Jadges users if they were hidden.";
  }

  if (text.includes("nitro")) {
    return "Use `/badge nitro set` and choose Bronze, Silver, Gold, Platinum, Diamond, Emerald, Ruby, Opal, or the native-badge hiding option. Staff review the request before it is equipped. Use `/badge nitro remove` to remove the Jadges Nitro setting.";
  }

  if (isBadgeRemovalQuestion(text)) {
    return "Use `/badge remove` and select the custom badge you want to delete. For a Jadges Nitro setting, use `/badge nitro remove`.";
  }

  if (
    includesAny(text, [
      "rearrange",
      "rearrangement",
      "badge order",
      "order badges",
      "move badges",
      "left side",
      "right side",
      "placement",
    ])
  ) {
    return "Run `/badge rearrange` to receive a private link. Open it only yourself and authorize with the same Discord account that ran the command. Never share the link with anyone. It expires after 30 minutes and lets you change badge order and left/right profile placement.";
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
    return "Run `/badge list` to see your Jadges badges and whether any are pending. You can optionally choose another user.";
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
    return "Only people with a compatible Jadges plugin installed and enabled can see Jadges customizations. Users without it see the normal Discord profile.";
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
    return "A submission can fail because the account is blocked, the name contains a restricted word, the same badge name already exists, the file is unsupported or over 5 MB, or the badge limit was reached. Send the exact error message so it can be narrowed down.";
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

function cleanDiscordReply(text: string): string {
  const cleaned = text
    .replace(/@everyone/gi, "@ everyone")
    .replace(/@here/gi, "@ here")
    .replace(/<@&\d+>/g, "a server role")
    .replace(/<@!?\d+>/g, "a Discord user")
    .trim();
  return cleaned.length <= 1_800 ? cleaned : `${cleaned.slice(0, 1_797)}...`;
}

async function askSupportAI(
  key: string,
  userContent: string,
): Promise<string | undefined> {
  if (!GROQ_API_KEY) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_SUPPORT_MODEL,
        messages: [
          {
            role: "system",
            content: SUPPORT_INSTRUCTIONS,
          },
          ...getHistory(key),
          {
            role: "user",
            content: userContent,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
        stream: false,
      }),
    });

    const payload = (await response.json()) as GroqChatCompletionPayload;
    if (!response.ok) {
      console.error(
        `Jadges Groq support request failed (${response.status}):`,
        payload.error?.message || "Unknown Groq API error",
      );
      return undefined;
    }

    const answer = payload.choices?.[0]?.message?.content?.trim();
    return answer ? cleanDiscordReply(answer) : undefined;
  } catch (error) {
    console.error("Jadges Groq support request failed:", error);
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
  const history = getHistory(key);
  const immediate = deterministicResponse(message.content);
  if (!immediate && !looksLikeSupportRequest(normalized) && history.length === 0) {
    return;
  }

  const now = Date.now();
  const previous = lastReplyAt.get(key) || 0;
  if (now - previous < USER_COOLDOWN_MS || activeRequests.has(key)) return;

  activeRequests.add(key);
  lastReplyAt.set(key, now);

  try {
    const response =
      immediate
      || (await askSupportAI(key, message.content))
      || "I could not confidently answer that yet. Include what you were trying to do, which client you use (Vencord, Revenge, or Kettu), and the exact error message or screenshot so staff can help.";

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
      GROQ_API_KEY
        ? `Jadges Groq support enabled with ${GROQ_SUPPORT_MODEL}.`
        : "Jadges Groq support is disabled because GROQ_API_KEY is not set.",
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
