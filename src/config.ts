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
const discordToken = required("DISCORD_TOKEN");
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET?.trim() || undefined;

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
  jaycordStaffBadgeUrl:
    process.env.JAYCORD_STAFF_BADGE_URL?.trim() ||
    "https://media.discordapp.net/attachments/1532712764450013296/1532721284692180992/5e74e9b61934fc1f67c65515d1f7e60d.png?ex=6a6de16e&is=6a6c8fee&hm=80946d307868795e63e3a2432ea80a42e1ed24f994b56569fb9a4032b115a4df&=&format=webp&quality=lossless",
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
