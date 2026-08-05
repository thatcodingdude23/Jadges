import { mkdir } from "node:fs/promises";
import { installAnalyticsIntegration } from "./analyticsIntegration.js";
import { startAnnouncementBadgeLeaderboard } from "./announcementBadgeLeaderboard.js";
import { installBadgeDeleteIntegration } from "./badgeDeleteIntegration.js";
import { installBadgeDeleteUserIdSupport } from "./badgeDeleteUserIdSupport.js";
import { installBadgeQuests } from "./badgeQuestsIntegration.js";
import { installBrandIntegration } from "./brandIntegration.js";
import { config } from "./config.js";
import { installCustomProfileIntegration } from "./customProfileIntegration.js";
import { installDesktopThemeIntegration } from "./desktopThemeIntegration.js";
import { startDiscordBot } from "./discord.js";
import { installFinalAssetIntegration } from "./finalAssetIntegration.js";
import { installHiddenDashboardIntegration } from "./hiddenDashboardIntegration.js";
import { installHiddenPublicBadgeIntegration } from "./hiddenPublicBadgeIntegration.js";
import { installMobileAppearanceIntegration } from "./mobileAppearanceIntegration.js";
import { installMobileDashboardIntegration } from "./mobileDashboardIntegration.js";
import { installNativeInventoryIntegration } from "./nativeInventoryIntegration.js";
import { installPartnerBadgeIntegration } from "./partnerBadgeIntegration.js";
import { installPresetMarketplaceIntegration } from "./presetIntegration.js";
import { installPresetModerationDiscord, installPresetModerationWebsite } from "./presetModerationIntegration.js";
import { installPresetOwnerDeleteIntegration } from "./presetOwnerDeleteIntegration.js";
import { startPresetReleaseAnnouncement } from "./presetReleaseAnnouncement.js";
import { installPreviewIntegration } from "./previewIntegration.js";
import { installProfileVisibilityReportIntegration } from "./profileVisibilityReportIntegration.js";
import { installQuestBadgeAssetIntegration } from "./questBadgeAssetIntegration.js";
import { installQuestWebsiteIntegration } from "./questWebsiteIntegration.js";
import { installRearrangeSecurity } from "./rearrangeSecurity.js";
import { startServer } from "./server.js";
import { startStatusPanel } from "./statusPanel.js";
import { startJadgesSupportBot } from "./supportBot.js";
import { installVencordUpdateDashboardIntegration } from "./vencordUpdateDashboardIntegration.js";
import { installVisibilityIntegration } from "./visibilityIntegration.js";
import { installWebsiteIntegration } from "./websiteIntegration.js";

await mkdir(config.imagesDir, { recursive: true });
installQuestBadgeAssetIntegration();
installAnalyticsIntegration();
installCustomProfileIntegration();
installFinalAssetIntegration();
installNativeInventoryIntegration();
installBadgeDeleteIntegration();
installHiddenDashboardIntegration();
installHiddenPublicBadgeIntegration();
installPartnerBadgeIntegration();
installVisibilityIntegration();
installProfileVisibilityReportIntegration();
installDesktopThemeIntegration();
installPreviewIntegration();
installBrandIntegration();
// Install these before the website wrapper so they can transform or intercept website pages.
installMobileAppearanceIntegration();
installMobileDashboardIntegration();
installQuestWebsiteIntegration();
installWebsiteIntegration();
// Install moderation first so its request wrapper is outermost and can intercept
// preset uploads before the marketplace publishes them. Owner deletion is placed
// between moderation and marketplace so it can secure preset detail/delete routes.
installPresetModerationWebsite();
installPresetOwnerDeleteIntegration();
installPresetMarketplaceIntegration();
installRearrangeSecurity();
// Keep this last so its dashboard transform sees the final HTML produced by every wrapper.
installVencordUpdateDashboardIntegration();
const server = startServer();
const client = await startDiscordBot();
const badgeQuests = await installBadgeQuests(client);
const supportBot = await startJadgesSupportBot();
await installBadgeDeleteUserIdSupport(client);
installPresetModerationDiscord(client);
const presetReleaseAnnouncement = startPresetReleaseAnnouncement(client);
const statusPanel = startStatusPanel(client);
const badgeLeaderboard = startAnnouncementBadgeLeaderboard(client);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  badgeQuests.stop();
  supportBot.stop();
  presetReleaseAnnouncement.stop();
  badgeLeaderboard.stop();
  await statusPanel.stop(true);
  server.close();
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
