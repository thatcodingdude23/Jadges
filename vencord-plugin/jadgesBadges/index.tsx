/*
 * Jadges compatibility wrapper.
 * Keeps native Discord badges available for rearranging without mixing them
 * into the Jadges directory or intercepting unrelated DM/status clicks.
 */

import definePlugin from "@utils/types";

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

type FetchFunction = typeof globalThis.fetch;
type QuerySelectorAll = typeof document.querySelectorAll;
type AddEventListener = typeof document.addEventListener;

interface NativeReportDecision {
    skip: boolean;
    init?: RequestInit;
}

let originalFetch: FetchFunction | undefined;
let originalQuerySelectorAll: QuerySelectorAll | undefined;
let fetchInstalled = false;
let queryFilterInstalled = false;

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

        // V.27 replaces the old DOM scanner. Only the authoritative inventory
        // produced from Discord's UserProfileStore is allowed to reach Jadges.
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
    description: "Displays Jadges badges, rearranges native Discord badges, syncs account themes, and installs verified Jadges updates.",
    authors: [{ name: "Jaycord", id: 0n }],
    dependencies: ["BadgeAPI"],
    options: (basePlugin as any).options,
    start: startWithoutGlobalBadgeClick,
    stop() {
        try {
            stopNativeInventorySync();
            stopProfileVisibilityReporter();
            stopVisibilitySync();
            stopThemeSync();
            stopUpdateChecker();
            (basePlugin as any).stop?.();
        } finally {
            restoreGuards();
        }
    }
});
