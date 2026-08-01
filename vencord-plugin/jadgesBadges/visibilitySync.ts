import { Settings } from "@api/Settings";
import { findStoreLazy } from "@webpack";

interface UserProfileLike {
    userId?: string;
    fetchEndedAt?: number;
    badges?: Array<{ icon?: string; }>;
}

interface UserProfileStoreLike {
    takeSnapshot(): Record<string, UserProfileLike>;
}

type VisibilityResponse = Record<string, string[]>;

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;
const UserProfileStore = findStoreLazy("UserProfileStore") as UserProfileStoreLike;

let visibilityData: VisibilityResponse = {};
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

function restoreControl(control: HTMLElement): void {
    if (control.dataset.jadgesVisibilityHidden !== "true") return;
    delete control.dataset.jadgesVisibilityHidden;

    if (control.dataset.jadgesHiddenKind) return;
    const original = control.dataset.jadgesVisibilityOriginalDisplay;
    control.style.display = original === "__empty__" ? "" : original || "";
    delete control.dataset.jadgesVisibilityOriginalDisplay;
}

function setControlHidden(control: HTMLElement, shouldHide: boolean): void {
    if (!shouldHide) {
        restoreControl(control);
        return;
    }

    if (!control.dataset.jadgesVisibilityOriginalDisplay) {
        control.dataset.jadgesVisibilityOriginalDisplay = control.style.display || "__empty__";
    }
    control.dataset.jadgesVisibilityHidden = "true";
    control.style.display = "none";
}

function syncProfileVisibility(): void {
    const userId = currentProfileUserId();
    const hidden = new Set(userId && Array.isArray(visibilityData[userId])
        ? visibilityData[userId]
        : []);

    document
        .querySelectorAll<HTMLImageElement>('[data-jadges-key], img[class*="badge"]')
        .forEach(image => {
            const control = controlForImage(image);
            if (!control) return;
            const key = keyForImage(image, control);
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
        const response = await fetch(`${apiRoot()}/visibility.json`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) throw new Error(`Jadges visibility returned HTTP ${response.status}`);
        const data: unknown = await response.json();
        visibilityData = data && typeof data === "object" && !Array.isArray(data)
            ? data as VisibilityResponse
            : {};
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
    void refreshVisibility();
    refreshTimer = setInterval(() => void refreshVisibility(), REFRESH_INTERVAL);
}

export function stopVisibilitySync(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    visibilityData = {};
    restoreAll();
}
