/*
 * Jadges compatibility wrapper.
 * Keeps native Discord badges available for rearranging without mixing them
 * into the Jadges directory or intercepting unrelated DM/status clicks.
 */

import definePlugin from "@utils/types";
import { UserStore } from "@webpack/common";

import basePlugin from "./base";
import {
    startNativeInventorySync,
    stopNativeInventorySync
} from "./nativeInventorySync";
import {
    startProfileVisibilityReporter,
    stopProfileVisibilityReporter
} from "./profileVisibilityReporter";
import { startThemeSync, stopThemeSync } from "./themeSync";
import { startUpdateChecker, stopUpdateChecker } from "./updater";
import { startVisibilitySync, stopVisibilitySync } from "./visibilitySync";

const BADGE_QUERY = 'img[class*="badge"], img.jadges-profile-badge-image';
const CUSTOM_PROFILE_URL = "https://jadges.onrender.com/custom-profiles.json";
const DISPLAY_NAME_SELECTOR = 'span[data-username-with-effects]';
const USER_TAG_SELECTOR = 'span[class*="userTagUsername_"]';

type FetchFunction = typeof globalThis.fetch;
type QuerySelectorAll = typeof document.querySelectorAll;
type AddEventListener = typeof document.addEventListener;

interface NativeReportDecision {
    skip: boolean;
    init?: RequestInit;
}

interface CustomProfile {
    username?: string;
    createdAt?: string;
}

type CustomProfiles = Record<string, CustomProfile>;

let originalFetch: FetchFunction | undefined;
let originalQuerySelectorAll: QuerySelectorAll | undefined;
let fetchInstalled = false;
let queryFilterInstalled = false;
let globalNameTimer: ReturnType<typeof setInterval> | undefined;
let syncingGlobalNames = false;

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

function isOfficialDiscordBadgeImage(value: unknown): boolean {
    if (typeof value !== "string") return false;

    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        const isDiscordHost =
            host === "cdn.discordapp.com"
            || host.endsWith(".discordapp.com")
            || host === "discord.com"
            || host.endsWith(".discord.com");

        return isDiscordHost
            && (path.includes("/badge-icons/") || path.includes("/assets/content/"));
    } catch {
        return false;
    }
}

function prepareNativeBadgeReport(init: RequestInit | undefined): NativeReportDecision {
    if (!init || typeof init.body !== "string") return { skip: true };

    try {
        const payload = JSON.parse(init.body) as {
            userId?: unknown;
            authoritative?: unknown;
            badges?: Array<{ key?: unknown; name?: unknown; image?: unknown; }>;
        };

        if (
            payload.authoritative !== true
            || typeof payload.userId !== "string"
            || !/^\d{15,22}$/.test(payload.userId)
            || !Array.isArray(payload.badges)
        ) {
            return { skip: true };
        }

        const badges = payload.badges.filter(badge =>
            badge
            && typeof badge.key === "string"
            && badge.key.startsWith("discord:")
            && typeof badge.name === "string"
            && badge.name.trim().length > 0
            && typeof badge.image === "string"
            && isOfficialDiscordBadgeImage(badge.image)
        );

        return {
            skip: false,
            init: {
                ...init,
                body: JSON.stringify({
                    userId: payload.userId,
                    badges,
                    authoritative: true
                })
            }
        };
    } catch {
        return { skip: true };
    }
}

function stripNativeBadgesFromDirectory(data: unknown): unknown {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;

    const result: Record<string, unknown> = {};
    for (const [userId, rawSettings] of Object.entries(data)) {
        if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
            result[userId] = rawSettings;
            continue;
        }

        result[userId] = {
            ...rawSettings,
            nativeBadges: []
        };
    }
    return result;
}

function installFetchGuard(): void {
    if (fetchInstalled) return;
    fetchInstalled = true;
    originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        let nextInit = init;

        if (url.includes("/api/native-badges")) {
            const decision = prepareNativeBadgeReport(init);
            if (decision.skip) {
                return new Response(JSON.stringify({ ok: true, ignored: true }), {
                    status: 202,
                    headers: { "content-type": "application/json; charset=utf-8" }
                });
            }
            nextInit = decision.init;
        }

        const response = await originalFetch!(input, nextInit);

        if (!url.includes("/settings.json") || !response.ok) return response;

        try {
            const data = stripNativeBadgesFromDirectory(await response.clone().json());
            const headers = new Headers(response.headers);
            headers.set("content-type", "application/json; charset=utf-8");
            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers
            });
        } catch {
            return response;
        }
    }) as FetchFunction;
}

