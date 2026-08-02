import { recordDiscordBadgeCatalog } from "./discordBadgeCatalog.js";
import {
  getOrCreateUser,
  mutateStore,
} from "./store.js";
import type {
  NativeBadgeObservation,
  UserRecord,
} from "./types.js";

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

function isAllowedOwnedBadge(badge: NativeBadgeObservation): boolean {
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

function replaceOwnedNativeBadges(
  user: NativeStoreUser,
  badges: NativeBadgeObservation[],
): void {
  const next = [...new Map(
    badges
      .filter(isAllowedOwnedBadge)
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
  // Every valid Discord badge sighting contributes to the read-only catalogue.
  // This includes bot/application badges and badges belonging to other users.
  await recordDiscordBadgeCatalog(badges);

  // Only Discord's own profile record for the logged-in account may change
  // which badges that account owns. Older DOM reports are catalogue-only.
  if (!authoritative) return;

  let previous: NativeBadgeObservation[] = [];
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId) as NativeStoreUser;
    previous = [...(user.nativeBadges || [])];
    replaceOwnedNativeBadges(user, badges);
  });

  // Preserve removed/stale definitions in the catalogue so they can appear in
  // the separate "Other Discord badges" section without remaining owned.
  await recordDiscordBadgeCatalog(previous);
}
