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

const port = positiveNumber("PORT", 10000);
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "./data");
const publicUrl = (
  process.env.PUBLIC_URL?.trim() ||
  process.env.RENDER_EXTERNAL_URL?.trim() ||
  `http://localhost:${port}`
).replace(/\/$/, "");

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  clientId: required("CLIENT_ID"),
  guildId: process.env.GUILD_ID?.trim() || undefined,
  promptChannel: required("PROMPT_CHANNEL"),
  verifierRole: required("VERIFIER_ROLE"),
  publicUrl,
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
