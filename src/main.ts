import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import { startDiscordBot } from "./discord.js";
import { installRearrangeSecurity } from "./rearrangeSecurity.js";
import { startServer } from "./server.js";

await mkdir(config.imagesDir, { recursive: true });
installRearrangeSecurity();
const server = startServer();
const client = await startDiscordBot();

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
