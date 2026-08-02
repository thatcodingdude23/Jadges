import { Settings } from "@api/Settings";
import { findStoreLazy } from "@webpack";
import { UserStore } from "@webpack/common";

interface DiscordProfileBadge {
    id?: string;
    description?: string;
    icon?: string;
    link?: string;
}

interface DiscordUserProfile {
    badges?: DiscordProfileBadge[];
    fetchEndedAt?: number;
}

interface UserProfileStoreLike {
    getUserProfile(userId: string): DiscordUserProfile | undefined;
}

interface NativeBadgeReport {
    key: string;
    name: string;
    image: string;
}

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;
const REPEAT_REPORT_AFTER = 60_000;
const UserProfileStore = findStoreLazy("UserProfileStore") as UserProfileStoreLike;

let timer: ReturnType<typeof setInterval> | undefined;
let reporting = false;
let lastSignature = "";
let lastReportedAt = 0;

function normalizeApiUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    return url || DEFAULT_API_URL;
}

function apiRoot(): string {
    return normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl)
        .replace(/\/badges\.json(?:\?.*)?$/, "");
}

function slug(value: string): string {
    return value
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72);
}

function iconHash(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    const pathHash = trimmed.match(
        /(?:badge-icons|assets\/content)\/([a-z0-9_-]{8,})/i
    )?.[1];
    if (pathHash) return pathHash.toLowerCase();
    if (/^[a-z0-9_-]{8,}$/i.test(trimmed)) return trimmed.toLowerCase();
    return undefined;
}

function badgeKey(badge: DiscordProfileBadge): string | undefined {
    const text = [badge.id, badge.description, badge.link]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();

    if (
        text.includes("server boosting")
        || text.includes("guild-boosting")
        || text.includes("premium guild subscriber")
    ) return "discord:boosting";

    if (
        text.includes("subscriber since")
        || text.includes("discord nitro")
        || text.includes("premium")
    ) return "discord:nitro";

    const hash = iconHash(badge.icon);
    if (hash) return `discord:icon-${hash}`;

    const fallback = slug(String(badge.id || badge.description || ""));
    return fallback ? `discord:${fallback}` : undefined;
}

function badgeImage(icon: unknown): string | undefined {
    if (typeof icon !== "string") return undefined;
    const trimmed = icon.trim();
    if (!trimmed) return undefined;

    if (/^https:\/\//i.test(trimmed)) return trimmed;
    if (/^(?:badge-icons|assets\/content)\//i.test(trimmed)) {
        return `https://cdn.discordapp.com/${trimmed.replace(/^\/+/, "")}`;
    }

    const hash = iconHash(trimmed);
    return hash
        ? `https://cdn.discordapp.com/badge-icons/${encodeURIComponent(hash)}.png`
        : undefined;
}

function normalizedName(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function isBotOnlyBadge(name: string): boolean {
    const normalized = normalizedName(name);
    return normalized === "uses automod"
        || normalized === "supports commands"
        || normalized === "supports application commands"
        || normalized === "supports slash commands"
        || normalized === "bot http interactions";
}

function buildInventory(profile: DiscordUserProfile): NativeBadgeReport[] {
    const unique = new Map<string, NativeBadgeReport>();

    for (const badge of Array.isArray(profile.badges) ? profile.badges : []) {
        const name = String(badge.description || badge.id || "Discord Badge")
            .trim()
            .slice(0, 100);
        if (!name || isBotOnlyBadge(name)) continue;

        const key = badgeKey(badge);
        const image = badgeImage(badge.icon);
        if (!key || !image || unique.has(key)) continue;
        unique.set(key, { key, name, image });
    }

    return [...unique.values()].slice(0, 25);
}

async function syncNativeInventory(): Promise<void> {
    if (reporting) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    const profile = UserProfileStore.getUserProfile(userId);
    if (!profile || !Array.isArray(profile.badges)) return;

    const badges = buildInventory(profile);
    const signature = `${userId}:${JSON.stringify(badges)}`;
    const now = Date.now();
    if (signature === lastSignature && now - lastReportedAt < REPEAT_REPORT_AFTER) return;

    reporting = true;
    try {
        const response = await fetch(`${apiRoot()}/api/native-badges`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId, badges, authoritative: true }),
            credentials: "omit",
            cache: "no-store"
        });
        if (!response.ok) {
            throw new Error(`Jadges native inventory returned HTTP ${response.status}`);
        }
        lastSignature = signature;
        lastReportedAt = now;
    } catch (error) {
        console.warn("[JadgesBadges] Could not synchronize native badge inventory:", error);
    } finally {
        reporting = false;
    }
}

export function startNativeInventorySync(): void {
    clearInterval(timer);
    void syncNativeInventory();
    timer = setInterval(() => void syncNativeInventory(), REFRESH_INTERVAL);
}

export function stopNativeInventorySync(): void {
    clearInterval(timer);
    timer = undefined;
    reporting = false;
    lastSignature = "";
    lastReportedAt = 0;
}
