import {
  getOrCreateUser,
  mutateStore,
} from "./store.js";
import type {
  NativeBadgeObservation,
  UserRecord,
} from "./types.js";

const STALE_NATIVE_BADGE_MS = 30 * 24 * 60 * 60 * 1000;

interface NativeStoreUser extends UserRecord {
  hiddenBadgeKeys?: string[];
  profileVisibleBadgeKeys?: string[];
}

function normalizedBadgeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isBotOnlyNativeBadgeName(value: string): boolean {
  const name = normalizedBadgeName(value);
  return name === "uses automod"
    || name === "supports commands"
    || name === "supports application commands"
    || name === "supports slash commands"
    || name === "bot http interactions";
}

function isAllowedNativeBadge(badge: NativeBadgeObservation): boolean {
  return !isBotOnlyNativeBadgeName(badge.name);
}

function removeKeys(user: NativeStoreUser, keys: Set<string>): void {
  if (keys.size === 0) return;

  if (Array.isArray(user.badgeOrder)) {
    user.badgeOrder = user.badgeOrder.filter((key) => !keys.has(key));
    if (user.badgeOrder.length === 0) delete user.badgeOrder;
  }

  if (Array.isArray(user.hiddenBadgeKeys)) {
    user.hiddenBadgeKeys = user.hiddenBadgeKeys.filter((key) => !keys.has(key));
    if (user.hiddenBadgeKeys.length === 0) delete user.hiddenBadgeKeys;
  }

  if (Array.isArray(user.profileVisibleBadgeKeys)) {
    user.profileVisibleBadgeKeys = user.profileVisibleBadgeKeys.filter(
      (key) => !keys.has(key),
    );
  }
}

function replaceNativeBadges(
  user: NativeStoreUser,
  badges: NativeBadgeObservation[],
): void {
  const next = [...new Map(
    badges
      .filter(isAllowedNativeBadge)
      .slice(0, 25)
      .map((badge) => [badge.key, badge]),
  ).values()];
  const nextKeys = new Set(next.map((badge) => badge.key));
  const removedKeys = new Set(
    (user.nativeBadges || [])
      .map((badge) => badge.key)
      .filter((key) => !nextKeys.has(key)),
  );

  user.nativeBadges = next;
  if (next.length === 0) delete user.nativeBadges;
  removeKeys(user, removedKeys);
}

export async function setObservedNativeBadges(
  userId: string,
  badges: NativeBadgeObservation[],
  authoritative = false,
): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId) as NativeStoreUser;

    if (authoritative) {
      replaceNativeBadges(user, badges);
      return;
    }

    const merged = new Map<string, NativeBadgeObservation>();
    const removedBotKeys = new Set<string>();
    const now = Date.now();
    const orderedKeys = new Set(user.badgeOrder || []);

    // Compatibility path for older clients. Keep previously detected user
    // badges when Discord briefly renders only part of the profile row, but
    // permanently discard known bot/application badges.
    for (const badge of user.nativeBadges || []) {
      if (!isAllowedNativeBadge(badge)) {
        removedBotKeys.add(badge.key);
        continue;
      }

      const updatedAt = Date.parse(badge.updatedAt);
      const isRecent = Number.isFinite(updatedAt)
        && now - updatedAt <= STALE_NATIVE_BADGE_MS;

      if (isRecent || orderedKeys.has(badge.key)) {
        merged.set(badge.key, badge);
      }
    }

    for (const badge of badges.slice(0, 25)) {
      if (!isAllowedNativeBadge(badge)) {
        removedBotKeys.add(badge.key);
        continue;
      }
      merged.set(badge.key, badge);
    }

    user.nativeBadges = [...merged.values()].slice(0, 25);
    if (user.nativeBadges.length === 0) delete user.nativeBadges;
    removeKeys(user, removedBotKeys);
  });
}
