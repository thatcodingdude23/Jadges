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

export type BadgeSide = "left" | "right";
export type StaffBadgeMode = "default" | "admin";

export interface NativeBadgeObservation {
  /** Stable client-generated key beginning with discord:. */
  key: string;
  name: string;
  image: string;
  updatedAt: string;
}

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
  /**
   * Ordered keys such as custom:<badge id>, nitro, and discord:<native badge>.
   * Jaycord Staff remains pinned first.
   */
  badgeOrder?: string[];
  badgeSide?: BadgeSide;
  /** Native Discord badges last observed by an updated Jadges client. */
  nativeBadges?: NativeBadgeObservation[];
  /** Optional system staff badge selection. Missing means the default staff badge. */
  staffBadgeMode?: StaffBadgeMode;
  /** Permanent Badge Quests that have already awarded their reward. */
  questClaims?: string[];
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

export interface PublicNativeBadge {
  key: string;
  name: string;
  image: string;
}

export interface PublicBadge {
  key: string;
  name: string;
  tooltip: string;
  badge: string;
  pending: false;
  createdAt?: string;
  side?: BadgeSide;
  nitro?: PublicNitroPreset;
  /** Settings-only record consumed by the Jadges clients. */
  metadata?: boolean;
  /** Complete order, including native Discord badge keys. */
  order?: string[];
  /** Native Discord badges observed by a Jadges client. */
  nativeBadges?: PublicNativeBadge[];
}
