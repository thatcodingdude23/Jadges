import { mkdir } from "node:fs/promises";
import { installBrandIntegration } from "./brandIntegration.js";
import { config } from "./config.js";
import { startDiscordBot } from "./discord.js";
import { installRearrangeSecurity } from "./rearrangeSecurity.js";
import { startServer } from "./server.js";
import { startStatusPanel } from "./statusPanel.js";
import { installWebsiteIntegration } from "./websiteIntegration.js";

await mkdir(config.imagesDir, { recursive: true });
installBrandIntegration();
installWebsiteIntegration();
installRearrangeSecurity();
const server = startServer();
const client = await startDiscordBot();
const statusPanel = startStatusPanel(client);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  await statusPanel.stop(true);
  server.close();
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
