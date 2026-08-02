import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getOrCreateUser, getUser, mutateStore } from "./store.js";
import type { BadgeRecord } from "./types.js";

export const MAX_PRESET_UPLOAD_SIZE = Math.min(config.maxBadgeSize, 5 * 1024 * 1024);
export const MAX_PRESET_NAME_LENGTH = 40;
export const PRESET_IMAGES_DIR = path.join(config.dataDir, "preset-images");

const PRESET_STORE_FILE = path.join(config.dataDir, "presets.json");
const MAX_UPLOADS_PER_HOUR = 6;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/apng": ".apng",
};

export interface PresetRecord {
  id: string;
  name: string;
  filename: string;
  mimeType: string;
  uploaderId: string;
  uploaderUsername: string;
  uploaderDisplayName: string;
  createdAt: string;
  claims: number;
}

export interface PresetUploader {
  id: string;
  username: string;
  displayName: string;
}

export interface PresetUploadPayload {
  name?: unknown;
  mimeType?: unknown;
  data?: unknown;
}

interface PresetStore {
  presets: PresetRecord[];
}

let writeQueue: Promise<void> = Promise.resolve();
const uploadAttempts = new Map<string, number[]>();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function ensureStore(): Promise<void> {
  await mkdir(PRESET_IMAGES_DIR, { recursive: true });
  try {
    await readFile(PRESET_STORE_FILE, "utf8");
  } catch {
    await writeFile(PRESET_STORE_FILE, JSON.stringify({ presets: [] }, null, 2), "utf8");
  }
}

function normalizeStore(value: unknown): PresetStore {
  if (!isObjectRecord(value) || !Array.isArray(value.presets)) return { presets: [] };

  const presets = value.presets
    .filter((item): item is PresetRecord =>
      isObjectRecord(item)
      && typeof item.id === "string"
      && typeof item.name === "string"
      && typeof item.filename === "string"
      && typeof item.mimeType === "string"
      && typeof item.uploaderId === "string"
      && typeof item.uploaderUsername === "string"
      && typeof item.uploaderDisplayName === "string"
      && typeof item.createdAt === "string"
    )
    .map((item) => ({
      ...item,
      claims: Number.isFinite(item.claims) && item.claims >= 0
        ? Math.floor(item.claims)
        : 0,
    }));

  return { presets };
}

async function readUnsafe(): Promise<PresetStore> {
  await ensureStore();
  const raw = await readFile(PRESET_STORE_FILE, "utf8");
  return normalizeStore(JSON.parse(raw) as unknown);
}

async function writeUnsafe(store: PresetStore): Promise<void> {
  const temporary = `${PRESET_STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, PRESET_STORE_FILE);
}

async function mutate<T>(
  mutation: (store: PresetStore) => T | Promise<T>,
): Promise<T> {
  const operation = writeQueue.then(async () => {
    const store = await readUnsafe();
    const result = await mutation(store);
    await writeUnsafe(store);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function listPresets(): Promise<PresetRecord[]> {
  await writeQueue;
  return (await readUnsafe()).presets;
}

export async function findPreset(id: string): Promise<PresetRecord | undefined> {
  return (await listPresets()).find((preset) => preset.id === id);
}

export function presetImageUrl(preset: PresetRecord): string {
  return `/preset-images/${encodeURIComponent(preset.filename)}`;
}

export function presetImagePath(filename: string): string {
  return path.join(PRESET_IMAGES_DIR, path.basename(filename));
}

export function presetImageContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png" || extension === ".apng") return "image/png";
  if (extension === ".jpg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/gif";
}

function normalizedMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.toLowerCase().split(";")[0]?.trim();
  return mime && MIME_EXTENSIONS[mime] ? mime : undefined;
}

function hasValidImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png" || mimeType === "image/apng") {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return false;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a badge name");
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a badge name");
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw new Error(`Badge names can contain up to ${MAX_PRESET_NAME_LENGTH} characters`);
  }
  return name;
}

function enforceUploadRateLimit(userId: string): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const recent = (uploadAttempts.get(userId) || []).filter((time) => time > cutoff);
  if (recent.length >= MAX_UPLOADS_PER_HOUR) {
    throw new Error("You have uploaded too many presets recently. Try again later.");
  }
  recent.push(now);
  uploadAttempts.set(userId, recent);
}

export async function createPreset(
  userId: string,
  uploader: PresetUploader,
  payload: PresetUploadPayload,
): Promise<PresetRecord> {
  const user = await getUser(userId);
  if (user.blocked) throw new Error("Your Jadges account is blocked from uploads");
  enforceUploadRateLimit(userId);

  const name = cleanName(payload.name);
  if (config.blacklistedWords.some((word: string) => name.toLowerCase().includes(word))) {
    throw new Error("That badge name is not allowed");
  }
  const mimeType = normalizedMimeType(payload.mimeType);
  if (!mimeType) throw new Error("Choose a supported image file");
  if (typeof payload.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) {
    throw new Error("The uploaded image is invalid");
  }

  const bytes = Buffer.from(payload.data, "base64");
  if (bytes.length === 0) throw new Error("The uploaded image is empty");
  if (bytes.length > MAX_PRESET_UPLOAD_SIZE) throw new Error("The uploaded image is too large");
  if (!hasValidImageSignature(bytes, mimeType)) {
    throw new Error("That file does not contain a valid image");
  }

  const extension = MIME_EXTENSIONS[mimeType];
  const filename = `${randomUUID()}${extension}`;
  await mkdir(PRESET_IMAGES_DIR, { recursive: true });
  await writeFile(presetImagePath(filename), bytes, { flag: "wx" });

  const preset: PresetRecord = {
    id: randomUUID(),
    name,
    filename,
    mimeType,
    uploaderId: userId,
    uploaderUsername: uploader.username,
    uploaderDisplayName: uploader.displayName,
    createdAt: new Date().toISOString(),
    claims: 0,
  };

  await mutate((store) => {
    store.presets.unshift(preset);
  });
  return preset;
}

export async function claimPreset(userId: string, preset: PresetRecord): Promise<boolean> {
  const badgeId = `preset-${preset.id}-${userId}`;
  const extension = MIME_EXTENSIONS[preset.mimeType];
  if (!extension) throw new Error("This preset uses an unsupported image type");

  const added = await mutateStore(async (data) => {
    const user = getOrCreateUser(data, userId);
    if (user.blocked) throw new Error("Your Jadges account is blocked");
    if (user.badges.some((badge) => badge.id === badgeId)) return false;

    await mkdir(config.imagesDir, { recursive: true });
    const filename = `${randomUUID()}${extension}`;
    await copyFile(
      presetImagePath(preset.filename),
      path.join(config.imagesDir, filename),
    );

    const now = new Date().toISOString();
    const badge: BadgeRecord = {
      id: badgeId,
      userId,
      name: preset.name,
      filename,
      mimeType: preset.mimeType,
      pending: false,
      createdAt: now,
      approvedAt: now,
    };
    user.badges.push(badge);
    if (user.badgeOrder) user.badgeOrder.push(`custom:${badge.id}`);
    return true;
  });

  if (added) {
    await mutate((store) => {
      const current = store.presets.find((item) => item.id === preset.id);
      if (current) current.claims += 1;
    });
  }
  return added;
}
