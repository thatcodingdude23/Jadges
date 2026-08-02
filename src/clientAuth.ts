import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
import { getOrCreateUser, mutateStore, readStore } from "./store.js";
import type { UserRecord } from "./types.js";

const CLIENT_TOKEN_PREFIX = "jdg_";
const CLIENT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const CLIENT_TOKEN_PATTERN = /^jdg_[A-Za-z0-9_-]{40,120}$/;

export interface ClientAuthorizedUser extends UserRecord {
  clientReportTokenVersion?: number;
  clientReportTokenCreatedAt?: string;
  clientReportTokenExpiresAt?: string;
  // Removed legacy field. It is kept here only so old stores can be cleaned.
  clientReportTokenHash?: string;
}

export interface ClientTokenStatus {
  configured: boolean;
  createdAt?: string;
  expiresAt?: string;
}

function tokenVersion(user: ClientAuthorizedUser | undefined): number {
  const value = Number(user?.clientReportTokenVersion);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function derivedToken(userId: string, version: number): string {
  const digest = createHmac("sha256", config.webSessionSecret)
    .update(`jadges-client-report:${userId}:${version}`, "utf8")
    .digest("base64url");
  return `${CLIENT_TOKEN_PREFIX}${digest}`;
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

function isActive(user: ClientAuthorizedUser | undefined): boolean {
  const expiresAt = Date.parse(user?.clientReportTokenExpiresAt || "");
  return tokenVersion(user) > 0
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now();
}

export async function verifyClientAuthorization(
  request: IncomingMessage,
  userId: string,
): Promise<boolean> {
  const supplied = bearerToken(request);
  if (!supplied) return false;

  const data = await readStore();
  const user = data.users[userId] as ClientAuthorizedUser | undefined;
  if (!isActive(user)) return false;

  return constantTimeEqual(
    supplied,
    derivedToken(userId, tokenVersion(user)),
  );
}

export async function issueClientToken(
  userId: string,
  options: { rotate?: boolean } = {},
): Promise<{ token: string; createdAt: string; expiresAt: string }> {
  let version = 0;
  let createdAt = "";
  let expiresAt = "";

  await mutateStore((data) => {
    const user = getOrCreateUser(data, userId) as ClientAuthorizedUser;
    const currentVersion = tokenVersion(user);

    if (!options.rotate && isActive(user)) {
      version = currentVersion;
      createdAt = user.clientReportTokenCreatedAt || new Date().toISOString();
      expiresAt = user.clientReportTokenExpiresAt!;
      return;
    }

    version = currentVersion + 1;
    createdAt = new Date().toISOString();
    expiresAt = new Date(Date.now() + CLIENT_TOKEN_LIFETIME_MS).toISOString();
    user.clientReportTokenVersion = version;
    user.clientReportTokenCreatedAt = createdAt;
    user.clientReportTokenExpiresAt = expiresAt;
    delete user.clientReportTokenHash;
  });

  return {
    token: derivedToken(userId, version),
    createdAt,
    expiresAt,
  };
}

export async function revokeClientToken(userId: string): Promise<void> {
  await mutateStore((data) => {
    const user = data.users[userId] as ClientAuthorizedUser | undefined;
    if (!user) return;
    user.clientReportTokenVersion = tokenVersion(user) + 1;
    delete user.clientReportTokenCreatedAt;
    delete user.clientReportTokenExpiresAt;
    delete user.clientReportTokenHash;
  });
}

export async function getClientTokenStatus(userId: string): Promise<ClientTokenStatus> {
  const data = await readStore();
  const user = data.users[userId] as ClientAuthorizedUser | undefined;
  const configured = isActive(user);

  return {
    configured,
    createdAt: configured ? user?.clientReportTokenCreatedAt : undefined,
    expiresAt: configured ? user?.clientReportTokenExpiresAt : undefined,
  };
}
