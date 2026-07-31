(() => {
  "use strict";

  const API_URL = "https://jadges.onrender.com/badges.json";
  const REFRESH_INTERVAL = 60_000;

  let badgeData = {};
  let unpatch;
  let refreshTimer;

  async function refreshBadges() {
    try {
      const response = await vendetta.utils.safeFetch(API_URL, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();

      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw new TypeError("Invalid Jadges API response");
      }

      badgeData = json;
    } catch (error) {
      vendetta.logger.error("[JadgesBadges] Failed to refresh badges", error);
    }
  }

  function onLoad() {
    void refreshBadges();

    try {
      const profileBadges = vendetta.metro.findByName("useBadges", false);

      if (!profileBadges || typeof profileBadges.default !== "function") {
        vendetta.logger.error("[JadgesBadges] Discord's useBadges module was not found");
        return;
      }

      unpatch = vendetta.patcher.after(
        "default",
        profileBadges,
        ([user], originalBadges) => {
          const userId = user?.userId ?? user?.id;
          if (!userId) return originalBadges;

          const jadges = badgeData[userId];
          if (!Array.isArray(jadges) || jadges.length === 0) {
            return originalBadges;
          }

          const customBadges = jadges
            .filter(
              item =>
                item &&
                typeof item.badge === "string" &&
                item.badge.startsWith("https://")
            )
            .map((item, index) => ({
              id: `jadges-${userId}-${index}`,
              icon: item.badge,
              description: item.tooltip || item.name || "Jadges Badge"
            }));

          return [
            ...(Array.isArray(originalBadges) ? originalBadges : []),
            ...customBadges
          ];
        }
      );

      refreshTimer = setInterval(() => void refreshBadges(), REFRESH_INTERVAL);
      vendetta.logger.log("[JadgesBadges] Enabled");
    } catch (error) {
      vendetta.logger.error("[JadgesBadges] Failed to start", error);
    }
  }

  function onUnload() {
    unpatch?.();
    unpatch = undefined;

    clearInterval(refreshTimer);
    refreshTimer = undefined;
    badgeData = {};
  }

  return {
    onLoad,
    onUnload
  };
})()
