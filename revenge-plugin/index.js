(() => {
  "use strict";

  const API_URL = "https://jadges.onrender.com/badges.json";
  const API_ROOT = API_URL.replace(/\/badges\.json(?:\?.*)?$/, "");
  const REFRESH_INTERVAL = 5_000;
  const NATIVE_REPORT_INTERVAL = 60_000;
  const QUEST_BADGE_KEY = "custom:quest:completed-any";
  const QUEST_MOBILE_NAME = "Jadges Completed a Quest";
  const DISCORD_ID = /^\d{15,22}$/;

  let badgeData = {};
  let settingsData = {};
  let unpatch;
  let refreshTimer;
  const badgeProps = Object.create(null);
  const jsxUnpatches = [];
  const reportedNative = new Map();

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "2-digit"
    }).format(date);
  }

  let userStore;

  function validDiscordId(value) {
    return typeof value === "string" && DISCORD_ID.test(value)
      ? value
      : undefined;
  }

  function resolveUserId(value, depth = 0) {
    const direct = validDiscordId(value);
    if (direct) return direct;
    if (!value || typeof value !== "object" || depth > 3) return undefined;

    const explicit = validDiscordId(value.userId) || validDiscordId(value.user_id);
    if (explicit) return explicit;

    for (const key of ["user", "profile", "member", "account"]) {
      const nested = resolveUserId(value[key], depth + 1);
      if (nested) return nested;
    }

    return validDiscordId(value.id);
  }

  function getUserStore() {
    if (userStore) return userStore;
    try {
      const found = vendetta.metro.findByProps("getCurrentUser", "getUser");
      userStore = found?.default && typeof found.default.getCurrentUser === "function"
        ? found.default
        : found;
    } catch {}
    return userStore;
  }

  function currentUserId() {
    try {
      return validDiscordId(getUserStore()?.getCurrentUser?.()?.id);
    } catch {
      return undefined;
    }
  }

  function resolveBadgeUserId(args) {
    if (!Array.isArray(args)) return resolveUserId(args);

    const first = resolveUserId(args[0]);
    if (first) return first;

    for (const arg of args.slice(1)) {
      if (!arg || typeof arg !== "object") continue;
      const explicit = validDiscordId(arg.userId)
        || validDiscordId(arg.user_id)
        || resolveUserId(arg.user);
      if (explicit) return explicit;
    }

    // Some Revenge builds call the self-profile badge hook without an explicit user.
    if (args.length === 0 || args[0] == null) return currentUserId();
    return undefined;
  }

  function notifyBadgeUi() {
    const candidates = [];
    try { candidates.push(getUserStore()); } catch {}
    try { candidates.push(vendetta.metro.findByProps("getUserProfile", "getGuildMemberProfile")); } catch {}

    for (const found of candidates) {
      const store = found?.default && typeof found.default.emitChange === "function"
        ? found.default
        : found;
      try {
        if (typeof store?.emitChange === "function") store.emitChange();
      } catch {}
    }
  }

  function getSettings(userId, jadges) {
    const stored = settingsData[userId];
    const metadata = Array.isArray(jadges)
      ? jadges.find(item => item?.metadata === true)
      : undefined;
    const order = Array.isArray(stored?.order)
      ? stored.order
      : Array.isArray(metadata?.order)
        ? metadata.order
        : [];
    const nativeBadges = Array.isArray(stored?.nativeBadges)
      ? stored.nativeBadges
      : Array.isArray(metadata?.nativeBadges)
        ? metadata.nativeBadges
        : [];

    return {
      side:
        stored?.side === "right" ||
        (!stored?.side && metadata?.side === "right") ||
        (!stored?.side && !metadata?.side && jadges?.some(item => item?.side === "right"))
          ? "right"
          : "left",
      order: order.filter(value => typeof value === "string"),
      nativeBadges
    };
  }

  function getNitroPreset(jadges) {
    if (!Array.isArray(jadges)) return undefined;
    return jadges.find(item => item?.nitro)?.nitro;
  }

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

  function badgeText(badge) {
    return stringValues(badge).join(" ").toLowerCase();
  }

  function isNitroBadge(badge) {
    const text = badgeText(badge);
    return (
      text.includes("subscriber since") ||
      text.includes("settings/premium") ||
      text.includes("discord nitro")
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

  function slug(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72);
  }

  function nativeBadgeKey(badge) {
    const values = stringValues(badge);
    const text = values.join(" ").toLowerCase();

    if (isServerBoostBadge(badge)) return "discord:boosting";
    if (isNitroBadge(badge)) return "discord:nitro";

    const image = values.find(value => /^https:\/\//i.test(value));
    const hash = image?.match(/(?:badge-icons|assets\/content)\/([a-z0-9_-]{8,})/i)?.[1];
    if (hash) return `discord:icon-${hash.toLowerCase()}`;

    const seed = values.find(value => value.trim().length > 0);
    const normalized = slug(seed);
    return normalized ? `discord:${normalized}` : undefined;
  }

  function nativeBadgeImage(badge) {
    return stringValues(badge).find(value => /^https:\/\//i.test(value));
  }

  function nativeBadgeName(badge) {
    const values = stringValues(badge);
    const preferred = values.find(value =>
      !/^https:\/\//i.test(value) &&
      !value.startsWith("/") &&
      value.trim().length > 0
    );
    return String(preferred || "Discord Badge").trim().slice(0, 100);
  }

  async function reportNativeBadges(userId, originalBadges) {
    const unique = new Map();

    for (const badge of Array.isArray(originalBadges) ? originalBadges : []) {
      const key = nativeBadgeKey(badge);
      const image = nativeBadgeImage(badge);
      if (!key || !image || unique.has(key)) continue;
      unique.set(key, {
        key,
        name: nativeBadgeName(badge),
        image
      });
    }

    const badges = [...unique.values()].slice(0, 25);
    const signature = JSON.stringify(badges);
    const previous = reportedNative.get(userId);
    const now = Date.now();

    if (
      previous &&
      previous.signature === signature &&
      now - previous.reportedAt < NATIVE_REPORT_INTERVAL
    ) {
      return;
    }

    reportedNative.set(userId, { signature, reportedAt: now });

    try {
      await vendetta.utils.safeFetch(`${API_ROOT}/api/native-badges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, badges })
      });
    } catch (error) {
      vendetta.logger.warn("[JadgesBadges] Could not report native badges", error);
    }
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
      const [badgeResponse, settingsResponse] = await Promise.all([
        vendetta.utils.safeFetch(API_URL, { cache: "no-store" }),
        vendetta.utils.safeFetch(`${API_ROOT}/settings.json`, { cache: "no-store" })
      ]);

      if (!badgeResponse.ok) throw new Error(`HTTP ${badgeResponse.status}`);
      const json = await badgeResponse.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw new TypeError("Invalid Jadges API response");
      }
      badgeData = json;

      if (settingsResponse.ok) {
        const settings = await settingsResponse.json();
        if (settings && typeof settings === "object" && !Array.isArray(settings)) {
          settingsData = settings;
        }
      }
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

  function makeImageBadge(id, orderKey, image, label, userId, extra = {}) {
    registerImage(id, image, label, userId, {
      orderKey,
      ...extra
    });
    return {
      id,
      description: label,
      icon: image,
      source: { uri: image },
      __jadgesOrderKey: orderKey
    };
  }

  function orderedCombinedBadges(userId, jadges, syntheticBadges, discordBadges) {
    const settings = getSettings(userId, jadges);
    const rank = new Map(settings.order.map((key, index) => [key, index]));

    const entries = [
      ...syntheticBadges.map((badge, index) => ({
        badge,
        key: badge.__jadgesOrderKey,
        isJadges: true,
        index
      })),
      ...discordBadges.map((badge, index) => ({
        badge,
        key: nativeBadgeKey(badge),
        isJadges: false,
        index
      }))
    ];

    const score = entry => {
      if (entry.key === "staff") return -100000;
      const explicit = entry.key ? rank.get(entry.key) : undefined;
      if (explicit !== undefined) return explicit;
      const group = settings.side === "left"
        ? (entry.isJadges ? 0 : 1)
        : (entry.isJadges ? 1 : 0);
      return 100000 + group * 10000 + entry.index;
    };

    return entries
      .sort((left, right) => score(left) - score(right))
      .map(entry => entry.badge);
  }

  async function onLoad() {
    installImageHooks();

    // Install the Discord hook immediately. Self-profile components can mount
    // before the Jadges API request completes on slower mobile connections.
    const initialRefresh = refreshBadges();

    try {
      let profileBadges = vendetta.metro.findByName("useBadges", false);
      let badgeMethod = "default";

      if (!profileBadges || typeof profileBadges.default !== "function") {
        const byProps = vendetta.metro.findByProps("useBadges");
        if (byProps && typeof byProps.useBadges === "function") {
          profileBadges = byProps;
          badgeMethod = "useBadges";
        }
      }

      if (!profileBadges || typeof profileBadges[badgeMethod] !== "function") {
        vendetta.logger.error("[JadgesBadges] Discord's useBadges module was not found");
        await initialRefresh;
        return;
      }

      unpatch = vendetta.patcher.after(
        badgeMethod,
        profileBadges,
        (args, originalBadges) => {
          const userId = resolveBadgeUserId(args);
          if (!userId) return originalBadges;

          void reportNativeBadges(userId, originalBadges);

          const jadges = Array.isArray(badgeData[userId])
            ? badgeData[userId]
            : [];
          const hasSettings = Boolean(settingsData[userId]);
          if (jadges.length === 0 && !hasSettings) return originalBadges;

          const nitro = getNitroPreset(jadges);
          const hideNativeBadges =
            nitro?.hideNativeBadges === true || nitro?.key === "remove";
          const syntheticBadges = [];

          jadges.forEach((item, index) => {
            if (!item || typeof item !== "object" || item.metadata) return;

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
                makeImageBadge(
                  id,
                  item.key || "nitro",
                  mobileIcon,
                  label,
                  userId,
                  {
                    nitro: item.nitro,
                    originalProfileIcon: item.nitro.profileIcon
                  }
                )
              );
              return;
            }

            if (typeof item.badge !== "string" || !item.badge.startsWith("https://")) return;
            const id = `jadges-${userId}-${index}`;
            const label = item.key === QUEST_BADGE_KEY
              ? QUEST_MOBILE_NAME
              : item.tooltip || item.name || "Jadges Badge";
            syntheticBadges.push(
              makeImageBadge(
                id,
                item.key || `custom:${index}`,
                item.badge,
                label,
                userId,
                { createdAt: item.createdAt }
              )
            );
          });

          const discordBadges = (Array.isArray(originalBadges) ? originalBadges : [])
            .filter(badge => {
              if (hideNativeBadges) {
                return !isNitroBadge(badge) && !isServerBoostBadge(badge);
              }
              return !nitro || !isNitroBadge(badge);
            });

          return orderedCombinedBadges(userId, jadges, syntheticBadges, discordBadges);
        }
      );

      await initialRefresh;
      notifyBadgeUi();
      refreshTimer = setInterval(async () => {
        await refreshBadges();
        notifyBadgeUi();
      }, REFRESH_INTERVAL);
      vendetta.logger.log("[JadgesBadges] Enabled with mobile self-profile compatibility");
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
    settingsData = {};
    reportedNative.clear();
    for (const id of Object.keys(badgeProps)) delete badgeProps[id];
  }

  return { onLoad, onUnload };
})()
