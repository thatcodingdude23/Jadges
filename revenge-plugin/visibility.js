(() => {
  "use strict";

  const VISIBILITY_URL = "https://jadges.onrender.com/visibility.json";
  const REFRESH_INTERVAL = 5_000;

  let visibilityData = {};
  let unpatch;
  let refreshTimer;

  function stringValues(badge) {
    if (!badge || typeof badge !== "object") return [];
    return [
      badge.id,
      badge.key,
      badge.name,
      badge.title,
      badge.description,
      badge.label,
      badge.link,
      badge.href,
      badge.icon,
      badge.iconSrc,
      badge.source?.uri,
      badge.iconSource?.uri,
      badge.imageSource?.uri
    ].filter(value => typeof value === "string" && value.length > 0);
  }

  function slug(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72);
  }

  function nativeBadgeKey(badge) {
    if (typeof badge?.__jadgesOrderKey === "string") {
      return badge.__jadgesOrderKey;
    }

    const values = stringValues(badge);
    const text = values.join(" ").toLowerCase();

    if (
      text.includes("server boosting") ||
      text.includes("guild-boosting") ||
      text.includes("premium guild subscriber") ||
      text.includes("51040c70d4f20a921ad6674ff86fc95c")
    ) return "discord:boosting";

    if (
      text.includes("subscriber since") ||
      text.includes("settings/premium") ||
      text.includes("discord nitro")
    ) return "discord:nitro";

    const image = values.find(value => /^https:\/\//i.test(value));
    const hash = image?.match(/(?:badge-icons|assets\/content)\/([a-z0-9_-]{8,})/i)?.[1];
    if (hash) return `discord:icon-${hash.toLowerCase()}`;

    const seed = values.find(value => value.trim().length > 0);
    const normalized = slug(seed);
    return normalized ? `discord:${normalized}` : undefined;
  }

  async function refreshVisibility() {
    try {
      const response = await vendetta.utils.safeFetch(VISIBILITY_URL, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      visibilityData = data && typeof data === "object" && !Array.isArray(data)
        ? data
        : {};
    } catch (error) {
      vendetta.logger.warn("[JadgesVisibility] Could not refresh hidden badges", error);
    }
  }

  function onLoad() {
    void refreshVisibility();

    try {
      const profileBadges = vendetta.metro.findByName("useBadges", false);
      if (!profileBadges || typeof profileBadges.default !== "function") {
        vendetta.logger.error("[JadgesVisibility] Discord's useBadges module was not found");
        return;
      }

      unpatch = vendetta.patcher.after(
        "default",
        profileBadges,
        ([user], badges) => {
          const userId = user?.userId ?? user?.id;
          if (!userId || !Array.isArray(badges)) return badges;

          const hidden = new Set(
            Array.isArray(visibilityData[userId]) ? visibilityData[userId] : []
          );
          if (hidden.size === 0) return badges;

          return badges.filter(badge => {
            const key = nativeBadgeKey(badge);
            return !key || !hidden.has(key);
          });
        }
      );

      refreshTimer = setInterval(() => void refreshVisibility(), REFRESH_INTERVAL);
      vendetta.logger.log("[JadgesVisibility] Hidden badge synchronization enabled");
    } catch (error) {
      vendetta.logger.error("[JadgesVisibility] Failed to start", error);
    }
  }

  function onUnload() {
    unpatch?.();
    unpatch = undefined;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    visibilityData = {};
  }

  return { onLoad, onUnload };
})()
