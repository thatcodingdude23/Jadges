(() => {
  "use strict";

  const SOURCES = [
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/index.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/theme.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/visibility.js"
  ];
  const PROTECTED_PATHS = [
    "/api/native-badges",
    "/api/profile-visible-badges"
  ];

  const loadedModules = [];
  let originalSafeFetch;

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

  function installAuthorizedFetch() {
    if (originalSafeFetch) return;
    originalSafeFetch = vendetta.utils.safeFetch;

    vendetta.utils.safeFetch = async (input, options = {}, timeout) => {
      const url = typeof input === "string" ? input : String(input?.url || input);
      if (!PROTECTED_PATHS.some(path => url.includes(path))) {
        return originalSafeFetch(input, options, timeout);
      }

      let body = options?.body;
      if (typeof body === "string") {
        try {
          const payload = JSON.parse(body);
          const current = currentUserId();
          if (!current || payload?.userId !== current) return skippedResponse();
          if (url.includes("/api/native-badges")) payload.authoritative = true;
          body = JSON.stringify(payload);
        } catch {
          return skippedResponse();
        }
      }

      const headers = new Headers(options?.headers || {});
      const token = authorizationToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
      return originalSafeFetch(input, { ...options, body, headers }, timeout);
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

    installAuthorizedFetch();
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
    for (const module of loadedModules.splice(0).reverse()) {
      try {
        await module.onUnload?.();
      } catch (error) {
        logger().warn("[JadgesKettu] A module failed to unload cleanly", error);
      }
    }
    restoreAuthorizedFetch();
  }

  function settings() {
    const React = vendetta.metro.common.React;
    const ReactNative = vendetta.metro.common.ReactNative;
    const [token, setToken] = React.useState(authorizationToken());
    const [saved, setSaved] = React.useState(false);

    const save = () => {
      vendetta.plugin.storage.authorizationToken = String(token || "").trim();
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    };

    return React.createElement(
      ReactNative.ScrollView,
      { contentContainerStyle: { padding: 16, gap: 12 } },
      React.createElement(ReactNative.Text, { style: { fontSize: 18, fontWeight: "700", color: "white" } }, "Jadges authorization"),
      React.createElement(ReactNative.Text, { style: { color: "#aeb3c2", lineHeight: 20 } }, "Generate a plugin token in the Jadges website dashboard, paste it below, and save."),
      React.createElement(ReactNative.TextInput, {
        value: token,
        onChangeText: setToken,
        autoCapitalize: "none",
        autoCorrect: false,
        placeholder: "jdg_…",
        placeholderTextColor: "#72788a",
        style: {
          minHeight: 48,
          paddingHorizontal: 12,
          borderRadius: 10,
          backgroundColor: "#20232b",
          color: "white"
        }
      }),
      React.createElement(
        ReactNative.Pressable,
        {
          onPress: save,
          style: {
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            backgroundColor: "#5865f2"
          }
        },
        React.createElement(ReactNative.Text, { style: { color: "white", fontWeight: "700" } }, saved ? "Saved" : "Save token")
      )
    );
  }

  return { onLoad, onUnload, settings };
})()
