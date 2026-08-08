(() => {
  "use strict";

  const SOURCES = [
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/custom-profile.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/quest-name.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/index.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/profile-badges.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/partner-guild.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/theme.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/visibility.js"
  ];

  const loadedModules = [];

  function logger() {
    return vendetta?.logger ?? console;
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
  }

  return { onLoad, onUnload };
})()
