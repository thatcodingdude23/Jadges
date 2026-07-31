import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import type {
  BadgeRecord,
  BadgeSide,
  NitroRecord,
  StoreData,
  UserRecord,
} from "./types.js";

const emptyStore = (): StoreData => ({ users: {} });
let writeQueue: Promise<void> = Promise.resolve();

async function ensureStore(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    await readFile(config.storeFile, "utf8");
  } catch {
    await writeFile(config.storeFile, JSON.stringify(emptyStore(), null, 2), "utf8");
  }
}

async function readStoreUnsafe(): Promise<StoreData> {
  await ensureStore();
  const raw = await readFile(config.storeFile, "utf8");
  const parsed = JSON.parse(raw) as StoreData;
  parsed.users ??= {};

  for (const user of Object.values(parsed.users)) {
    user.blocked ??= false;
    user.badges ??= [];
    if (user.badgeOrder && !Array.isArray(user.badgeOrder)) {
      delete user.badgeOrder;
    }
    if (user.badgeSide !== "left" && user.badgeSide !== "right") {
      delete user.badgeSide;
    }
  }

  return parsed;
}

async function writeStoreUnsafe(data: StoreData): Promise<void> {
  const temporary = `${config.storeFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await rename(temporary, config.storeFile);
}

export async function readStore(): Promise<StoreData> {
  await writeQueue;
  return readStoreUnsafe();
}

export function mutateStore<T>(
  mutation: (data: StoreData) => T | Promise<T>,
): Promise<T> {
  const operation = writeQueue.then(async () => {
    const data = await readStoreUnsafe();
    const result = await mutation(data);
    await writeStoreUnsafe(data);
    return result;
  });

  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
}

export function getOrCreateUser(data: StoreData, userId: string): UserRecord {
  const user = data.users[userId] ??= { blocked: false, badges: [] };
  user.badges ??= [];
  return user;
}

function removeOrderKey(user: UserRecord, key: string): void {
  if (!user.badgeOrder) return;
  user.badgeOrder = user.badgeOrder.filter((item) => item !== key);
  if (user.badgeOrder.length === 0) delete user.badgeOrder;
}

export async function getUser(userId: string): Promise<UserRecord> {
  const data = await readStore();
  return data.users[userId] ?? { blocked: false, badges: [] };
}

export async function addPendingBadge(badge: BadgeRecord): Promise<void> {
  await mutateStore((data) => {
    getOrCreateUser(data, badge.userId).badges.push(badge);
  });
}

export async function approveBadge(badgeId: string): Promise<BadgeRecord> {
  return mutateStore((data) => {
    for (const user of Object.values(data.users)) {
      const badge = user.badges.find((item) => item.id === badgeId);
      if (badge) {
        badge.pending = false;
        badge.approvedAt = new Date().toISOString();
        return badge;
      }
    }
    throw new Error("Badge not found");
  });
}

export async function removeBadgeById(badgeId: string): Promise<BadgeRecord> {
  return mutateStore((data) => {
    for (const user of Object.values(data.users)) {
      const index = user.badges.findIndex((item) => item.id === badgeId);
      if (index !== -1) {
        const [badge] = user.badges.splice(index, 1);
        if (!badge) throw new Error("Badge not found");
        removeOrderKey(user, `custom:${badge.id}`);
        return badge;
      }
    }
    throw new Error("Badge not found");
  });
}

export async function removeBadgeForUserById(
  userId: string,
  badgeId: string,
): Promise<BadgeRecord> {
  return mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const index = user.badges.findIndex((item) => item.id === badgeId);
    if (index === -1) throw new Error("Badge not found");
    const [badge] = user.badges.splice(index, 1);
    if (!badge) throw new Error("Badge not found");
    removeOrderKey(user, `custom:${badge.id}`);
    return badge;
  });
}

export async function removeBadgeByName(
  userId: string,
  name: string,
): Promise<BadgeRecord> {
  return mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const index = user.badges.findIndex(
      (item) => item.name.toLowerCase() === name.toLowerCase(),
    );
    if (index === -1) throw new Error("Badge not found");
    const [badge] = user.badges.splice(index, 1);
    if (!badge) throw new Error("Badge not found");
    removeOrderKey(user, `custom:${badge.id}`);
    return badge;
  });
}

export async function addPendingNitro(request: NitroRecord): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, request.userId);
    if (user.pendingNitro) {
      throw new Error("Nitro preset already pending");
    }
    user.pendingNitro = request;
  });
}

export async function approveNitro(requestId: string): Promise<NitroRecord> {
  return mutateStore((data) => {
    for (const user of Object.values(data.users)) {
      const request = user.pendingNitro;
      if (request?.id !== requestId) continue;

      const approved: NitroRecord = {
        ...request,
        pending: false,
        approvedAt: new Date().toISOString(),
      };
      user.nitro = approved;
      delete user.pendingNitro;
      return approved;
    }
    throw new Error("Nitro request not found");
  });
}

export async function removePendingNitro(requestId: string): Promise<NitroRecord> {
  return mutateStore((data) => {
    for (const user of Object.values(data.users)) {
      const request = user.pendingNitro;
      if (request?.id !== requestId) continue;

      delete user.pendingNitro;
      return request;
    }
    throw new Error("Nitro request not found");
  });
}

export async function removePendingNitroForUser(
  userId: string,
): Promise<NitroRecord> {
  return mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const request = user.pendingNitro;
    if (!request) throw new Error("Pending Nitro request not found");
    delete user.pendingNitro;
    return request;
  });
}

export async function removeEquippedNitroForUser(
  userId: string,
): Promise<NitroRecord> {
  return mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const request = user.nitro;
    if (!request) throw new Error("Equipped Nitro badge not found");
    delete user.nitro;
    removeOrderKey(user, "nitro");
    return request;
  });
}

export interface RemovedNitroState {
  removedEquipped: boolean;
  removedPending: boolean;
  removedLegacy: boolean;
}

export async function removeNitroForUser(
  userId: string,
): Promise<RemovedNitroState> {
  return mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const removedEquipped = Boolean(user.nitro);
    const removedPending = Boolean(user.pendingNitro);
    let removedLegacy = false;

    delete user.nitro;
    delete user.pendingNitro;
    removeOrderKey(user, "nitro");

    for (const badge of user.badges) {
      if (!badge.nitroPreset) continue;
      delete badge.nitroPreset;
      removedLegacy = true;
    }

    return { removedEquipped, removedPending, removedLegacy };
  });
}

export async function setBadgeOrder(
  userId: string,
  order: string[],
): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    const unique = [...new Set(order.filter((value) => typeof value === "string"))];
    if (unique.length > 0) user.badgeOrder = unique;
    else delete user.badgeOrder;
  });
}

export async function setBadgeSide(
  userId: string,
  side: BadgeSide | undefined,
): Promise<void> {
  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId);
    if (side === "left" || side === "right") user.badgeSide = side;
    else delete user.badgeSide;
  });
}

export async function setBlocked(userId: string, blocked: boolean): Promise<void> {
  await mutateStore((data) => {
    getOrCreateUser(data, userId).blocked = blocked;
  });
}