function installBadgeQueryFilter(): void {
    if (queryFilterInstalled) return;
    queryFilterInstalled = true;
    originalQuerySelectorAll = document.querySelectorAll.bind(document);

    document.querySelectorAll = ((selectors: string) => {
        const result = originalQuerySelectorAll!(selectors);
        if (selectors !== BADGE_QUERY) return result;

        return Array.from(result).filter(node => {
            if (!(node instanceof HTMLImageElement)) return false;
            if (node.classList.contains("jadges-profile-badge-image")) return true;
            return isOfficialDiscordBadgeImage(node.currentSrc || node.src);
        }) as unknown as NodeListOf<Element>;
    }) as QuerySelectorAll;
}

function matchingProfileId(originalName: string, profiles: CustomProfiles): string | undefined {
    return Object.keys(profiles).find(userId => {
        const user = UserStore.getUser(userId);
        return user?.username === originalName || user?.globalName === originalName;
    });
}

async function syncAllUsernameEffects(): Promise<void> {
    if (syncingGlobalNames) return;
    syncingGlobalNames = true;
    try {
        const response = await fetch(`${CUSTOM_PROFILE_URL}?t=${Date.now()}`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) return;
        const profiles = await response.json() as CustomProfiles;
        if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return;

        for (const span of document.querySelectorAll<HTMLElement>(DISPLAY_NAME_SELECTOR)) {
            const original = span.dataset.jadgesOriginalDisplayName
                || span.dataset.jadgesGlobalOriginalName
                || span.getAttribute("data-username-with-effects")
                || span.textContent?.trim();
            if (!original) continue;

            const userId = matchingProfileId(original, profiles);
            const customName = userId ? profiles[userId]?.username?.trim() : undefined;
            if (!customName) continue;

            if (!span.dataset.jadgesOriginalDisplayName && !span.dataset.jadgesGlobalOriginalName) {
                span.dataset.jadgesGlobalOriginalName = original;
            }
            span.textContent = customName;
            span.setAttribute("data-username-with-effects", customName);

            const scope = span.closest<HTMLElement>('[class*="userProfile"],[class*="profilePopout"],[class*="profileModal"],[role="dialog"],[class*="biteSize"],[class*="fullSize"]');
            if (!scope) continue;
            for (const userTag of scope.querySelectorAll<HTMLElement>(USER_TAG_SELECTOR)) {
                if (!userTag.dataset.jadgesOriginalUserTag) {
                    userTag.dataset.jadgesOriginalUserTag = userTag.textContent?.trim() || original;
                }
                userTag.textContent = customName;
            }
        }
    } catch (error) {
        console.warn("[JadgesBadges] Global custom-name sync failed:", error);
    } finally {
        syncingGlobalNames = false;
    }
}

function startGlobalCustomNameSync(): void {
    void syncAllUsernameEffects();
    clearInterval(globalNameTimer);
    globalNameTimer = setInterval(() => void syncAllUsernameEffects(), 1_000);
}

function stopGlobalCustomNameSync(): void {
    clearInterval(globalNameTimer);
    globalNameTimer = undefined;
    for (const span of document.querySelectorAll<HTMLElement>(DISPLAY_NAME_SELECTOR)) {
        const original = span.dataset.jadgesGlobalOriginalName;
        if (!original) continue;
        span.textContent = original;
        span.setAttribute("data-username-with-effects", original);
        delete span.dataset.jadgesGlobalOriginalName;
    }
}

function restoreGuards(): void {
    if (originalFetch) globalThis.fetch = originalFetch;
    if (originalQuerySelectorAll) document.querySelectorAll = originalQuerySelectorAll;
    originalFetch = undefined;
    originalQuerySelectorAll = undefined;
    fetchInstalled = false;
    queryFilterInstalled = false;
}

async function startWithoutGlobalBadgeClick(): Promise<void> {
    installFetchGuard();
    installBadgeQueryFilter();

    const originalAdd = document.addEventListener.bind(document) as AddEventListener;
    let blockedCaptureClick = false;

    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === "click" && options === true && !blockedCaptureClick) {
            blockedCaptureClick = true;
            return;
        }
        originalAdd(type, listener, options);
    }) as AddEventListener;

    try {
        await (basePlugin as any).start?.();
        startUpdateChecker();
        startGlobalCustomNameSync();
        startThemeSync();
        startVisibilitySync();
        startProfileVisibilityReporter();
        startNativeInventorySync();
    } finally {
        document.addEventListener = originalAdd;
    }
}

export default definePlugin({
    name: "JadgesBadges",
    description: "Displays Jadges badges, native badge ordering, themes, and verified updates.",
    authors: [{ name: "jayden", id: 1439230248100036798n }],
    dependencies: ["BadgeAPI"],
    options: (basePlugin as any).options,
    start: startWithoutGlobalBadgeClick,
    stop() {
        try {
            stopNativeInventorySync();
            stopProfileVisibilityReporter();
            stopVisibilitySync();
            stopThemeSync();
            stopGlobalCustomNameSync();
            stopUpdateChecker();
            (basePlugin as any).stop?.();
        } finally {
            restoreGuards();
        }
    }
});
