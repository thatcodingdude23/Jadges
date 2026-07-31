export type NitroPreset =
  | "bronze"
  | "silver"
  | "gold"
  | "platinum"
  | "diamond"
  | "emerald"
  | "ruby"
  | "opal";

export interface BadgeRecord {
  id: string;
  userId: string;
  name: string;
  filename: string;
  mimeType: string;
  pending: boolean;
  createdAt: string;
  approvedAt?: string;
  nitroPreset?: NitroPreset;
}

export interface UserRecord {
  blocked: boolean;
  badges: BadgeRecord[];
}

export interface StoreData {
  users: Record<string, UserRecord>;
}

export interface PublicNitroPreset {
  key: NitroPreset;
  label: string;
  months: number;
  profileIcon: string;
  hoverImage: string;
  subscriberSince: string;
}

export interface PublicBadge {
  name: string;
  tooltip: string;
  badge: string;
  pending: false;
  createdAt?: string;
  nitro?: PublicNitroPreset;
}
