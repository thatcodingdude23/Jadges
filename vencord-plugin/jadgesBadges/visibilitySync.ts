import { Settings } from "@api/Settings";
import { findStoreLazy } from "@webpack";

import { startPartnerGuildSync, stopPartnerGuildSync } from "./partnerGuildSync";

interface UserProfileLike {
    userId?: string;
    fetchEndedAt?: number;
    badges?: Array<{ icon?: string; }>;
}

interface UserProfileStoreLike {
    takeSnapshot(): Record<string, UserProfileLike>;
}

interface PublicJadgesBadgeLike {
    key?: string;
    badge?: string;
    metadata?: boolean;
}

type VisibilityResponse = Record<string, string[]>;
type BadgeResponse = Record<string, PublicJadgesBadgeLike[]>;

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;
const UserProfileStore = findStoreLazy("UserProfileStore") as UserProfileStoreLike;

let visibilityData: VisibilityResponse = {};
let customBadgeOwners = new Map<string, string>();
let customImageOwners = new Map<string, string>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let observer: MutationObserver | undefined;

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

function valuesFor(control: HTMLElement, image: HTMLImageElement): string[] {
    return [
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("href"),
        image.getAttribute("alt"),
        image.currentSrc,
        image.src
    ].filter((value): value is string => Boolean(value));
}

