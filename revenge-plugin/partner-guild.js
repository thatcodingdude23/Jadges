(() => {
  "use strict";

  const API_ROOT = "https://jadges.onrender.com";
  const PARTNER_GUILDS_URL = `${API_ROOT}/partner-guilds.json`;
  const REFRESH_INTERVAL = 5_000;
  const DISCORD_ID = /^\d{15,22}$/;
  const PARTNER_FEATURE = "PARTNERED";

  let partnerGuildIds = new Set();
  let refreshTimer;
  let guildStore;
  const unpatches = [];

  function logger() {
    return vendetta?.logger ?? console;
  }

  function normalizePartnerGuildIds(value) {
    const source = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray(value.guildIds)
        ? value.guildIds
        : [];

    return new Set(
      source.filter(guildId =>
        typeof guildId === "string" && DISCORD_ID.test(guildId)
      )
    );
  }

  function sameIds(left, right) {
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  function guildIdOf(guild) {
    const guildId = guild?.id ?? guild?.guildId;
    return typeof guildId === "string" && DISCORD_ID.test(guildId)
      ? guildId
      : undefined;
  }

  function addPartnerFeature(features) {
    if (Array.isArray(features)) {
      return features.includes(PARTNER_FEATURE)
        ? features
        : [...features, PARTNER_FEATURE];
    }

    if (features instanceof Set) {
      if (features.has(PARTNER_FEATURE)) return features;
      const next = new Set(features);
      next.add(PARTNER_FEATURE);
      return next;
    }

    if (features && typeof features[Symbol.iterator] === "function") {
      try {
        const values = [...features];
        return values.includes(PARTNER_FEATURE)
          ? features
          : [...values, PARTNER_FEATURE];
      } catch {}
    }

    return [PARTNER_FEATURE];
  }

  function partnerGuild(guild) {
    if (!guild || typeof guild !== "object") return guild;

    const guildId = guildIdOf(guild);
    if (!guildId || !partnerGuildIds.has(guildId)) return guild;

    const features = addPartnerFeature(guild.features);
    if (features === guild.features) return guild;

    try {
      const clone = Object.assign(
        Object.create(Object.getPrototypeOf(guild)),
        guild
      );
      clone.features = features;
      return clone;
    } catch {
      return { ...guild, features };
    }
  }

  function partnerGuildMap(guilds) {
    if (!guilds || typeof guilds !== "object" || Array.isArray(guilds)) {
      return guilds;
    }

    let changed = false;
    const next = { ...guilds };
    for (const [guildId, guild] of Object.entries(guilds)) {
      const patched = partnerGuild(guild);
      if (patched === guild) continue;
      next[guildId] = patched;
      changed = true;
    }
    return changed ? next : guilds;
  }

  function notifyGuildStore() {
    try {
      if (typeof guildStore?.emitChange === "function") {
        guildStore.emitChange();
      }
    } catch (error) {
      logger().warn("[JadgesPartnerGuilds] Could not refresh the guild UI", error);
    }
  }

  async function refreshPartnerGuilds() {
    try {
      const response = await vendetta.utils.safeFetch(
        `${PARTNER_GUILDS_URL}?t=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const nextIds = normalizePartnerGuildIds(await response.json());
      if (sameIds(partnerGuildIds, nextIds)) return;

      partnerGuildIds = nextIds;
      notifyGuildStore();
    } catch (error) {
      logger().warn("[JadgesPartnerGuilds] Could not synchronize partner guilds", error);
    }
  }

  function installGuildStorePatches() {
    const found = vendetta.metro.findByProps("getGuild", "getGuilds");
    guildStore = found?.default && typeof found.default.getGuild === "function"
      ? found.default
      : found;

    if (!guildStore || typeof guildStore.getGuild !== "function") {
      logger().warn("[JadgesPartnerGuilds] Discord's GuildStore was not found");
      return;
    }

    unpatches.push(
      vendetta.patcher.after("getGuild", guildStore, (_args, guild) =>
        partnerGuild(guild)
      )
    );

    if (typeof guildStore.getGuilds === "function") {
      unpatches.push(
        vendetta.patcher.after("getGuilds", guildStore, (_args, guilds) =>
          partnerGuildMap(guilds)
        )
      );
    }

    logger().log("[JadgesPartnerGuilds] Mobile Partner guild rendering enabled");
  }

  async function onLoad() {
    installGuildStorePatches();
    await refreshPartnerGuilds();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(
      () => void refreshPartnerGuilds(),
      REFRESH_INTERVAL
    );
  }

  function onUnload() {
    clearInterval(refreshTimer);
    refreshTimer = undefined;

    for (const unpatch of unpatches.splice(0).reverse()) {
      try { unpatch?.(); } catch {}
    }

    partnerGuildIds.clear();
    notifyGuildStore();
    guildStore = undefined;
  }

  return { onLoad, onUnload };
})()
