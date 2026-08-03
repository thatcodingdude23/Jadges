import {
  ChannelType,
  Client,
  Events,
  type GuildTextBasedChannel,
} from "discord.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const ANNOUNCEMENT_CHANNEL_ID = "1531693713057779822";
const RELEASE_AT = Date.parse("2026-08-03T10:00:00+04:00");
const RETRY_DELAY_MS = 60_000;
const SENT_STATE_FILE = path.join(
  config.dataDir,
  "preset-release-announcement.json",
);

export const PRESET_RELEASE_ANNOUNCEMENT = [
  "@everyone **Jadges Presets are officially here!** 🎉",
  "",
  "You can now create your own preset badges, share them with the community, and add community-made presets directly to your Jadges profile.",
  "",
  `Browse and create presets here: ${config.publicUrl}/presets`,
].join("\n");

interface SentState {
  sent: boolean;
  messageId?: string;
  sentAt?: string;
}

export interface PresetReleaseAnnouncementHandle {
  stop(): void;
}

async function readSentState(): Promise<SentState> {
  try {
    const parsed = JSON.parse(await readFile(SENT_STATE_FILE, "utf8")) as Partial<SentState>;
    return {
      sent: parsed.sent === true,
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
      sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Could not read the presets release announcement state:", error);
    }
    return { sent: false };
  }
}

async function markSent(messageId: string): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const temporary = `${SENT_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(
      {
        sent: true,
        messageId,
        sentAt: new Date().toISOString(),
      } satisfies SentState,
      null,
      2,
    ),
    "utf8",
  );
  await rename(temporary, SENT_STATE_FILE);
}

async function announcementChannel(client: Client): Promise<GuildTextBasedChannel> {
  const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
  const isSupportedType =
    channel?.type === ChannelType.GuildText
    || channel?.type === ChannelType.GuildAnnouncement;

  if (
    !channel
    || !isSupportedType
    || !channel.isTextBased()
    || channel.isDMBased()
    || !channel.isSendable()
  ) {
    throw new Error("The presets release channel must be a sendable server text or announcement channel");
  }

  return channel as GuildTextBasedChannel;
}

async function findExistingAnnouncement(
  channel: GuildTextBasedChannel,
  botUserId: string,
): Promise<string | undefined> {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find((message) =>
      message.author.id === botUserId
      && message.content === PRESET_RELEASE_ANNOUNCEMENT
    )?.id;
  } catch (error) {
    console.warn("Could not check for an existing presets release announcement:", error);
    return undefined;
  }
}

async function publishAnnouncement(client: Client): Promise<void> {
  const botUser = client.user;
  if (!botUser) throw new Error("Discord bot user is not ready");

  const state = await readSentState();
  if (state.sent) return;

  const channel = await announcementChannel(client);
  const existingMessageId = await findExistingAnnouncement(channel, botUser.id);
  if (existingMessageId) {
    await markSent(existingMessageId);
    console.log("Presets release announcement was already posted; saved its sent state.");
    return;
  }

  const message = await channel.send({
    content: PRESET_RELEASE_ANNOUNCEMENT,
    allowedMentions: { parse: ["everyone"] },
  });

  try {
    await message.react("🔥");
  } catch (error) {
    console.warn("The presets release announcement was sent, but the fire reaction failed:", error);
  }

  await markSent(message.id);
  console.log("Presets release announcement posted successfully.");
}

export function startPresetReleaseAnnouncement(
  client: Client,
): PresetReleaseAnnouncementHandle {
  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void attempt();
    }, Math.max(0, delay));
    timer.unref();
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    try {
      await publishAnnouncement(client);
    } catch (error) {
      console.error(
        "Presets release announcement failed; retrying in one minute:",
        error,
      );
      schedule(RETRY_DELAY_MS);
    }
  };

  const begin = async (): Promise<void> => {
    if (started || stopped) return;
    started = true;

    if ((await readSentState()).sent) {
      console.log("Presets release announcement has already been sent.");
      return;
    }

    const delay = RELEASE_AT - Date.now();
    if (delay > 0) {
      console.log(
        `Presets release announcement scheduled for ${new Date(RELEASE_AT).toISOString()}.`,
      );
      schedule(delay);
    } else {
      await attempt();
    }
  };

  const onReady = (): void => {
    void begin();
  };

  if (client.isReady()) onReady();
  else client.once(Events.ClientReady, onReady);

  return {
    stop(): void {
      stopped = true;
      client.off(Events.ClientReady, onReady);
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
