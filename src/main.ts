import { mkdir } from "node:fs/promises";
import { startAnnouncementBadgeLeaderboard } from "./announcementBadgeLeaderboard.js";
import { installBadgeDeleteIntegration } from "./badgeDeleteIntegration.js";
import { installBrandIntegration } from "./brandIntegration.js";
import { config } from "./config.js";
import { installDesktopThemeIntegration } from "./desktopThemeIntegration.js";
import { startDiscordBot } from "./discord.js";
import { installFinalAssetIntegration } from "./finalAssetIntegration.js";
import { installHiddenDashboardIntegration } from "./hiddenDashboardIntegration.js";
import { installNativeInventoryIntegration } from "./nativeInventoryIntegration.js";
import { installPreviewIntegration } from "./previewIntegration.js";
import { installProfileVisibilityReportIntegration } from "./profileVisibilityReportIntegration.js";
import { installRearrangeSecurity } from "./rearrangeSecurity.js";
import { startServer } from "./server.js";
import { startStatusPanel } from "./statusPanel.js";
import { installVisibilityIntegration } from "./visibilityIntegration.js";
import { installWebsiteIntegration } from "./websiteIntegration.js";

await mkdir(config.imagesDir, { recursive: true });
installFinalAssetIntegration();
installNativeInventoryIntegration();
installBadgeDeleteIntegration();
installHiddenDashboardIntegration();
installVisibilityIntegration();
installProfileVisibilityReportIntegration();
installDesktopThemeIntegration();
installPreviewIntegration();
installBrandIntegration();
installWebsiteIntegration();
installRearrangeSecurity();
const server = startServer();
const client = await startDiscordBot();
const statusPanel = startStatusPanel(client);
const badgeLeaderboard = startAnnouncementBadgeLeaderboard(client);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  badgeLeaderboard.stop();
  await statusPanel.stop(true);
  server.close();
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