function nativeKey(values: string[]): string | undefined {
    const text = values.join(" ").toLowerCase();
    if (
        text.includes("server boosting")
        || text.includes("guild-boosting")
        || text.includes("premium guild subscriber")
        || text.includes("51040c70d4f20a921ad6674ff86fc95c")
    ) return "discord:boosting";

    if (
        text.includes("subscriber since")
        || text.includes("settings/premium")
        || text.includes("discord nitro")
    ) return "discord:nitro";

    const image = values.find(value => /^https:\/\//i.test(value));
    const hash = image?.match(/(?:badge-icons|assets\/content)\/([a-z0-9_-]{8,})/i)?.[1];
    if (hash) return `discord:icon-${hash.toLowerCase()}`;

    const seed = values.find(value => value.trim().length > 0);
    const normalized = seed ? slug(seed) : "";
    return normalized ? `discord:${normalized}` : undefined;
}

function imageIdentity(value: string | undefined): string {
    if (!value) return "";
    const hash = value.match(/(?:badge-icons|assets\/content)\/([a-z0-9_-]{8,})/i)?.[1];
    return hash?.toLowerCase() || value.split("?")[0]!.toLowerCase();
}

function updateCustomBadgeOwners(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;

    const nextKeyOwners = new Map<string, string>();
    const nextImageOwners = new Map<string, string>();

    for (const [userId, rawBadges] of Object.entries(value as BadgeResponse)) {
        if (!Array.isArray(rawBadges)) continue;

        for (const badge of rawBadges) {
            if (!badge || badge.metadata || typeof badge.key !== "string") continue;
            if (!badge.key.startsWith("custom:")) continue;

            nextKeyOwners.set(badge.key, userId);
            if (typeof badge.badge === "string") {
                const identity = imageIdentity(badge.badge);
                if (identity) nextImageOwners.set(identity, userId);
            }
        }
    }

    customBadgeOwners = nextKeyOwners;
    customImageOwners = nextImageOwners;
}

function currentProfileUserId(): string | undefined {
    try {
        const rendered = new Set(
            [...document.querySelectorAll<HTMLImageElement>('img[class*="badge"]')]
                .map(image => imageIdentity(image.currentSrc || image.src))
                .filter(Boolean)
        );

        const profiles = Object.values(UserProfileStore.takeSnapshot() || {})
            .filter(profile => typeof profile?.userId === "string")
            .map(profile => ({
                profile,
                score: (profile.badges || []).reduce((total, badge) =>
                    total + (rendered.has(imageIdentity(badge.icon)) ? 1 : 0), 0
                )
            }))
            .sort((left, right) =>
                right.score - left.score
                || Number(right.profile.fetchEndedAt || 0) - Number(left.profile.fetchEndedAt || 0)
            );

        return profiles[0]?.profile.userId;
    } catch {
        return undefined;
    }
}

function controlForImage(image: HTMLImageElement): HTMLElement | undefined {
    return image.closest<HTMLElement>("a, button") || image.parentElement || undefined;
}

function keyForImage(image: HTMLImageElement, control: HTMLElement): string | undefined {
    if (image.dataset.jadgesKey) return image.dataset.jadgesKey;
    return nativeKey(valuesFor(control, image));
}

function exactOwnerForImage(image: HTMLImageElement, key: string | undefined): string | undefined {
    if (key?.startsWith("custom:")) {
        const owner = customBadgeOwners.get(key);
        if (owner) return owner;
    }

    if (image.classList.contains("jadges-profile-badge-image")) {
        return customImageOwners.get(imageIdentity(image.currentSrc || image.src));
    }

    return undefined;
}

function restoreControl(control: HTMLElement): void {
    if (control.dataset.jadgesVisibilityHidden !== "true") return;
    delete control.dataset.jadgesVisibilityHidden;

    const original = control.dataset.jadgesVisibilityOriginalDisplay;
    delete control.dataset.jadgesVisibilityOriginalDisplay;
    if (control.dataset.jadgesHiddenKind) return;

    control.style.display = original === "__empty__" ? "" : original || "";
}

function setControlHidden(control: HTMLElement, shouldHide: boolean): void {
    if (!shouldHide) {
        restoreControl(control);
        return;
    }

    if (!control.dataset.jadgesVisibilityOriginalDisplay) {
        const discordOriginal = control.dataset.jadgesOriginalDisplay;
        control.dataset.jadgesVisibilityOriginalDisplay =
            discordOriginal || control.style.display || "__empty__";
    }
    control.dataset.jadgesVisibilityHidden = "true";
    control.style.display = "none";
}

function syncProfileVisibility(): void {
    const fallbackUserId = currentProfileUserId();

    document
        .querySelectorAll<HTMLImageElement>('[data-jadges-key], img[class*="badge"]')
        .forEach(image => {
            const control = controlForImage(image);
            if (!control) return;

            const key = keyForImage(image, control);
            const userId = exactOwnerForImage(image, key) || fallbackUserId;
            const hidden = new Set(userId && Array.isArray(visibilityData[userId])
                ? visibilityData[userId]
                : []);
            setControlHidden(control, Boolean(key && hidden.has(key)));
        });
}

function restoreAll(): void {
    document
        .querySelectorAll<HTMLElement>('[data-jadges-visibility-hidden="true"]')
        .forEach(restoreControl);
}

async function refreshVisibility(): Promise<void> {
    try {
        const [visibilityResponse, badgeResponse] = await Promise.all([
            fetch(`${apiRoot()}/visibility.json`, {
                cache: "no-store",
                credentials: "omit"
            }),
            fetch(normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl), {
                cache: "no-store",
                credentials: "omit"
            })
        ]);

        if (!visibilityResponse.ok) {
            throw new Error(`Jadges visibility returned HTTP ${visibilityResponse.status}`);
        }

        const visibility: unknown = await visibilityResponse.json();
        visibilityData = visibility && typeof visibility === "object" && !Array.isArray(visibility)
            ? visibility as VisibilityResponse
            : {};

        if (badgeResponse.ok) {
            updateCustomBadgeOwners(await badgeResponse.json());
        }

        syncProfileVisibility();
    } catch (error) {
        console.warn("[JadgesBadges] Could not synchronize hidden badges:", error);
    }
}

export function startVisibilitySync(): void {
    clearInterval(refreshTimer);
    observer?.disconnect();
    observer = new MutationObserver(() => syncProfileVisibility());
    observer.observe(document.body, { childList: true, subtree: true });
    startPartnerGuildSync();
    void refreshVisibility();
    refreshTimer = setInterval(() => void refreshVisibility(), REFRESH_INTERVAL);
}

export function stopVisibilitySync(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    visibilityData = {};
    customBadgeOwners.clear();
    customImageOwners.clear();
    stopPartnerGuildSync();
    restoreAll();
}