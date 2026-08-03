import http, { type RequestListener, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { detailPage, errorPage } from "./presetPages.js";
import {
  findPreset,
  presetImagePath,
  type PresetRecord,
} from "./presetStore.js";
import { mutateStore } from "./store.js";
import {
  discordBotUser,
  originAllowed,
  redirect,
  requirePageLogin,
  sendHtml,
  sessionUserId,
} from "./presetWeb.js";

interface RawPresetStore {
  presets: PresetRecord[];
}

interface RawModerationStore {
  entries?: Record<string, unknown>;
}

const PRESET_STORE_FILE = path.join(config.dataDir, "presets.json");
const MODERATION_FILE = path.join(config.dataDir, "preset-moderation.json");
let deleteQueue: Promise<void> = Promise.resolve();
let installed = false;

function ownerDeleteForm(presetId: string): string {
  return `<form method="post" action="/api/presets/${encodeURIComponent(presetId)}/delete">
    <button class="secondary-button" type="submit">Delete Preset Everywhere</button>
    <p class="preset-claim-message">This also removes the badge from every profile that claimed it.</p>
  </form>`;
}

function addOwnerDeleteButton(html: string, presetId: string): string {
  const claimButton = '<button class="discord-button" id="get-preset-badge" type="button">Get Badge</button>';
  return html.replace(claimButton, `${claimButton}${ownerDeleteForm(presetId)}`);
}

async function removeModerationEntry(presetId: string): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(MODERATION_FILE, "utf8")) as RawModerationStore;
    if (!raw.entries || typeof raw.entries !== "object" || !(presetId in raw.entries)) return;
    delete raw.entries[presetId];
    const temporary = `${MODERATION_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(raw, null, 2), "utf8");
    await rename(temporary, MODERATION_FILE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

async function removeClaimedPresetBadges(presetId: string): Promise<number> {
  const badgeIdPrefix = `preset-${presetId}-`;
  const filenames = await mutateStore((data) => {
    const removedFilenames: string[] = [];

    for (const user of Object.values(data.users)) {
      const removedOrderKeys = new Set<string>();
      user.badges = user.badges.filter((badge) => {
        if (!badge.id.startsWith(badgeIdPrefix)) return true;
        removedFilenames.push(badge.filename);
        removedOrderKeys.add(`custom:${badge.id}`);
        return false;
      });

      if (removedOrderKeys.size > 0 && user.badgeOrder) {
        user.badgeOrder = user.badgeOrder.filter((key) => !removedOrderKeys.has(key));
        if (user.badgeOrder.length === 0) delete user.badgeOrder;
      }
    }

    return removedFilenames;
  });

  await Promise.all(
    filenames.map((filename) =>
      rm(path.join(config.imagesDir, path.basename(filename)), { force: true }),
    ),
  );
  return filenames.length;
}

async function deleteOwnedPreset(userId: string, presetId: string): Promise<PresetRecord> {
  let deleted: PresetRecord | undefined;
  const operation = deleteQueue.then(async () => {
    await mkdir(config.dataDir, { recursive: true });
    const raw = JSON.parse(await readFile(PRESET_STORE_FILE, "utf8")) as RawPresetStore;
    if (!Array.isArray(raw.presets)) throw new Error("Preset store is invalid");

    const index = raw.presets.findIndex((preset) => preset.id === presetId);
    if (index === -1) throw new Error("Preset not found");
    const preset = raw.presets[index];
    if (!preset) throw new Error("Preset not found");
    if (preset.uploaderId !== userId) {
      throw new Error("You can only delete presets that you uploaded");
    }

    await removeClaimedPresetBadges(presetId);

    raw.presets.splice(index, 1);
    const temporary = `${PRESET_STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(raw, null, 2), "utf8");
    await rename(temporary, PRESET_STORE_FILE);
    await rm(presetImagePath(preset.filename), { force: true });
    await removeModerationEntry(presetId);
    deleted = preset;
  });

  deleteQueue = operation.then(() => undefined, () => undefined);
  await operation;
  if (!deleted) throw new Error("Preset could not be deleted");
  return deleted;
}

async function handleRequest(
  request: http.IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
): Promise<boolean> {
  const detailMatch = /^\/presets\/([a-f0-9-]+)$/.exec(url.pathname);
  if (detailMatch?.[1] && request.method === "GET") {
    const userId = requirePageLogin(request, response, url.pathname);
    if (!userId) return true;

    const [profile, preset] = await Promise.all([
      discordBotUser(userId),
      findPreset(detailMatch[1]),
    ]);
    if (!preset) {
      sendHtml(response, 404, errorPage(profile, "Preset not found", "This preset may have been removed."));
      return true;
    }

    let html = detailPage(profile, preset);
    if (preset.uploaderId === userId) {
      html = addOwnerDeleteButton(html, preset.id);
    }
    sendHtml(response, 200, html);
    return true;
  }

  const deleteMatch = /^\/api\/presets\/([a-f0-9-]+)\/delete$/.exec(url.pathname);
  if (!deleteMatch?.[1]) return false;
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
    response.end("Method not allowed");
    return true;
  }

  const userId = sessionUserId(request);
  if (!userId) {
    redirect(response, `/presets/login?next=${encodeURIComponent(`/presets/${deleteMatch[1]}`)}`);
    return true;
  }
  if (!originAllowed(request, origin)) {
    sendHtml(response, 403, errorPage(await discordBotUser(userId), "Delete blocked", "The request origin could not be verified."));
    return true;
  }

  try {
    await deleteOwnedPreset(userId, deleteMatch[1]);
    redirect(response, "/presets");
  } catch (error) {
    const message = error instanceof Error ? error.message : "The preset could not be deleted.";
    const status = message === "Preset not found" ? 404 : 403;
    sendHtml(response, status, errorPage(await discordBotUser(userId), "Could not delete preset", message));
  }
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    const url = new URL(request.url || "/", "https://jadges.local");
    void handleRequest(request, response, url, config.publicUrl)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Preset owner deletion error:", error);
        if (!response.headersSent) {
          response.writeHead(500, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
        }
        if (!response.writableEnded) response.end("Could not process the preset request.");
      });
  };
}

export function installPresetOwnerDeleteIntegration(): void {
  if (installed) return;
  installed = true;

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
