import {
  getOrCreateUser,
  mutateStore,
} from "./store.js";
import type { NativeBadgeObservation, UserRecord } from "./types.js";

function availableOrderKeys(user: UserRecord): Set<string> {
  const keys = new Set(
    user.badges
      .filter((badge) => !badge.pending)
      .map((badge) => `custom:${badge.id}`),
  );

  if (user.nitro && !user.nitro.pending && user.nitro.preset !== "remove") {
    keys.add("nitro");
  }

  for (const badge of user.nativeBadges || []) {
    keys.add(badge.key);
  }

  return keys;
}

export async function setObservedNativeBadges(
  userId: string,
  badges: NativeBadgeObservation[],
): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const unique = new Map<string, NativeBadgeObservation>();

    for (const badge of badges.slice(0, 25)) {
      if (!unique.has(badge.key)) unique.set(badge.key, badge);
    }

    user.nativeBadges = [...unique.values()];
    if (user.nativeBadges.length === 0) delete user.nativeBadges;

    if (user.badgeOrder) {
      const available = availableOrderKeys(user);
      user.badgeOrder = user.badgeOrder.filter((key) => available.has(key));
      if (user.badgeOrder.length === 0) delete user.badgeOrder;
    }
  });
}
