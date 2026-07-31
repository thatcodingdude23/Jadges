import {
  getOrCreateUser,
  mutateStore,
} from "./store.js";
import type { NativeBadgeObservation } from "./types.js";

const STALE_NATIVE_BADGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function setObservedNativeBadges(
  userId: string,
  badges: NativeBadgeObservation[],
): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const merged = new Map<string, NativeBadgeObservation>();
    const now = Date.now();
    const orderedKeys = new Set(user.badgeOrder || []);

    // Keep previously detected badges when Discord briefly renders only part of
    // the profile badge row. This prevents valid badges, such as Gifting, from
    // disappearing during a rearrangement save.
    for (const badge of user.nativeBadges || []) {
      const updatedAt = Date.parse(badge.updatedAt);
      const isRecent = Number.isFinite(updatedAt)
        && now - updatedAt <= STALE_NATIVE_BADGE_MS;

      if (isRecent || orderedKeys.has(badge.key)) {
        merged.set(badge.key, badge);
      }
    }

    for (const badge of badges.slice(0, 25)) {
      merged.set(badge.key, badge);
    }

    user.nativeBadges = [...merged.values()].slice(0, 25);
    if (user.nativeBadges.length === 0) delete user.nativeBadges;

    // Do not remove saved native order keys because a partial Discord render is
    // not proof that the badge was removed from the account.
  });
}
