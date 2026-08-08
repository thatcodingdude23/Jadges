import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type PresetReactionKind = "like" | "favorite";

interface PresetReactionRecord {
  likedBy: string[];
  favoritedBy: string[];
}

interface PresetReactionStore {
  presets: Record<string, PresetReactionRecord>;
}

export interface PresetReactionSummary {
  likes: number;
  favorites: number;
  liked: boolean;
  favorited: boolean;
}

const STORE_FILE = path.join(config.dataDir, "preset-reactions.json");
let writeQueue: Promise<void> = Promise.resolve();

async function readUnsafe(): Promise<PresetReactionStore> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, "utf8")) as PresetReactionStore;
    parsed.presets ??= {};
    for (const record of Object.values(parsed.presets)) {
      record.likedBy = Array.isArray(record.likedBy)
        ? [...new Set(record.likedBy.filter((id) => typeof id === "string"))]
        : [];
      record.favoritedBy = Array.isArray(record.favoritedBy)
        ? [...new Set(record.favoritedBy.filter((id) => typeof id === "string"))]
        : [];
    }
    return parsed;
  } catch {
    return { presets: {} };
  }
}

async function writeUnsafe(store: PresetReactionStore): Promise<void> {
  const temporary = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, STORE_FILE);
}

async function mutate<T>(operation: (store: PresetReactionStore) => T): Promise<T> {
  const promise = writeQueue.then(async () => {
    const store = await readUnsafe();
    const result = operation(store);
    await writeUnsafe(store);
    return result;
  });
  writeQueue = promise.then(() => undefined, () => undefined);
  return promise;
}

function summary(record: PresetReactionRecord | undefined, userId?: string): PresetReactionSummary {
  const likedBy = record?.likedBy || [];
  const favoritedBy = record?.favoritedBy || [];
  return {
    likes: likedBy.length,
    favorites: favoritedBy.length,
    liked: Boolean(userId && likedBy.includes(userId)),
    favorited: Boolean(userId && favoritedBy.includes(userId)),
  };
}

export async function getPresetReactionSummary(
  presetId: string,
  userId?: string,
): Promise<PresetReactionSummary> {
  await writeQueue;
  return summary((await readUnsafe()).presets[presetId], userId);
}

export async function getPresetReactionSummaries(
  presetIds: string[],
  userId?: string,
): Promise<Record<string, PresetReactionSummary>> {
  await writeQueue;
  const store = await readUnsafe();
  const result: Record<string, PresetReactionSummary> = {};
  for (const presetId of [...new Set(presetIds)].slice(0, 100)) {
    result[presetId] = summary(store.presets[presetId], userId);
  }
  return result;
}

export async function togglePresetReaction(
  userId: string,
  presetId: string,
  kind: PresetReactionKind,
): Promise<PresetReactionSummary> {
  return mutate((store) => {
    const record = store.presets[presetId] ??= { likedBy: [], favoritedBy: [] };
    const target = kind === "like" ? record.likedBy : record.favoritedBy;
    const index = target.indexOf(userId);
    if (index === -1) target.push(userId);
    else target.splice(index, 1);
    return summary(record, userId);
  });
}

export async function countAllPresetReactions(): Promise<{ likes: number; favorites: number }> {
  await writeQueue;
  const store = await readUnsafe();
  let likes = 0;
  let favorites = 0;
  for (const record of Object.values(store.presets)) {
    likes += record.likedBy.length;
    favorites += record.favoritedBy.length;
  }
  return { likes, favorites };
}
