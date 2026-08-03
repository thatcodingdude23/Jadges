import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { config } from "./config.js";

const SUPPORT_CHANNEL_ID = "1532718405440901230";
const USER_COOLDOWN_MS = 1_500;

export interface JadgesSupportBotHandle {
  stop(): void;
}

const lastReplyAt = new Map<string, number>();

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
  return /^(thanks|thank you|ty|thx|ok|okay|alr|alright|got it|fixed|solved|works|working|nice|cool)[!. ]*$/.test(text);
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|sup|salam|assalamualaikum|as-salamu alaykum)( there)?[!. ]*$/.test(text);
}

function soundsLikeQuestion(text: string): boolean {
  return text.includes("?")
    || /^(how|what|why|when|where|who|can|could|do|does|did|is|are|will|would|should|help)\b/.test(text)
    || includesAny(text, [
      "jadges",
      "badge",
      "preset",
      "nitro",
      "plugin",
      "not working",
      "doesn't work",
      "doesnt work",
      "error",
      "issue",
      "problem",
      "support",
    ]);
}

function supportResponse(rawContent: string): string | undefined {
  const text = normalizeMessage(rawContent);
  if (!text || isAcknowledgement(text)) return undefined;

  if (isGreeting(text)) {
    return "Hey! I’m the Jadges support bot. Ask me about creating badges, approvals, badge limits, Presets, Nitro badges, visibility, removing badges, or rearranging your profile.";
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
    return "Jadges lets people create and equip custom Discord profile badges. Approved badges appear on your profile for people who have the Jadges plugin installed. Jadges also includes community Presets, Nitro badge presets, badge rearranging, profile placement controls, and a public badge leaderboard.";
  }

  if (
    includesAny(text, ["not showing", "not visible", "can't see", "cant see", "cannot see", "doesn't show", "doesnt show", "isn't showing", "isnt showing", "not appearing"])
  ) {
    return "First, make sure the badge was approved and is not still pending. Then refresh or fully restart Discord. Custom Jadges badges are only visible to users who have the Jadges plugin installed, so people without the plugin will not see them. Also confirm that you are signed into the same Discord account that owns the badge.";
  }

  if (
    text.includes("preset")
    && includesAny(text, ["create", "upload", "make", "submit", "publish"])
  ) {
    return `Open ${config.publicUrl}/presets, sign in with Discord, and choose the option to create a preset. Add the badge name and image, check the profile preview, then submit it. Staff must approve the preset before it becomes publicly available.`;
  }

  if (
    text.includes("preset")
    && includesAny(text, ["get", "claim", "use", "add", "equip"])
  ) {
    return `Go to ${config.publicUrl}/presets, open an approved preset, and press **Get Badge**. The preset will be added to your Jadges profile. You cannot claim the same preset more than once on the same account.`;
  }

  if (
    text.includes("preset")
    && includesAny(text, ["delete", "remove everywhere", "remove from everyone"])
  ) {
    return "Only the person who uploaded a preset can delete it. Open your preset on the Presets website and use **Delete Preset Everywhere**. This removes the preset listing and every claimed copy from users’ Jadges profiles.";
  }

  if (text.includes("preset")) {
    return `Jadges Presets are community-made badge designs. You can browse approved presets, claim them for your profile, upload your own design, preview it before submitting, see its creator and claim count, and manage presets you uploaded. Visit ${config.publicUrl}/presets.`;
  }

  if (
    includesAny(text, ["how long", "when approved", "still pending", "pending for", "approval time", "approve my"])
  ) {
    return "Badge and preset submissions stay pending until a staff member reviews them. There is no guaranteed approval time. You will receive a DM when a custom badge or Nitro preset is approved or denied.";
  }

  if (
    includesAny(text, ["create badge", "make badge", "add badge", "submit badge", "get custom badge", "upload badge"])
  ) {
    return "Run `/badge create`, enter the badge name, and attach its image. Supported formats are PNG, JPG, WEBP, GIF, and APNG, with a maximum size of 5 MB. The badge is sent to staff for approval and becomes equipped after it is approved.";
  }

  if (
    includesAny(text, ["image format", "file format", "supported image", "png", "jpg", "jpeg", "webp", "gif", "apng", "5 mb", "file size"])
    && text.includes("badge")
  ) {
    return "Jadges accepts PNG, JPG, WEBP, GIF, and APNG badge images. The maximum upload size is 5 MB. Use a clear image that will still look good when displayed as a small profile badge.";
  }

  if (
    includesAny(text, ["badge limit", "how many badges", "maximum badges", "max badges", "too many badges"])
  ) {
    return "The normal limit is 5 custom badges, including pending submissions. Server boosters receive 5 additional slots, for a total of 10. Users with the unlimited-badges role are not restricted by that limit.";
  }

  if (
    text.includes("nitro")
    && includesAny(text, ["remove", "restore", "disable", "native"])
  ) {
    return "Use `/badge nitro remove` to remove your equipped or pending Jadges Nitro badge. If Jadges was hiding your native Discord Nitro or boosting badges, removing the Jadges Nitro setting restores those native badges for Jadges users.";
  }

  if (text.includes("nitro")) {
    return "Use `/badge nitro set` and choose the Nitro appearance you want. The request is sent to staff for approval. Once approved, the selected Nitro badge appears through Jadges for other plugin users. Use `/badge nitro remove` whenever you want to remove it.";
  }

  if (
    includesAny(text, ["remove badge", "delete my badge", "get rid of badge", "unequip badge"])
  ) {
    return "Use `/badge remove` and select the custom badge you want to delete. The badge is removed from your profile and its stored image is deleted. To remove a Nitro badge, use `/badge nitro remove`.";
  }

  if (
    includesAny(text, ["rearrange", "badge order", "order badges", "move badges", "left side", "right side", "placement"])
  ) {
    return "Run `/badge rearrange` to receive a private rearrangement link. Open it and authorize the same Discord account that ran the command. The link expires after 30 minutes, and the page lets you change badge order and profile placement.";
  }

  if (
    includesAny(text, ["list badges", "see my badges", "check badges", "which badges", "my badges"])
  ) {
    return "Run `/badge list` to see your Jadges badges and whether any are still pending. You can also select another user with the command to view their Jadges badge list.";
  }

  if (
    includesAny(text, ["who can see", "everyone see", "others see", "without plugin", "need plugin", "visible to"])
  ) {
    return "Jadges badges are client-side profile additions. They are visible to people using the Jadges plugin. Users without the plugin will continue to see the normal Discord profile without the custom Jadges badges.";
  }

  if (
    includesAny(text, ["blocked", "blacklisted", "name not allowed", "can't submit", "cant submit", "cannot submit"])
  ) {
    return "A submission can fail if your account is blocked from submitting, the badge name contains a restricted word, you already have a badge with the same name, the image is unsupported or over 5 MB, or you reached your badge limit. Share the exact error message here so staff can identify which one applies.";
  }

  if (
    includesAny(text, ["website", "site", "link", "url", "presets page"])
  ) {
    return `The Jadges website is ${config.publicUrl}. The Presets marketplace is ${config.publicUrl}/presets.`;
  }

  if (!soundsLikeQuestion(text)) return undefined;

  return "I’m not completely sure which Jadges feature you mean. Please include what you were trying to do, the command or page you used, and the exact error you received. I can help with custom badges, approvals, Presets, Nitro badges, badge limits, visibility, removal, and rearranging.";
}

async function answerSupportMessage(message: Message): Promise<void> {
  if (message.channelId !== SUPPORT_CHANNEL_ID) return;
  if (message.author.bot || message.system || message.webhookId) return;

  const response = supportResponse(message.content);
  if (!response) return;

  const now = Date.now();
  const previous = lastReplyAt.get(message.author.id) || 0;
  if (now - previous < USER_COOLDOWN_MS) return;
  lastReplyAt.set(message.author.id, now);

  await message.channel.sendTyping().catch(() => undefined);
  await message.reply({
    content: response,
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  });
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
