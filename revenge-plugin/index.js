(() => {
  "use strict";

  const API_URL = "https://jadges.onrender.com/badges.json";
  const REFRESH_INTERVAL = 5_000;

  let badgeData = {};
  let unpatch;
  let refreshTimer;
  const badgeProps = Object.create(null);
  const jsxUnpatches = [];

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "2-digit"
    }).format(date);
  }

  function getNitroPreset(jadges) {
    if (!Array.isArray(jadges)) return undefined;
    return jadges.find(item => item?.nitro)?.nitro;
  }

  function getBadgeSide(jadges) {
    return Array.isArray(jadges) && jadges.some(item => item?.side === "right")
      ? "right"
      : "left";
  }

  function badgeText(badge) {
    if (!badge || typeof badge !== "object") return "";
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
      badge.iconSrc
    ]
      .filter(value => typeof value === "string")
      .join(" ")
      .toLowerCase();
  }

  function isNitroBadge(badge) {
    const text = badgeText(badge);
    return (
      text.includes("subscriber") ||
      text.includes("settings/premium") ||
      text.includes("nitro")
    );
  }

  function isServerBoostBadge(badge) {
    const text = badgeText(badge);
    return (
      text.includes("server boosting") ||
      text.includes("guild-boosting") ||
      text.includes("premium guild subscriber") ||
      text.includes("51040c70d4f20a921ad6674ff86fc95c")
    );
  }

  function registerImage(id, image, label, userId, extra = {}) {
    badgeProps[id] = {
      id,
      icon: image,
      source: { uri: image },
      iconSource: { uri: image },
      imageSource: { uri: image },
      label,
      userId,
      ...extra
    };
  }

  async function refreshBadges() {
    try {
      const response = await vendetta.utils.safeFetch(API_URL, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw new TypeError("Invalid Jadges API response");
      }
      badgeData = json;
    } catch (error) {
      vendetta.logger.error("[JadgesBadges] Failed to refresh badges", error);
    }
  }

  function applyRegisteredProps(_component, element) {
    const id = element?.props?.id;
    const props = badgeProps[id];
    if (props && element?.props) Object.assign(element.props, props);
    return element;
  }

  function installImageHooks() {
    const jsxApi = globalThis.bunny?.api?.react?.jsx;
    if (
      typeof jsxApi?.onJsxCreate !== "function" ||
      typeof jsxApi?.deleteJsxCreate !== "function"
    ) {
      vendetta.logger.warn("[JadgesBadges] Revenge JSX API was not found");
      return;
    }

    jsxApi.onJsxCreate("ProfileBadge", applyRegisteredProps);
    jsxApi.onJsxCreate("RenderBadge", applyRegisteredProps);
    jsxUnpatches.push(
      () => jsxApi.deleteJsxCreate("ProfileBadge", applyRegisteredProps),
      () => jsxApi.deleteJsxCreate("RenderBadge", applyRegisteredProps)
    );
  }

  function makeImageBadge(id, image, label, userId, extra = {}) {
    registerImage(id, image, label, userId, extra);
    return {
      id,
      description: label,
      icon: image,
      source: { uri: image }
    };
  }

  function onLoad() {
    installImageHooks();
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
          if (!Array.isArray(jadges) || jadges.length === 0) return originalBadges;

          const nitro = getNitroPreset(jadges);
          const hideNativeBadges =
            nitro?.hideNativeBadges === true || nitro?.key === "remove";
          const syntheticBadges = [];

          jadges.forEach((item, index) => {
            if (!item || typeof item !== "object") return;

            if (item.nitro) {
              if (hideNativeBadges) return;
              const mobileIcon =
                typeof item.nitro.mobileIcon === "string" &&
                item.nitro.mobileIcon.startsWith("https://")
                  ? item.nitro.mobileIcon
                  : item.nitro.profileIcon;
              if (typeof mobileIcon !== "string" || !mobileIcon.startsWith("https://")) return;

              const id = `jadges-nitro-${userId}-${index}`;
              const label = `Subscriber since ${formatDate(item.nitro.subscriberSince)}`;
              syntheticBadges.push(
                makeImageBadge(id, mobileIcon, label, userId, {
                  nitro: item.nitro,
                  originalProfileIcon: item.nitro.profileIcon
                })
              );
              return;
            }

            if (typeof item.badge !== "string" || !item.badge.startsWith("https://")) return;
            const id = `jadges-${userId}-${index}`;
            const label = item.tooltip || item.name || "Jadges Badge";
            syntheticBadges.push(
              makeImageBadge(id, item.badge, label, userId, {
                createdAt: item.createdAt,
                apiKey: item.key
              })
            );
          });

          const discordBadges = (Array.isArray(originalBadges) ? originalBadges : [])
            .filter(badge => {
              if (hideNativeBadges) {
                return !isNitroBadge(badge) && !isServerBoostBadge(badge);
              }
              return !nitro || !isNitroBadge(badge);
            });

          return getBadgeSide(jadges) === "right"
            ? [...discordBadges, ...syntheticBadges]
            : [...syntheticBadges, ...discordBadges];
        }
      );

      refreshTimer = setInterval(() => void refreshBadges(), REFRESH_INTERVAL);
      vendetta.logger.log("[JadgesBadges] Enabled with badge ordering and placement");
    } catch (error) {
      vendetta.logger.error("[JadgesBadges] Failed to start", error);
    }
  }

  function onUnload() {
    unpatch?.();
    unpatch = undefined;
    for (const removeHook of jsxUnpatches.splice(0)) {
      try { removeHook(); } catch {}
    }
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    badgeData = {};
    for (const id of Object.keys(badgeProps)) delete badgeProps[id];
  }

  return { onLoad, onUnload };
})()
