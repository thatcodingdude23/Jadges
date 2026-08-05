import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const mimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/apng": ".apng",
};

export function isSupportedImage(contentType: string | null | undefined): boolean {
  return Boolean(contentType && mimeExtensions[contentType]);
}

export async function saveDiscordAttachment(
  url: string,
  declaredContentType: string,
): Promise<{ filename: string; mimeType: string }> {
  if (!isSupportedImage(declaredContentType)) {
    throw new Error("Unsupported image type");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download image (${response.status})`);
  }

  const returnedType = response.headers.get("content-type")?.split(";")[0] || "";
  const mimeType = isSupportedImage(returnedType)
    ? returnedType
    : declaredContentType;
  const extension = mimeExtensions[mimeType];
  if (!extension) throw new Error("Unsupported image type");

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > config.maxBadgeSize) {
    throw new Error("Downloaded image is larger than the configured limit");
  }

  await mkdir(config.imagesDir, { recursive: true });
  const filename = `${randomUUID()}${extension}`;
  await writeFile(path.join(config.imagesDir, filename), bytes, { flag: "wx" });
  return { filename, mimeType };
}

export async function deleteStoredImage(filename: string): Promise<void> {
  await rm(path.join(config.imagesDir, path.basename(filename)), { force: true });
}

export function publicImageUrl(filename: string, origin = config.publicUrl): string {
  return `${origin.replace(/\/$/, "")}/badges/${encodeURIComponent(filename)}`;
}
