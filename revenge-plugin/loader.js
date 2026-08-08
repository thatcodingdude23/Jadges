(() => {
  "use strict";

  const SOURCES = [
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/custom-profile.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/quest-name.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/index.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/partner-guild.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/theme.js",
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/visibility.js"
  ];

  const loadedPlugins = [];

  async function loadPlugin(url) {
    const response = await vendetta.utils.safeFetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const source = await response.text();
    const plugin = (0, eval)(`${source}\n//# sourceURL=${url}`);
    if (!plugin || typeof plugin !== "object") {
      throw new TypeError(`${url} did not return a Revenge plugin object`);
    }
    return plugin;
  }

  async function onLoad() {
    for (const url of SOURCES) {
      try {
        const plugin = await loadPlugin(url);
        loadedPlugins.push(plugin);
        await plugin.onLoad?.();
      } catch (error) {
        vendetta.logger.error(`[JadgesLoader] Failed to load ${url}`, error);
      }
    }
  }

  async function onUnload() {
    for (const plugin of loadedPlugins.splice(0).reverse()) {
      try {
        await plugin.onUnload?.();
      } catch (error) {
        vendetta.logger.warn("[JadgesLoader] A Jadges module failed to unload cleanly", error);
      }
    }
  }

  return { onLoad, onUnload };
})()
