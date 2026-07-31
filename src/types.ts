export type NitroPreset =
  | "bronze"
  | "silver"
  | "gold"
  | "platinum"
  | "diamond"
  | "emerald"
  | "ruby"
  | "opal"
  | "remove";

export interface BadgeRecord {
  id: string;
  userId: string;
  name: string;
  filename: string;
  mimeType: string;
  pending: boolean;
  createdAt: string;
  approvedAt?: string;
  /** Legacy field kept so presets submitted before the separate command still work. */
  nitroPreset?: NitroPreset;
}

export interface NitroRecord {
  id: string;
  userId: string;
  preset: NitroPreset;
  pending: boolean;
  createdAt: string;
  approvedAt?: string;
}

export interface UserRecord {
  blocked: boolean;
  badges: BadgeRecord[];
  nitro?: NitroRecord;
  pendingNitro?: NitroRecord;
}

export interface StoreData {
  users: Record<string, UserRecord>;
}

export interface PublicNitroPreset {
  key: NitroPreset;
  label: string;
  months: number;
  profileIcon: string;
  /** PNG rendering of profileIcon for mobile clients that cannot display remote SVGs. */
  mobileIcon?: string;
  hoverImage: string;
  subscriberSince: string;
  /** Hides Discord's native Nitro and server-boosting profile badges. */
  hideNativeBadges?: boolean;
}

export interface PublicBadge {
  name: string;
  tooltip: string;
  badge: string;
  pending: false;
  createdAt?: string;
  nitro?: PublicNitroPreset;
}
