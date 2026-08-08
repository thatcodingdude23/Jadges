(() => {
  "use strict";

  /*
   * Mobile partner-guild styling is intentionally disabled.
   *
   * Discord Android 340.13 renders the messages/guild navigation bar from
   * Flux stores via useStateFromStores/useStateFromStoresObject. Patching or
   * mutating GuildStore values, including Guild.features, can make that render
   * path receive a value whose internal API no longer matches what Discord
   * expects and crash with "undefined is not a function".
   *
   * Keep this module as a safe no-op so existing Jadges/Revenge/Kettu loaders
   * and any users who installed this module directly do not need to reinstall.
   * Partner guild data and desktop partner styling remain available; mobile
   * partner visuals should only return once implemented at a verified renderer
   * layer without touching Discord stores.
   */

  function logger() {
    return vendetta?.logger ?? console;
  }

  async function onLoad() {
    logger().log(
      "[JadgesPartnerGuilds] Mobile partner styling disabled for Discord Android compatibility"
    );
  }

  function onUnload() {}

  return { onLoad, onUnload };
})()
