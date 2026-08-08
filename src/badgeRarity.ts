import type { BadgeRarity } from "./types.js";

export const PUBLIC_BADGE_RARITIES: BadgeRarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
];

export const STAFF_BADGE_RARITIES: BadgeRarity[] = [
  "exclusive",
  "limited",
  "staff",
  "event",
  "quest",
];

export const ALL_BADGE_RARITIES: BadgeRarity[] = [
  ...PUBLIC_BADGE_RARITIES,
  ...STAFF_BADGE_RARITIES,
];

export const BADGE_RARITY_CHOICES = ALL_BADGE_RARITIES.map((value) => ({
  name: value[0]!.toUpperCase() + value.slice(1),
  value,
}));

export function isBadgeRarity(value: unknown): value is BadgeRarity {
  return typeof value === "string" && ALL_BADGE_RARITIES.includes(value as BadgeRarity);
}

export function isStaffBadgeRarity(value: BadgeRarity): boolean {
  return STAFF_BADGE_RARITIES.includes(value);
}

export function rarityLabel(value: BadgeRarity | undefined): string {
  const rarity = value && isBadgeRarity(value) ? value : "common";
  return rarity[0]!.toUpperCase() + rarity.slice(1);
}
