(() => {
  "use strict";

  const QUEST_KEY = "custom:quest:completed-any";
  const QUEST_MOBILE_NAME = "Completed a Quest";
  let originalSafeFetch;

  function renameQuestBadge(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    for (const badges of Object.values(data)) {
      if (!Array.isArray(badges)) continue;
      for (const badge of badges) {
        if (!badge || badge.key !== QUEST_KEY) continue;
        badge.name = QUEST_MOBILE_NAME;
        badge.tooltip = QUEST_MOBILE_NAME;
      }
    }
    return data;
  }

  function isBadgesRequest(input) {
    const value = typeof input === "string" ? input : input?.url;
    return typeof value === "string" && /\/badges\.json(?:\?|$)/.test(value);
  }

  function onLoad() {
    if (typeof vendetta?.utils?.safeFetch !== "function") return;
    originalSafeFetch = vendetta.utils.safeFetch;

    vendetta.utils.safeFetch = async function patchedSafeFetch(input, init) {
      const response = await originalSafeFetch.call(this, input, init);
      if (!isBadgesRequest(input) || !response || typeof response.json !== "function") {
        return response;
      }

      return new Proxy(response, {
        get(target, property, receiver) {
          if (property === "json") {
            return async () => renameQuestBadge(await target.json());
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
  }

  function onUnload() {
    if (originalSafeFetch && vendetta?.utils) {
      vendetta.utils.safeFetch = originalSafeFetch;
    }
    originalSafeFetch = undefined;
  }

  return { onLoad, onUnload };
})()
