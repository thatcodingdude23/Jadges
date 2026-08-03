import { mkdir } from "node:fs/promises";
import { startAnnouncementBadgeLeaderboard } from "./announcementBadgeLeaderboard.js";
import { installBadgeDeleteIntegration } from "./badgeDeleteIntegration.js";
import { installBadgeDeleteUserIdSupport } from "./badgeDeleteUserIdSupport.js";
import { installBrandIntegration } from "./brandIntegration.js";
import { config } from "./config.js";
import { installDesktopThemeIntegration } from "./desktopThemeIntegration.js";
import { startDiscordBot } from "./discord.js";
import { installFinalAssetIntegration } from "./finalAssetIntegration.js";
import { installHiddenDashboardIntegration } from "./hiddenDashboardIntegration.js";
import { installNativeInventoryIntegration } from "./nativeInventoryIntegration.js";
import { installPartnerBadgeIntegration } from "./partnerBadgeIntegration.js";
import { installPresetMarketplaceIntegration } from "./presetIntegration.js";
import { installPresetModerationDiscord, installPresetModerationWebsite } from "./presetModerationIntegration.js";
import { installPresetOwnerDeleteIntegration } from "./presetOwnerDeleteIntegration.js";
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
installPartnerBadgeIntegration();
installVisibilityIntegration();
installProfileVisibilityReportIntegration();
installDesktopThemeIntegration();
installPreviewIntegration();
installBrandIntegration();
installWebsiteIntegration();
// Install moderation first so its request wrapper is outermost and can intercept
// preset uploads before the marketplace publishes them. Owner deletion is placed
// between moderation and marketplace so it can secure preset detail/delete routes.
installPresetModerationWebsite();
installPresetOwnerDeleteIntegration();
installPresetMarketplaceIntegration();
installRearrangeSecurity();
const server = startServer();
const client = await startDiscordBot();
await installBadgeDeleteUserIdSupport(client);
installPresetModerationDiscord(client);
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
