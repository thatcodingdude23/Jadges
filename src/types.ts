export interface BadgeRecord {
  id: string;
  userId: string;
  name: string;
  filename: string;
  mimeType: string;
  pending: boolean;
  createdAt: string;
}

export interface UserRecord {
  blocked: boolean;
  badges: BadgeRecord[];
}

export interface StoreData {
  users: Record<string, UserRecord>;
}

export interface PublicBadge {
  name: string;
  tooltip: string;
  badge: string;
  pending: false;
}
