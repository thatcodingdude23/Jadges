(() => {
  "use strict";

  const API_ROOT = "https://jadges.onrender.com";
  const SETTINGS_URL = `${API_ROOT}/settings.json`;
  const REFRESH_INTERVAL = 5_000;
  const STORAGE_NAME = "JADGES_ACCOUNT_THEME_SYNC";

  let refreshTimer;
  let syncing = false;
  let storageBackend;
  let syncState = {};

  function currentUserId() {
    try {
      const commonUserStore = vendetta.metro.common?.UserStore;
      const commonUser = commonUserStore?.getCurrentUser?.();
      if (commonUser?.id) return commonUser.id;

      const namedStore = vendetta.metro.findByStoreName?.("UserStore");
      const namedUser = namedStore?.getCurrentUser?.();
      if (namedUser?.id) return namedUser.id;

      const fallback = vendetta.metro.findByProps?.("getCurrentUser");
      return fallback?.getCurrentUser?.()?.id;
    } catch {
      return undefined;
    }
  }

  function normalizeHex(value) {
    const upper = String(value || "").trim().toUpperCase();
    if (/^#[0-9A-F]{3}$/.test(upper)) {
      return `#${upper[1]}${upper[1]}${upper[2]}${upper[2]}${upper[3]}${upper[3]}`;
    }
    return /^#[0-9A-F]{6}$/.test(upper) ? upper : undefined;
  }

  function normalizeTheme(value) {
    if (!value || typeof value !== "object" || value.enabled !== true) return undefined;
    const colors = Array.isArray(value.colors)
      ? value.colors.map(normalizeHex).filter(Boolean).slice(0, 5)
      : [];
    if (colors.length === 0) return undefined;
    return {
      enabled: true,
      mode: value.mode === "light" ? "light" : "dark",
      colors,
      angle: Math.max(0, Math.min(360, Math.round(Number(value.angle) || 0))),
      intensity: Math.max(0, Math.min(100, Math.round(Number(value.intensity) || 0))),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
    };
  }

  async function loadSyncState() {
    try {
      storageBackend = vendetta.storage.createMMKVBackend(STORAGE_NAME);
      syncState = await storageBackend.get();
      if (!syncState || typeof syncState !== "object") syncState = {};
    } catch (error) {
      vendetta.logger.warn("[JadgesTheme] Could not load theme sync storage", error);
      syncState = {};
    }
  }

  async function saveSyncState() {
    try {
      await storageBackend?.set(syncState);
    } catch (error) {
      vendetta.logger.warn("[JadgesTheme] Could not save theme sync storage", error);
    }
  }

  function themeUrl(userId) {
    return `${API_ROOT}/themes/${encodeURIComponent(userId)}.json`;
  }

  function reloadDiscord() {
    const manager = globalThis.nativeModuleProxy?.BundleUpdaterManager;
    if (typeof manager?.reload === "function") {
      setTimeout(() => manager.reload(), 450);
      return true;
    }

    try {
      const module = vendetta.metro.findByProps?.("reload");
      if (typeof module?.reload === "function") {
        setTimeout(() => module.reload(), 450);
        return true;
      }
    } catch {}

    vendetta.logger.warn("[JadgesTheme] Theme saved, but an automatic reload API was not found. Restart Discord to apply it.");
    return false;
  }

  async function applyTheme(userId, theme) {
    const url = themeUrl(userId);
    const signature = JSON.stringify(theme);
    if (
      syncState.userId === userId &&
      syncState.signature === signature &&
      syncState.active === true
    ) {
      return;
    }

    if (typeof vendetta.themes?.fetchTheme !== "function") {
      throw new Error("Revenge theme API is unavailable");
    }

    await vendetta.themes.fetchTheme(url, true);
    syncState = {
      userId,
      themeUrl: url,
      signature,
      active: true,
      appliedAt: new Date().toISOString()
    };
    await saveSyncState();
    vendetta.logger.log("[JadgesTheme] Applied the saved Jadges account theme");
    reloadDiscord();
  }

  async function removeTheme(userId) {
    if (syncState.userId !== userId || syncState.active !== true) return;

    if (typeof vendetta.themes?.selectTheme === "function") {
      await vendetta.themes.selectTheme("default");
    }
    syncState = {
      userId,
      signature: "",
      active: false,
      removedAt: new Date().toISOString()
    };
    await saveSyncState();
    vendetta.logger.log("[JadgesTheme] Restored the default Discord theme");
    reloadDiscord();
  }

  async function refreshTheme() {
    if (syncing) return;
    const userId = currentUserId();
    if (!userId) return;

    syncing = true;
    try {
      const response = await vendetta.utils.safeFetch(SETTINGS_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const settings = await response.json();
      const theme = normalizeTheme(settings?.[userId]?.theme);
      if (theme) await applyTheme(userId, theme);
      else await removeTheme(userId);
    } catch (error) {
      vendetta.logger.error("[JadgesTheme] Failed to synchronize the account theme", error);
    } finally {
      syncing = false;
    }
  }

  async function onLoad() {
    await loadSyncState();
    await refreshTheme();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => void refreshTheme(), REFRESH_INTERVAL);
    vendetta.logger.log("[JadgesTheme] Account theme synchronization enabled");
  }

  function onUnload() {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    syncing = false;
  }

  return { onLoad, onUnload };
})()
