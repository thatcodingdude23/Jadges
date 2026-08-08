(() => {
  "use strict";

  const API_ROOT = "https://jadges.onrender.com";
  const BADGES_URL = `${API_ROOT}/badges.json`;
  const SETTINGS_URL = `${API_ROOT}/settings.json`;
  const REFRESH_INTERVAL = 5_000;
  const DISCORD_ID = /^\d{15,22}$/;

  let badgeData = {};
  let settingsData = {};
  let profileStoreUnpatch;
  let refreshTimer;
  const imageProps = Object.create(null);
  const jsxUnpatches = [];

  function logger() {
    return vendetta?.logger ?? console;
  }

  function validDiscordId(value) {
    return typeof value === "string" && DISCORD_ID.test(value)
      ? value
      : undefined;
  }

  function resolveUserId(value, depth = 0) {
    const direct = validDiscordId(value);
    if (direct) return direct;
    if (!value || typeof value !== "object" || depth > 3) return undefined;

    const explicit = validDiscordId(value.userId)
      || validDiscordId(value.user_id);
    if (explicit) return explicit;

    for (const key of ["user", "profile", "member", "account"]) {
      const nested = resolveUserId(value[key], depth + 1);
      if (nested) return nested;
    }

    return validDiscordId(value.id);
  }

  function resolveArgsUserId(args) {
    if (!Array.isArray(args)) return resolveUserId(args);
    for (const arg of args) {
      const userId = resolveUserId(arg);
      if (userId) return userId;
    }
    return undefined;
  }

  function registerImage(id, image, label, userId) {
    imageProps[id] = {
      id,
      icon: image,
      source: { uri: image },
      iconSource: { uri: image },
      imageSource: { uri: image },
      label,
      description: label,
      userId
    };
  }

  function applyRegisteredImage(_component, element) {
    const id = element?.props?.id
      || element?.props?.badge?.id
      || element?.props?.data?.id;
    const registered = imageProps[id];
    if (!registered || !element?.props) return element;

    Object.assign(element.props, registered);
    if (element.props.badge && typeof element.props.badge === "object") {
      Object.assign(element.props.badge, registered);
    }
    if (element.props.data && typeof element.props.data === "object") {
      Object.assign(element.props.data, registered);
    }
    return element;
  }

  function installImageHooks() {
    const jsxApi = globalThis.bunny?.api?.react?.jsx;
    if (
      typeof jsxApi?.onJsxCreate !== "function" ||
      typeof jsxApi?.deleteJsxCreate !== "function"
    ) {
      logger().warn("[JadgesProfileBadges] Revenge JSX API was not found");
      return;
    }

    const names = [
      "ProfileBadge",
      "RenderBadge",
      "UserProfileBadge",
      "Badge"
    ];

    for (const name of names) {
      try {
        jsxApi.onJsxCreate(name, applyRegisteredImage);
        jsxUnpatches.push(() => {
          try { jsxApi.deleteJsxCreate(name, applyRegisteredImage); } catch {}
        });
      } catch {}
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "2-digit"
    }).format(date);
  }

  function badgeText(badge) {
    if (!badge || typeof badge !== "object") return "";
    return [
      badge.id,
      badge.key,
      badge.name,
      badge.description,
      badge.label,
      badge.link,
      badge.icon,
      badge.iconSrc,
      badge.source?.uri,
      badge.iconSource?.uri,
      badge.imageSource?.uri
    ]
      .filter(value => typeof value === "string")
      .join(" ")
      .toLowerCase();
  }

  function isNitroBadge(badge) {
    const text = badgeText(badge);
    return text.includes("subscriber since")
      || text.includes("settings/premium")
      || text.includes("discord nitro");
  }

  function isBoostBadge(badge) {
    const text = badgeText(badge);
    return text.includes("server boosting")
      || text.includes("guild-boosting")
      || text.includes("premium guild subscriber")
      || text.includes("51040c70d4f20a921ad6674ff86fc95c");
  }

  function userSettings(userId, jadges) {
    const stored = settingsData[userId];
    const metadata = Array.isArray(jadges)
      ? jadges.find(item => item?.metadata === true)
      : undefined;

    const order = Array.isArray(stored?.order)
      ? stored.order
      : Array.isArray(metadata?.order)
        ? metadata.order
        : [];

    const side = stored?.side === "right"
      || (!stored?.side && metadata?.side === "right")
      || (!stored?.side && !metadata?.side && jadges?.some(item => item?.side === "right"))
        ? "right"
        : "left";

    return {
      side,
      order: order.filter(value => typeof value === "string")
    };
  }

  function makeBadge(userId, id, orderKey, image, label) {
    registerImage(id, image, label, userId);
    return {
      id,
      description: label,
      label,
      icon: image,
      source: { uri: image },
      iconSource: { uri: image },
      imageSource: { uri: image },
      __jadgesMobileProfile: true,
      __jadgesOrderKey: orderKey
    };
  }

  function syntheticBadges(userId, jadges) {
    const result = [];
    const nitroItem = jadges.find(item => item?.nitro && !item?.metadata);
    const nitro = nitroItem?.nitro;
    const hideNative = nitro?.hideNativeBadges === true || nitro?.key === "remove";

    jadges.forEach((item, index) => {
      if (!item || typeof item !== "object" || item.metadata) return;

      if (item.nitro) {
        if (hideNative) return;
        const image = typeof item.nitro.mobileIcon === "string"
          && item.nitro.mobileIcon.startsWith("https://")
            ? item.nitro.mobileIcon
            : item.nitro.profileIcon;
        if (typeof image !== "string" || !image.startsWith("https://")) return;

        result.push(makeBadge(
          userId,
          `jadges-profile-nitro-${userId}-${index}`,
          item.key || "nitro",
          image,
          `Subscriber since ${formatDate(item.nitro.subscriberSince)}`
        ));
        return;
      }

      if (typeof item.badge !== "string" || !item.badge.startsWith("https://")) return;
      result.push(makeBadge(
        userId,
        `jadges-profile-${userId}-${index}`,
        item.key || `custom:${index}`,
        item.badge,
        item.tooltip || item.name || "Jadges Badge"
      ));
    });

    return { badges: result, nitro, hideNative };
  }

  function combineBadges(userId, jadges, custom, native) {
    const settings = userSettings(userId, jadges);
    const rank = new Map(settings.order.map((key, index) => [key, index]));

    const entries = [
      ...custom.map((badge, index) => ({
        badge,
        key: badge.__jadgesOrderKey,
        jadges: true,
        index
      })),
      ...native.map((badge, index) => ({
        badge,
        key: undefined,
        jadges: false,
        index
      }))
    ];

    return entries
      .sort((left, right) => {
        if (left.key === "staff") return -1;
        if (right.key === "staff") return 1;

        const leftRank = left.key ? rank.get(left.key) : undefined;
        const rightRank = right.key ? rank.get(right.key) : undefined;
        if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
        if (leftRank !== undefined) return -1;
        if (rightRank !== undefined) return 1;

        if (left.jadges !== right.jadges) {
          if (settings.side === "left") return left.jadges ? -1 : 1;
          return left.jadges ? 1 : -1;
        }
        return left.index - right.index;
      })
      .map(entry => entry.badge);
  }

  function augmentProfile(args, profile) {
    if (!profile || typeof profile !== "object") return profile;

    const userId = resolveArgsUserId(args) || resolveUserId(profile);
    if (!userId) return profile;

    const jadges = Array.isArray(badgeData[userId]) ? badgeData[userId] : [];
    if (jadges.length === 0 && !settingsData[userId]) return profile;

    const { badges: custom, nitro, hideNative } = syntheticBadges(userId, jadges);
    const native = (Array.isArray(profile.badges) ? profile.badges : [])
      .filter(badge => !badge?.__jadgesMobileProfile)
      .filter(badge => !String(badge?.id || "").startsWith("jadges-profile-"))
      .filter(badge => {
        if (hideNative) return !isNitroBadge(badge) && !isBoostBadge(badge);
        return !nitro || !isNitroBadge(badge);
      });

    const badges = combineBadges(userId, jadges, custom, native);
    try {
      return { ...profile, badges };
    } catch {
      return profile;
    }
  }

  function findProfileStore() {
    try {
      const found = vendetta.metro.findByProps("getUserProfile");
      if (found?.default && typeof found.default.getUserProfile === "function") {
        return found.default;
      }
      if (found && typeof found.getUserProfile === "function") return found;
    } catch {}
    return undefined;
  }

  function notifyProfileStore() {
    const store = findProfileStore();
    try {
      if (typeof store?.emitChange === "function") store.emitChange();
    } catch {}
  }

  function installProfileStorePatch() {
    const store = findProfileStore();
    if (!store) {
      logger().warn("[JadgesProfileBadges] Discord's UserProfile store was not found");
      return false;
    }

    try {
      profileStoreUnpatch = vendetta.patcher.after(
        "getUserProfile",
        store,
        (args, profile) => augmentProfile(args, profile)
      );
      logger().log("[JadgesProfileBadges] Full mobile profile badge bridge enabled");
      return true;
    } catch (error) {
      logger().warn("[JadgesProfileBadges] Could not patch UserProfile store", error);
      return false;
    }
  }

  async function refresh() {
    try {
      const [badgesResponse, settingsResponse] = await Promise.all([
        vendetta.utils.safeFetch(BADGES_URL, { cache: "no-store" }),
        vendetta.utils.safeFetch(SETTINGS_URL, { cache: "no-store" })
      ]);

      if (!badgesResponse.ok) throw new Error(`Badges HTTP ${badgesResponse.status}`);
      const badges = await badgesResponse.json();
      if (badges && typeof badges === "object" && !Array.isArray(badges)) {
        badgeData = badges;
      }

      if (settingsResponse.ok) {
        const settings = await settingsResponse.json();
        if (settings && typeof settings === "object" && !Array.isArray(settings)) {
          settingsData = settings;
        }
      }

      notifyProfileStore();
    } catch (error) {
      logger().warn("[JadgesProfileBadges] Could not refresh Jadges profile badges", error);
    }
  }

  async function onLoad() {
    installImageHooks();
    installProfileStorePatch();
    await refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL);
  }

  function onUnload() {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    profileStoreUnpatch?.();
    profileStoreUnpatch = undefined;
    for (const unpatch of jsxUnpatches.splice(0).reverse()) {
      try { unpatch(); } catch {}
    }
    badgeData = {};
    settingsData = {};
    for (const id of Object.keys(imageProps)) delete imageProps[id];
    notifyProfileStore();
  }

  return { onLoad, onUnload };
})()
