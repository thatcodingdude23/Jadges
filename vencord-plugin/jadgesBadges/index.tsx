/*
 * Jadges compatibility wrapper.
 * Keeps native Discord badges available for rearranging without mixing them
 * into the Jadges directory or intercepting unrelated DM/status clicks.
 */

import basePlugin from "./base";

const BADGE_QUERY = 'img[class*="badge"], img.jadges-profile-badge-image';

type FetchFunction = typeof globalThis.fetch;
type QuerySelectorAll = typeof document.querySelectorAll;
type AddEventListener = typeof document.addEventListener;

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

function cleanNativeBadgeReport(init: RequestInit | undefined): RequestInit | undefined {
    if (!init || typeof init.body !== "string") return init;

    try {
        const payload = JSON.parse(init.body) as {
            userId?: unknown;
            badges?: Array<{ key?: unknown; name?: unknown; image?: unknown; }>;
        };

        if (!Array.isArray(payload.badges)) return init;

        const badges = payload.badges.filter(badge =>
            badge
            && typeof badge.key === "string"
            && badge.key.startsWith("discord:")
            && typeof badge.image === "string"
            && isOfficialDiscordBadgeImage(badge.image)
        );

        return {
            ...init,
            body: JSON.stringify({ ...payload, badges })
        };
    } catch {
        return init;
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
        const nextInit = url.includes("/api/native-badges")
            ? cleanNativeBadgeReport(init)
            : init;
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
    } finally {
        document.addEventListener = originalAdd;
    }
}

export default {
    ...(basePlugin as any),
    description: "Displays Jadges badges and rearranges native Discord badges without intercepting status clicks.",
    start: startWithoutGlobalBadgeClick,
    stop() {
        try {
            (basePlugin as any).stop?.();
        } finally {
            restoreGuards();
        }
    }
};
