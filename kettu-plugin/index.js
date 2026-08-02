(() => {
  "use strict";

  const SOURCES = [
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/index.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/theme.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/visibility.js"
  ];
  const AUTHORIZED_API_ORIGIN = "https://jadges.onrender.com";
  const PROTECTED_PATHS = new Set([
    "/api/native-badges",
    "/api/profile-visible-badges"
  ]);

  const loadedModules = [];
  let originalSafeFetch;
  let connecting = false;
  let stopped = false;
  let retryTimer;

  function logger() {
    return vendetta?.logger ?? console;
  }

  function currentUserId() {
    try {
      return vendetta.metro.common?.UserStore?.getCurrentUser?.()?.id
        || vendetta.metro.findByStoreName?.("UserStore")?.getCurrentUser?.()?.id
        || vendetta.metro.findByProps?.("getCurrentUser")?.getCurrentUser?.()?.id;
    } catch {
      return undefined;
    }
  }

  function authorizationToken() {
    return String(vendetta.plugin?.storage?.authorizationToken || "").trim();
  }

  function saveAuthorizationToken(token) {
    vendetta.plugin.storage.authorizationToken = token;
  }

  function clearAuthorizationToken() {
    vendetta.plugin.storage.authorizationToken = "";
  }

  function protectedPath(value) {
    try {
      const url = new URL(value);
      return url.origin === AUTHORIZED_API_ORIGIN && PROTECTED_PATHS.has(url.pathname)
        ? url.pathname
        : undefined;
    } catch {
      return undefined;
    }
  }

  function skippedResponse() {
    return {
      ok: true,
      status: 202,
      statusText: "Ignored",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true, ignored: true }),
      text: async () => JSON.stringify({ ok: true, ignored: true }),
      clone() { return skippedResponse(); }
    };
  }

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void ensureAuthorization(), 8000);
  }

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function openAuthorizationPage(url) {
    const linking = vendetta.metro.common?.ReactNative?.Linking;
    if (typeof linking?.openURL === "function") {
      await linking.openURL(url);
      return;
    }
    const nativeLinking = globalThis.nativeModuleProxy?.LinkingManager;
    if (typeof nativeLinking?.openURL === "function") {
      await nativeLinking.openURL(url);
      return;
    }
    const fallback = vendetta.metro.findByProps?.("openURL");
    if (typeof fallback?.openURL === "function") {
      await fallback.openURL(url);
      return;
    }
    throw new Error("No external browser API was found");
  }

  async function ensureAuthorization() {
    if (stopped || connecting || authorizationToken()) return;
    const userId = currentUserId();
    if (!userId || typeof originalSafeFetch !== "function") {
      scheduleRetry();
      return;
    }

    connecting = true;
    clearTimeout(retryTimer);
    try {
      const startResponse = await originalSafeFetch(`${AUTHORIZED_API_ORIGIN}/api/client-connect/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, client: "Kettu" }),
        cache: "no-store"
      });
      const start = await startResponse.json();
      if (!startResponse.ok) throw new Error(start?.error || `HTTP ${startResponse.status}`);
      if (!start?.deviceCode || !start?.pollSecret || !start?.authorizeUrl) {
        throw new Error("Jadges returned an incomplete authorization request");
      }

      await openAuthorizationPage(start.authorizeUrl);
      const interval = Math.max(1000, Math.min(5000, Number(start.intervalMs) || 2000));
      const deadline = Date.parse(start.expiresAt || "") || Date.now() + 10 * 60 * 1000;

      while (!stopped && Date.now() < deadline) {
        await wait(interval);
        const pollResponse = await originalSafeFetch(`${AUTHORIZED_API_ORIGIN}/api/client-connect/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceCode: start.deviceCode,
            pollSecret: start.pollSecret
          }),
          cache: "no-store"
        });
        const poll = await pollResponse.json().catch(() => ({}));
        if (pollResponse.status === 202 || pollResponse.status === 429) continue;
        if (!pollResponse.ok) throw new Error(poll?.error || `HTTP ${pollResponse.status}`);
        if (poll?.status === "authorized" && typeof poll.token === "string" && poll.token.startsWith("jdg_")) {
          saveAuthorizationToken(poll.token);
          logger().log("[JadgesKettu] Authorization connected automatically");
          return;
        }
      }

      throw new Error("Automatic Jadges authorization expired");
    } catch (error) {
      logger().warn("[JadgesKettu] Automatic authorization failed", error);
      scheduleRetry();
    } finally {
      connecting = false;
    }
  }

  function installAuthorizedFetch() {
    if (originalSafeFetch) return;
    originalSafeFetch = vendetta.utils.safeFetch;

    vendetta.utils.safeFetch = async (input, options = {}, timeout) => {
      const url = typeof input === "string" ? input : String(input?.url || input);
      const reportPath = protectedPath(url);
      if (!reportPath) return originalSafeFetch(input, options, timeout);

      let body = options?.body;
      if (typeof body === "string") {
        try {
          const payload = JSON.parse(body);
          const current = currentUserId();
          if (!current || payload?.userId !== current) return skippedResponse();
          if (reportPath === "/api/native-badges") payload.authoritative = true;
          body = JSON.stringify(payload);
        } catch {
          return skippedResponse();
        }
      }

      const token = authorizationToken();
      if (!token) {
        void ensureAuthorization();
        return skippedResponse();
      }

      const headers = new Headers(options?.headers || {});
      headers.set("authorization", `Bearer ${token}`);
      const response = await originalSafeFetch(input, { ...options, body, headers }, timeout);
      if (response.status === 401) {
        clearAuthorizationToken();
        void ensureAuthorization();
        return skippedResponse();
      }
      return response;
    };
  }

  function restoreAuthorizedFetch() {
    if (originalSafeFetch) vendetta.utils.safeFetch = originalSafeFetch;
    originalSafeFetch = undefined;
  }

  async function loadModule(url) {
    const response = await vendetta.utils.safeFetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);

    const source = await response.text();
    const module = (0, eval)(`${source}\n//# sourceURL=${url}`);
    if (!module || typeof module !== "object") {
      throw new TypeError(`${url} did not return a Jadges mobile module`);
    }
    return module;
  }

  async function onLoad() {
    if (!globalThis.bunny) {
      logger().warn("[JadgesKettu] Kettu's Bunny runtime was not detected");
    }

    stopped = false;
    installAuthorizedFetch();
    void ensureAuthorization();
    for (const url of SOURCES) {
      try {
        const module = await loadModule(url);
        loadedModules.push(module);
        await module.onLoad?.();
      } catch (error) {
        logger().error(`[JadgesKettu] Failed to load ${url}`, error);
      }
    }

    logger().log("[JadgesKettu] Kettu support enabled");
  }

  async function onUnload() {
    stopped = true;
    connecting = false;
    clearTimeout(retryTimer);
    for (const module of loadedModules.splice(0).reverse()) {
      try {
        await module.onUnload?.();
      } catch (error) {
        logger().warn("[JadgesKettu] A module failed to unload cleanly", error);
      }
    }
    restoreAuthorizedFetch();
  }

  return { onLoad, onUnload };
})()
