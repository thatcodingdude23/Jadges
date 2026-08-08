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
  const modifiedGuilds = new Map();
  let warnedUnsupportedFeatures = false;

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
    // Discord has used multiple feature container types across Android builds.
    // Preserve the exact container API instead of converting an unknown
    // iterable into an Array. Converting it can make Discord later call a
    // missing method such as features.has(), crashing the guild bar render.
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

    // Immutable-style Set implementations usually expose has() + add(), with
    // add() returning another value of the same type. This keeps that type.
    if (
      features &&
      typeof features === "object" &&
      typeof features.has === "function" &&
      typeof features.add === "function"
    ) {
      try {
        if (features.has(PARTNER_FEATURE)) return features;
        const next = features.add(PARTNER_FEATURE);
        if (
          next &&
          typeof next === "object" &&
          typeof next.has === "function"
        ) {
          return next;
        }
      } catch {}
    }

    return undefined;
  }

  function restoreGuild(guild) {
    if (!guild || !modifiedGuilds.has(guild)) return guild;
    const originalFeatures = modifiedGuilds.get(guild);
    try {
      guild.features = originalFeatures;
    } catch {}
    modifiedGuilds.delete(guild);
    return guild;
  }

  function partnerGuild(guild) {
    if (!guild || typeof guild !== "object") return guild;

    const guildId = guildIdOf(guild);
    if (!guildId || !partnerGuildIds.has(guildId)) {
      return restoreGuild(guild);
    }

    const features = addPartnerFeature(guild.features);
    if (features === guild.features) return guild;

    if (features === undefined) {
      if (!warnedUnsupportedFeatures) {
        warnedUnsupportedFeatures = true;
        logger().warn(
          "[JadgesPartnerGuilds] Skipping partner styling because this Discord build uses an unsupported Guild.features container"
        );
      }
      return guild;
    }

    // Keep Discord's original Guild object identity and prototype intact.
    // Several Android builds keep internal methods/state on this object that
    // are lost by Object.assign/Object.create cloning.
    try {
      if (!modifiedGuilds.has(guild)) {
        modifiedGuilds.set(guild, guild.features);
      }
      guild.features = features;
    } catch (error) {
      modifiedGuilds.delete(guild);
      logger().warn(
        "[JadgesPartnerGuilds] Could not safely apply partner styling to this guild",
        error
      );
    }

    return guild;
  }

  function partnerGuildMap(guilds) {
    if (!guilds || typeof guilds !== "object" || Array.isArray(guilds)) {
      return guilds;
    }

    // Do not clone Discord's guild map or its Guild values. Only safely update
    // the existing feature field on partner guilds.
    for (const guild of Object.values(guilds)) {
      partnerGuild(guild);
    }
    return guilds;
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

    if (typeof vendetta?.patcher?.after !== "function") {
      logger().warn("[JadgesPartnerGuilds] Revenge patcher.after is unavailable on this build");
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

    for (const [guild, originalFeatures] of modifiedGuilds) {
      try { guild.features = originalFeatures; } catch {}
    }
    modifiedGuilds.clear();

    partnerGuildIds.clear();
    notifyGuildStore();
    guildStore = undefined;
    warnedUnsupportedFeatures = false;
  }

  return { onLoad, onUnload };
})()
