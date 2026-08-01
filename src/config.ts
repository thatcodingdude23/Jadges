import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function stableBadgeUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  try {
    const url = new URL(value);
    const isExpiringDiscordAttachment =
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net")
      && url.pathname.includes("/attachments/");

    return url.protocol === "https:" && !isExpiringDiscordAttachment
      ? url.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

const port = positiveNumber("PORT", 10000);
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "./data");
const publicUrl = (
  process.env.PUBLIC_URL?.trim() ||
  process.env.RENDER_EXTERNAL_URL?.trim() ||
  `http://localhost:${port}`
).replace(/\/$/, "");
const discordToken = required("DISCORD_TOKEN");
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET?.trim() || undefined;
const badgeAssetRoot =
  "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/assets";

export const config = {
  discordToken,
  discordClientSecret,
  clientId: required("CLIENT_ID"),
  guildId: process.env.GUILD_ID?.trim() || undefined,
  promptChannel: required("PROMPT_CHANNEL"),
  verifierRole: required("VERIFIER_ROLE"),
  publicUrl,
  webSessionSecret:
    process.env.WEB_SESSION_SECRET?.trim() || discordClientSecret || discordToken,
  jaycordStaffBadgeUrl: stableBadgeUrl(
    "JAYCORD_STAFF_BADGE_URL",
    `${badgeAssetRoot}/jaycord-staff.svg`,
  ),
  jaycordAdminBadgeUrl: stableBadgeUrl(
    "JAYCORD_ADMIN_BADGE_URL",
    `${badgeAssetRoot}/jaycord-admin.svg`,
  ),
  dataDir,
  imagesDir: path.join(dataDir, "badges"),
  storeFile: path.join(dataDir, "badges.json"),
  port,
  maxBadges: positiveNumber("MAX_BADGES", 5),
  extraBoostBadges: positiveNumber("EXTRA_BOOST_BADGES", 5),
  maxBadgeSize: positiveNumber("MAX_BADGE_SIZE", 5 * 1024 * 1024),
  blacklistedWords: (process.env.BLACKLISTED_WORDS || "")
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean),
};
