import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

interface AnalyticsData {
  badgeViews: Record<string, number>;
  presetViews: Record<string, number>;
}

const analyticsFile = path.join(config.dataDir, "analytics.json");
let writeQueue: Promise<void> = Promise.resolve();

function emptyData(): AnalyticsData {
  return { badgeViews: {}, presetViews: {} };
}

function cleanCounterMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof key !== "string" || !Number.isFinite(count) || Number(count) < 0) continue;
    result[key] = Math.floor(Number(count));
  }
  return result;
}

function normalize(value: unknown): AnalyticsData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyData();
  const source = value as Record<string, unknown>;
  return {
    badgeViews: cleanCounterMap(source.badgeViews),
    presetViews: cleanCounterMap(source.presetViews),
  };
}

async function ensureFile(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    await readFile(analyticsFile, "utf8");
  } catch {
    await writeFile(analyticsFile, JSON.stringify(emptyData(), null, 2), "utf8");
  }
}

async function readUnsafe(): Promise<AnalyticsData> {
  await ensureFile();
  return normalize(JSON.parse(await readFile(analyticsFile, "utf8")) as unknown);
}

async function writeUnsafe(data: AnalyticsData): Promise<void> {
  const temporary = `${analyticsFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await rename(temporary, analyticsFile);
}

async function increment(kind: keyof AnalyticsData, key: string): Promise<void> {
  const operation = writeQueue.then(async () => {
    const data = await readUnsafe();
    data[kind][key] = (data[kind][key] || 0) + 1;
    await writeUnsafe(data);
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

export function incrementBadgeView(filename: string): Promise<void> {
  return increment("badgeViews", path.basename(filename));
}

export function incrementPresetView(presetId: string): Promise<void> {
  return increment("presetViews", presetId);
}

export async function readAnalytics(): Promise<AnalyticsData> {
  await writeQueue;
  return readUnsafe();
}
