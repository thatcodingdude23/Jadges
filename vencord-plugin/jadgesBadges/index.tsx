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
const AUTHORIZED_API_ORIGIN = "https://jadges.onrender.com";
const AUTH_STORAGE_KEY = "jadges.clientAuthorizationToken";
const AUTH_USER_STORAGE_KEY = "jadges.clientAuthorizationUserId";
const PROTECTED_REPORT_PATHS = new Set([
    "/api/native-badges",
    "/api/profile-visible-badges"
]);

type FetchFunction = typeof globalThis.fetch;
type QuerySelectorAll = typeof document.querySelectorAll;
type AddEventListener = typeof document.addEventListener;

interface NativeReportDecision {
    skip: boolean;
    init?: RequestInit;
}

interface ConnectionStart {
    deviceCode?: string;
    pollSecret?: string;
    authorizeUrl?: string;
    expiresAt?: string;
    intervalMs?: number;
    error?: string;
}

interface ConnectionPoll {
    status?: string;
    token?: string;
    error?: string;
}

let originalFetch: FetchFunction | undefined;
let originalQuerySelectorAll: QuerySelectorAll | undefined;
let fetchInstalled = false;
let queryFilterInstalled = false;
let authConnecting = false;
let authStopped = false;
let authAbortController: AbortController | undefined;
let authRetryTimer: ReturnType<typeof setTimeout> | undefined;

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

function protectedReportPath(value: string): string | undefined {
    try {
        const url = new URL(value);
        return url.origin === AUTHORIZED_API_ORIGIN
            && PROTECTED_REPORT_PATHS.has(url.pathname)
            ? url.pathname
            : undefined;
    } catch {
        return undefined;
    }
}

function ignoredResponse(): Response {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" }
    });
}

function authorizationToken(): string {
    try {
        const token = String(localStorage.getItem(AUTH_STORAGE_KEY) || "").trim();
        const savedUserId = String(localStorage.getItem(AUTH_USER_STORAGE_KEY) || "").trim();
        const currentUserId = UserStore.getCurrentUser()?.id;
        if (!token || !savedUserId) return "";
        if (currentUserId && currentUserId !== savedUserId) return "";
        return token;
    } catch {
        return "";
    }
}

function saveAuthorizationToken(token: string, userId: string): void {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, token);
        localStorage.setItem(AUTH_USER_STORAGE_KEY, userId);
    } catch (error) {
        console.warn("[JadgesBadges] Could not save authorization:", error);
    }
}

function clearAuthorizationToken(): void {
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem(AUTH_USER_STORAGE_KEY);
    } catch {}
}

function scheduleAuthorizationRetry(): void {
    if (authStopped) return;
    clearTimeout(authRetryTimer);
    authRetryTimer = setTimeout(() => void ensureAuthorization(), 8_000);
}

function openAuthorizationPage(url: string): void {
    const popup = window.open(url, "_blank", "noopener,noreferrer");
    if (popup) return;

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

async function runAuthorization(userId: string, signal: AbortSignal): Promise<void> {
    const startResponse = await fetch(`${AUTHORIZED_API_ORIGIN}/api/client-connect/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, client: "Vencord" }),
        cache: "no-store",
        credentials: "omit",
        signal
    });
    const start = await startResponse.json().catch(() => ({})) as ConnectionStart;
    if (!startResponse.ok) {
        throw new Error(start.error || `Jadges connection returned HTTP ${startResponse.status}`);
    }
    if (!start.deviceCode || !start.pollSecret || !start.authorizeUrl) {
        throw new Error("Jadges returned an incomplete connection request");
    }

    openAuthorizationPage(start.authorizeUrl);
    const interval = Math.max(1_000, Math.min(5_000, Number(start.intervalMs) || 2_000));
    const deadline = Date.parse(start.expiresAt || "") || Date.now() + 10 * 60_000;

    while (!signal.aborted && Date.now() < deadline) {
        await wait(interval, signal);
        const pollResponse = await fetch(`${AUTHORIZED_API_ORIGIN}/api/client-connect/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                deviceCode: start.deviceCode,
                pollSecret: start.pollSecret
            }),
            cache: "no-store",
            credentials: "omit",
            signal
        });
        const poll = await pollResponse.json().catch(() => ({})) as ConnectionPoll;
        if (pollResponse.status === 202 || pollResponse.status === 429) continue;
        if (!pollResponse.ok) {
            throw new Error(poll.error || `Jadges authorization returned HTTP ${pollResponse.status}`);
        }
        if (poll.status === "authorized" && typeof poll.token === "string" && poll.token.startsWith("jdg_")) {
            saveAuthorizationToken(poll.token, userId);
            console.info("[JadgesBadges] Authorization connected automatically");
            return;
        }
    }

    throw new Error("Jadges authorization expired before it was completed");
}

async function ensureAuthorization(): Promise<void> {
    if (authStopped || authConnecting || authorizationToken()) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) {
        scheduleAuthorizationRetry();
        return;
    }

    authConnecting = true;
    clearTimeout(authRetryTimer);
    authAbortController?.abort();
    authAbortController = new AbortController();

    try {
        await runAuthorization(userId, authAbortController.signal);
    } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.warn("[JadgesBadges] Automatic authorization failed:", error);
            scheduleAuthorizationRetry();
        }
    } finally {
        authConnecting = false;
    }
}

function invalidateAuthorization(): void {
    clearAuthorizationToken();
    void ensureAuthorization();
}

function startAuthorization(): void {
    authStopped = false;
    void ensureAuthorization();
}

function stopAuthorization(): void {
    authStopped = true;
    authConnecting = false;
    clearTimeout(authRetryTimer);
    authRetryTimer = undefined;
    authAbortController?.abort();
    authAbortController = undefined;
}

function reportUserId(init: RequestInit | undefined): string | undefined {
    if (typeof init?.body !== "string") return undefined;
    try {
        const payload = JSON.parse(init.body) as { userId?: unknown };
        return typeof payload.userId === "string" && /^\d{15,22}$/.test(payload.userId)
            ? payload.userId
            : undefined;
    } catch {
        return undefined;
    }
}

function reportBelongsToCurrentUser(init: RequestInit | undefined): boolean {
    const currentUserId = UserStore.getCurrentUser()?.id;
    return Boolean(currentUserId && reportUserId(init) === currentUserId);
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

function withAuthorization(init: RequestInit | undefined, token: string): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return { ...(init || {}), headers };
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
        const reportPath = protectedReportPath(url);
        let nextInit = init;

        if (reportPath === "/api/native-badges") {
            const decision = prepareNativeBadgeReport(init);
            if (decision.skip) return ignoredResponse();
            nextInit = decision.init;
        }

        if (reportPath) {
            // A user-bound token may only report the account currently logged
            // into Discord. Viewing someone else's profile must never clear the
            // local token or begin a new authorization flow.
            if (!reportBelongsToCurrentUser(nextInit)) return ignoredResponse();

            const token = authorizationToken();
            if (!token) {
                void ensureAuthorization();
                return ignoredResponse();
            }
            nextInit = withAuthorization(nextInit, token);
        }

        const response = await originalFetch!(input, nextInit);
        if (reportPath && response.status === 401) {
            invalidateAuthorization();
            return ignoredResponse();
        }

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
    startAuthorization();

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
    description: "Displays Jadges badges, rearranges native Discord badges, syncs account themes, and authorizes profile reporting automatically.",
    authors: [{ name: "Jaycord", id: 0n }],
    dependencies: ["BadgeAPI"],
    options: (basePlugin as any).options,
    start: startWithoutGlobalBadgeClick,
    stop() {
        try {
            stopAuthorization();
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
