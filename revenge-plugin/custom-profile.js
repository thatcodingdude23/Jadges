(() => {
  "use strict";

  const PROFILE_URL = "https://jadges.onrender.com/custom-profiles.json";
  const CACHE_KEY = "jadges-approved-custom-profiles-v1";
  const REFRESH_INTERVAL = 1_000;
  let profiles = readCachedProfiles();
  let timer;
  let unpatchGetUser;
  const timestampUnpatches = [];

  function logger() {
    return vendetta?.logger ?? console;
  }

  function validObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeProfiles(value) {
    if (!validObject(value)) return {};
    const normalized = {};
    for (const [userId, raw] of Object.entries(value)) {
      if (!/^\d{15,22}$/.test(userId) || !validObject(raw)) continue;
      const username = typeof raw.username === "string" ? raw.username.trim() : undefined;
      const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : undefined;
      if (username || createdAt) normalized[userId] = { username, createdAt };
    }
    return normalized;
  }

  function readCachedProfiles() {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return {};
      return normalizeProfiles(JSON.parse(storage.getItem(CACHE_KEY) || "{}"));
    } catch {
      return {};
    }
  }

  function cacheProfiles(value) {
    try {
      globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
      // Some mobile clients disable synchronous storage. Live refresh still works.
    }
  }

  function customProfile(userId) {
    const profile = profiles[userId];
    return validObject(profile) ? profile : undefined;
  }

  function patchUserStore() {
    const store = vendetta.metro.findByProps("getUser", "getCurrentUser");
    if (!store || typeof store.getUser !== "function") {
      logger().warn("[JadgesCustomProfiles] UserStore was not found");
      return;
    }

    unpatchGetUser = vendetta.patcher.after("getUser", store, ([userId], user) => {
      if (!user || !userId) return user;
      const profile = customProfile(String(userId));
      const customName = typeof profile?.username === "string" ? profile.username.trim() : "";
      if (!customName) return user;

      return {
        ...user,
        username: customName,
        globalName: customName,
        global_name: customName,
        __jadgesOriginalUsername: user.__jadgesOriginalUsername || user.username,
        __jadgesOriginalGlobalName:
          user.__jadgesOriginalGlobalName || user.globalName || user.global_name || user.username
      };
    });
  }

  function patchTimestampMethod(module, method) {
    if (!module || typeof module[method] !== "function") return;
    const unpatch = vendetta.patcher.instead(method, module, (args, original) => {
      const snowflake = args?.[0];
      const profile = typeof snowflake === "string" ? customProfile(snowflake) : undefined;
      const customDate = typeof profile?.createdAt === "string"
        ? new Date(profile.createdAt).getTime()
        : NaN;
      if (Number.isFinite(customDate)) return customDate;
      return original(...args);
    });
    timestampUnpatches.push(unpatch);
  }

  function patchSnowflakeTimestamp() {
    const candidates = [
      vendetta.metro.findByProps("extractTimestamp", "fromTimestamp"),
      vendetta.metro.findByProps("timestampFromSnowflake"),
      vendetta.metro.findByProps("getTimestampFromSnowflake")
    ];

    for (const module of candidates) {
      if (!module) continue;
      patchTimestampMethod(module, "extractTimestamp");
      patchTimestampMethod(module, "timestampFromSnowflake");
      patchTimestampMethod(module, "getTimestampFromSnowflake");
    }
  }

  async function refresh() {
    try {
      const response = await vendetta.utils.safeFetch(`${PROFILE_URL}?t=${Date.now()}`, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      profiles = normalizeProfiles(await response.json());
      cacheProfiles(profiles);
    } catch (error) {
      logger().warn("[JadgesCustomProfiles] Could not refresh custom profiles", error);
    }
  }

  async function onLoad() {
    profiles = readCachedProfiles();
    patchUserStore();
    patchSnowflakeTimestamp();
    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_INTERVAL);
    logger().log("[JadgesCustomProfiles] Mobile custom names and dates now match Vencord");
  }

  function onUnload() {
    unpatchGetUser?.();
    unpatchGetUser = undefined;
    for (const unpatch of timestampUnpatches.splice(0)) {
      try { unpatch?.(); } catch {}
    }
    clearInterval(timer);
    timer = undefined;
    profiles = {};
  }

  return { onLoad, onUnload };
})()
