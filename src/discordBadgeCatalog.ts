import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { NativeBadgeObservation } from "./types.js";

export interface DiscordBadgeCatalogEntry extends NativeBadgeObservation {
  kind: "bot" | "user";
}

interface CatalogFile {
  badges: DiscordBadgeCatalogEntry[];
}

const MAX_CATALOG_BADGES = 250;
const CATALOG_FILE = path.join(config.dataDir, "discord-badge-catalog.json");
let writeQueue: Promise<void> = Promise.resolve();

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isBotCatalogBadgeName(value: string): boolean {
  const name = normalizedName(value);
  return name === "uses automod"
    || name === "supports commands"
    || name === "supports application commands"
    || name === "supports slash commands"
    || name === "bot http interactions";
}

function normalizeEntry(value: unknown): DiscordBadgeCatalogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const badge = value as Partial<DiscordBadgeCatalogEntry>;
  const key = typeof badge.key === "string" ? badge.key.trim().toLowerCase() : "";
  const name = typeof badge.name === "string" ? badge.name.trim().slice(0, 100) : "";
  const image = typeof badge.image === "string" ? badge.image.trim().slice(0, 600) : "";
  const updatedAt = typeof badge.updatedAt === "string"
    ? badge.updatedAt
    : new Date().toISOString();

  if (!/^discord:[a-z0-9][a-z0-9._:-]{0,179}$/.test(key) || !name) {
    return undefined;
  }

  try {
    const url = new URL(image);
    if (url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }

  return {
    key,
    name,
    image,
    updatedAt,
    kind: isBotCatalogBadgeName(name) ? "bot" : "user",
  };
}

async function readUnsafe(): Promise<CatalogFile> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    const raw = JSON.parse(await readFile(CATALOG_FILE, "utf8")) as Partial<CatalogFile>;
    const badges = Array.isArray(raw.badges)
      ? raw.badges.map(normalizeEntry).filter((badge): badge is DiscordBadgeCatalogEntry => Boolean(badge))
      : [];
    return { badges: badges.slice(0, MAX_CATALOG_BADGES) };
  } catch {
    return { badges: [] };
  }
}

async function writeUnsafe(data: CatalogFile): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const temporary = `${CATALOG_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await rename(temporary, CATALOG_FILE);
}

export async function readDiscordBadgeCatalog(): Promise<DiscordBadgeCatalogEntry[]> {
  await writeQueue;
  return (await readUnsafe()).badges;
}

export async function recordDiscordBadgeCatalog(
  badges: Array<Pick<NativeBadgeObservation, "key" | "name" | "image" | "updatedAt">>,
): Promise<void> {
  const normalized = badges
    .map(normalizeEntry)
    .filter((badge): badge is DiscordBadgeCatalogEntry => Boolean(badge));
  if (normalized.length === 0) return;

  const operation = writeQueue.then(async () => {
    const current = await readUnsafe();
    const merged = new Map(current.badges.map((badge) => [badge.key, badge]));
    for (const badge of normalized) merged.set(badge.key, badge);

    const next = [...merged.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, MAX_CATALOG_BADGES);
    await writeUnsafe({ badges: next });
  });

  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
}
