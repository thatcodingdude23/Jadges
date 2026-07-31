(() => {
  "use strict";

  const API_URL = "https://jadges.onrender.com/badges.json";
  const REFRESH_INTERVAL = 60_000;

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

  function isNitroBadge(badge) {
    if (!badge || typeof badge !== "object") return false;

    const text = [
      badge.id,
      badge.key,
      badge.name,
      badge.title,
      badge.description,
      badge.label,
      badge.link,
      badge.href
    ]
      .filter(value => typeof value === "string")
      .join(" ")
      .toLowerCase();

    return (
      text.includes("subscriber") ||
      text.includes("settings/premium") ||
      text.includes("nitro")
    );
  }

  function registerImage(id, image, label, userId, extra = {}) {
    badgeProps[id] = {
      id,
      source: { uri: image },
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

  function profileBadgeCallback(_component, element) {
    const id = element?.props?.id;
    const props = badgeProps[id];

    if (props && element?.props) {
      element.props.source = props.source;
      element.props.label = props.label;
      element.props.id = props.id;
    }

    return element;
  }

  function renderBadgeCallback(_component, element) {
    const id = element?.props?.id;
    const props = badgeProps[id];

    if (props && element?.props) {
      Object.assign(element.props, props);
    }

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

    jsxApi.onJsxCreate("ProfileBadge", profileBadgeCallback);
    jsxApi.onJsxCreate("RenderBadge", renderBadgeCallback);

    jsxUnpatches.push(
      () => jsxApi.deleteJsxCreate("ProfileBadge", profileBadgeCallback),
      () => jsxApi.deleteJsxCreate("RenderBadge", renderBadgeCallback)
    );
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
            .map((item, index) => {
              const id = `jadges-${userId}-${index}`;
              const label = item.tooltip || item.name || "Jadges Badge";

              registerImage(id, item.badge, label, userId, {
                createdAt: item.createdAt
              });

              return {
                id,
                description: label,
                icon: " _"
              };
            });

          const nitro = getNitroPreset(jadges);
          let nitroBadge;

          if (
            nitro &&
            typeof nitro.profileIcon === "string" &&
            nitro.profileIcon.startsWith("https://")
          ) {
            const id = `jadges-nitro-${userId}`;
            const label = `Subscriber since ${formatDate(nitro.subscriberSince)}`;

            registerImage(id, nitro.profileIcon, label, userId, { nitro });

            nitroBadge = {
              id,
              description: label,
              icon: " _"
            };
          }

          const discordBadges = (Array.isArray(originalBadges) ? originalBadges : [])
            .filter(badge => !nitroBadge || !isNitroBadge(badge));

          return [
            ...customBadges,
            ...(nitroBadge ? [nitroBadge] : []),
            ...discordBadges
          ];
        }
      );

      refreshTimer = setInterval(() => void refreshBadges(), REFRESH_INTERVAL);
      vendetta.logger.log("[JadgesBadges] Enabled with Vencord-style badge rendering");
    } catch (error) {
      vendetta.logger.error("[JadgesBadges] Failed to start", error);
    }
  }

  function onUnload() {
    unpatch?.();
    unpatch = undefined;

    for (const removeHook of jsxUnpatches.splice(0)) {
      try {
        removeHook();
      } catch {}
    }

    clearInterval(refreshTimer);
    refreshTimer = undefined;
    badgeData = {};

    for (const id of Object.keys(badgeProps)) {
      delete badgeProps[id];
    }
  }

  return {
    onLoad,
    onUnload
  };
})()
