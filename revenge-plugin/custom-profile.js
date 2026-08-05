(() => {
  "use strict";

  const API_URL = "https://jadges.onrender.com/custom-profiles.json";
  const REFRESH_INTERVAL = 750;
  let profiles = {};
  let timer;
  let unpatchGetUser;
  const timestampUnpatches = [];

  function logger() {
    return vendetta?.logger ?? console;
  }

  function validProfile(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function customProfile(userId) {
    const profile = profiles[userId];
    return validProfile(profile) ? profile : undefined;
  }

  function displayName(profile, original) {
    const custom = typeof profile?.username === "string" ? profile.username.trim() : "";
    if (!custom || !original || custom === original) return original;
    return `${custom}\nOriginally, ${original}`;
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
      if (!profile?.username) return user;

      const originalUsername = user.username;
      const originalGlobalName = user.globalName || user.global_name || originalUsername;
      const shown = displayName(profile, originalGlobalName);
      return {
        ...user,
        username: shown,
        globalName: shown,
        global_name: shown,
        __jadgesOriginalUsername: originalUsername
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
      const response = await vendetta.utils.safeFetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data && typeof data === "object" && !Array.isArray(data)) profiles = data;
    } catch (error) {
      logger().warn("[JadgesCustomProfiles] Could not refresh custom profiles", error);
    }
  }

  async function onLoad() {
    await refresh();
    patchUserStore();
    patchSnowflakeTimestamp();
    timer = setInterval(() => void refresh(), REFRESH_INTERVAL);
    logger().log("[JadgesCustomProfiles] Enabled with instant profile refresh for Kettu and Revenge");
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
