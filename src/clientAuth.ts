import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { getOrCreateUser, mutateStore, readStore } from "./store.js";
import type { UserRecord } from "./types.js";

const CLIENT_TOKEN_PREFIX = "jdg_";
const CLIENT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const CLIENT_TOKEN_PATTERN = /^jdg_[A-Za-z0-9_-]{40,120}$/;

export interface ClientAuthorizedUser extends UserRecord {
  clientReportTokenHash?: string;
  clientReportTokenCreatedAt?: string;
  clientReportTokenExpiresAt?: string;
}

export interface ClientTokenStatus {
  configured: boolean;
  createdAt?: string;
  expiresAt?: string;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (typeof value !== "string") return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && CLIENT_TOKEN_PATTERN.test(token) ? token : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function verifyClientAuthorization(
  request: IncomingMessage,
  userId: string,
): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;

  const data = await readStore();
  const user = data.users[userId] as ClientAuthorizedUser | undefined;
  const expectedHash = user?.clientReportTokenHash;
  const expiresAt = Date.parse(user?.clientReportTokenExpiresAt || "");
  if (!expectedHash || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }

  return constantTimeEqual(tokenHash(token), expectedHash);
}

export async function issueClientToken(
  userId: string,
): Promise<{ token: string; createdAt: string; expiresAt: string }> {
  const token = `${CLIENT_TOKEN_PREFIX}${randomBytes(36).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLIENT_TOKEN_LIFETIME_MS).toISOString();
  const hash = tokenHash(token);

  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId) as ClientAuthorizedUser;
    user.clientReportTokenHash = hash;
    user.clientReportTokenCreatedAt = createdAt;
    user.clientReportTokenExpiresAt = expiresAt;
  });

  return { token, createdAt, expiresAt };
}

export async function revokeClientToken(userId: string): Promise<void> {
  await mutateStore((data) => {
    const user = data.users[userId] as ClientAuthorizedUser | undefined;
    if (!user) return;
    delete user.clientReportTokenHash;
    delete user.clientReportTokenCreatedAt;
    delete user.clientReportTokenExpiresAt;
  });
}

export async function getClientTokenStatus(userId: string): Promise<ClientTokenStatus> {
  const data = await readStore();
  const user = data.users[userId] as ClientAuthorizedUser | undefined;
  const expiresAt = Date.parse(user?.clientReportTokenExpiresAt || "");
  const configured = Boolean(
    user?.clientReportTokenHash
      && Number.isFinite(expiresAt)
      && expiresAt > Date.now(),
  );

  return {
    configured,
    createdAt: configured ? user?.clientReportTokenCreatedAt : undefined,
    expiresAt: configured ? user?.clientReportTokenExpiresAt : undefined,
  };
}
