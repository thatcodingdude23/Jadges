import { Settings } from "@api/Settings";
import { findStoreLazy } from "@webpack";
import { UserStore } from "@webpack/common";

interface ProfileBadgeLike {
    icon?: string;
}

interface UserProfileLike {
    userId?: string;
    badges?: ProfileBadgeLike[];
    fetchEndedAt?: number;
}

interface UserProfileStoreLike {
    takeSnapshot(): Record<string, UserProfileLike>;
}

type BadgeControl = {
    control: HTMLElement;
    image: HTMLImageElement;
};

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REPORT_INTERVAL = 5_000;
const REPEAT_REPORT_AFTER = 60_000;
const UserProfileStore = findStoreLazy("UserProfileStore") as UserProfileStoreLike;

let timer: ReturnType<typeof setInterval> | undefined;
let observer: MutationObserver | undefined;
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

function imageIdentity(value: unknown): string {
    if (typeof value !== "string") return "";
    try {
        const url = new URL(value);
        return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase()}`;
    } catch {
        return value.toLowerCase().split("?")[0] || "";
    }
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

function keyFor(control: HTMLElement, image: HTMLImageElement): string | undefined {
    const jadgesKey = image.dataset.jadgesKey;
    if (jadgesKey) return jadgesKey;
    return nativeKey(valuesFor(control, image));
}

function controlFor(image: HTMLImageElement): HTMLElement | undefined {
    return image.closest<HTMLElement>("a, button") || image.parentElement || undefined;
}

function collectProfileControls(): BadgeControl[] {
    const groups = new Map<HTMLElement, BadgeControl[]>();
    const seen = new Set<HTMLElement>();

    document
        .querySelectorAll<HTMLImageElement>('[data-jadges-key], img[class*="badge"]')
        .forEach(image => {
            const control = controlFor(image);
            const parent = control?.parentElement;
            if (!control || !parent || seen.has(control)) return;
            seen.add(control);
            const group = groups.get(parent) || [];
            group.push({ control, image });
            groups.set(parent, group);
        });

    return [...groups.values()]
        .filter(group =>
            group.length >= 2
            || group.some(({ image }) => Boolean(image.dataset.jadgesKey))
        )
        .sort((left, right) => right.length - left.length)[0] || [];
}

function currentProfileUserId(controls: BadgeControl[]): string | undefined {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId) return undefined;

    const rendered = new Set(
        controls
            .map(({ image }) => imageIdentity(image.currentSrc || image.src))
            .filter(Boolean)
    );

    try {
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
        const resolved = profiles[0]?.profile.userId;
        return resolved === currentUserId ? resolved : undefined;
    } catch {
        return undefined;
    }
}

function isActuallyVisible(control: HTMLElement, image: HTMLImageElement): boolean {
    if (!control.isConnected || !image.isConnected || control.hidden || image.hidden) return false;
    const controlStyle = getComputedStyle(control);
    const imageStyle = getComputedStyle(image);
    if (
        controlStyle.display === "none"
        || controlStyle.visibility === "hidden"
        || controlStyle.visibility === "collapse"
        || Number.parseFloat(controlStyle.opacity || "1") === 0
        || imageStyle.display === "none"
        || imageStyle.visibility === "hidden"
        || Number.parseFloat(imageStyle.opacity || "1") === 0
    ) return false;

    const rect = control.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

async function reportVisibleBadges(): Promise<void> {
    if (reporting) return;
    const controls = collectProfileControls();
    if (controls.length === 0) return;

    const userId = currentProfileUserId(controls);
    if (!userId) return;

    const visibleKeys = [...new Set(
        controls
            .filter(({ control, image }) => isActuallyVisible(control, image))
            .map(({ control, image }) => keyFor(control, image))
            .filter((key): key is string => Boolean(key))
    )];
    const signature = `${userId}:${JSON.stringify(visibleKeys)}`;
    const now = Date.now();
    if (signature === lastSignature && now - lastReportedAt < REPEAT_REPORT_AFTER) return;

    reporting = true;
    try {
        const response = await fetch(`${apiRoot()}/api/profile-visible-badges`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId, visibleKeys }),
            credentials: "omit",
            cache: "no-store"
        });
        if (!response.ok) {
            throw new Error(`Jadges profile visibility returned HTTP ${response.status}`);
        }
        lastSignature = signature;
        lastReportedAt = now;
    } catch (error) {
        console.warn("[JadgesBadges] Could not report visible profile badges:", error);
    } finally {
        reporting = false;
    }
}

export function startProfileVisibilityReporter(): void {
    clearInterval(timer);
    observer?.disconnect();
    observer = new MutationObserver(() => void reportVisibleBadges());
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden"]
    });
    void reportVisibleBadges();
    timer = setInterval(() => void reportVisibleBadges(), REPORT_INTERVAL);
}

export function stopProfileVisibilityReporter(): void {
    clearInterval(timer);
    timer = undefined;
    observer?.disconnect();
    observer = undefined;
    reporting = false;
    lastSignature = "";
    lastReportedAt = 0;
}
