import { PluginNative } from "@utils/types";
import { UserStore } from "@webpack/common";

const CURRENT_UPDATE_VERSION = 37;
const UPDATE_MANIFEST_URL = "https://jadges.onrender.com/vencord-update.json";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;
const PROFILE_URL = "https://jadges.onrender.com/custom-profiles.json";
const PROFILE_REFRESH_INTERVAL = 1_000;
const TOAST_ID = "jadges-update-toast";

const Native = VencordNative.pluginHelpers.JadgesBadges as PluginNative<typeof import("./native")>;

interface UpdateManifest { version: number; }
interface CustomProfile { username?: string; createdAt?: string; }
type CustomProfiles = Record<string, CustomProfile>;

let updateTimer: ReturnType<typeof setInterval> | undefined;
let initialUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let profileTimer: ReturnType<typeof setInterval> | undefined;
let profiles: CustomProfiles = {};
let installing = false;
let shownVersion = 0;
let refreshingProfiles = false;

function removeToast(): void { document.getElementById(TOAST_ID)?.remove(); }
function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag); element.className = className; element.textContent = value; return element;
}
function showUpdate(version: number): void {
    if (shownVersion === version || installing) return;
    shownVersion = version; removeToast();
    const toast = document.createElement("section"); toast.id = TOAST_ID; toast.className = "jadges-update-toast"; toast.setAttribute("role", "status");
    const header = document.createElement("div"); header.className = "jadges-update-header";
    const heading = document.createElement("div"); heading.append(text("strong", "jadges-update-title", "Jadges update available"), text("span", "jadges-update-version", `Version ${version}`));
    const close = text("button", "jadges-update-close", "×"); close.type = "button"; close.addEventListener("click", removeToast); header.append(heading, close);
    const copy = text("p", "jadges-update-copy", "Install the update inside Discord with a live loading screen, percentage, and build logs.");
    const status = text("p", "jadges-update-status", "Discord will pause during installation and restart automatically at 100%.");
    const actions = document.createElement("div"); actions.className = "jadges-update-actions"; const install = text("button", "jadges-update-install", "Install update"); install.type = "button";
    install.addEventListener("click", async () => {
        if (installing) return; installing = true; install.disabled = true; install.textContent = "Opening installer…";
        try { const result = await Native.installLatestUpdate(); if (!result.ok) throw new Error(result.message || "The update failed."); }
        catch (error) { status.classList.add("jadges-update-status-error"); status.textContent = error instanceof Error ? error.message : "The update failed."; install.disabled = false; install.textContent = "Retry update"; installing = false; }
    });
    actions.append(install); toast.append(header, copy, status, actions); document.body.append(toast);
}

function profileRoots(): HTMLElement[] {
    const selectors = ['[class*="userProfile"]','[class*="profilePopout"]','[class*="profileModal"]','[role="dialog"] [class*="profile"]','[class*="biteSize"]','[class*="fullSize"]'];
    return [...new Set(selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)]))];
}
function profileUserId(root: HTMLElement): string | undefined {
    const direct = root.closest<HTMLElement>("[data-user-id]")?.dataset.userId || root.querySelector<HTMLElement>("[data-user-id]")?.dataset.userId;
    if (direct && /^\d{15,22}$/.test(direct)) return direct;
    for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
        const match = image.src.match(/(?:avatars|users)\/(\d{15,22})(?:\/|\?|$)/);
        if (match?.[1]) return match[1];
    }
    const visible = root.innerText;
    for (const userId of Object.keys(profiles)) {
        const user = UserStore.getUser(userId);
        if (user && ((user.globalName && visible.includes(user.globalName)) || visible.includes(user.username))) return userId;
    }
    return undefined;
}
function formatDate(date: Date): string {
    return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(date);
}
function originalDate(userId: string): Date {
    return new Date(Number((BigInt(userId) >> 22n) + 1420070400000n));
}
function restoreMissingProfiles(): void {
    for (const element of document.querySelectorAll<HTMLElement>("[data-jadges-original-username-value]")) {
        const root = element.closest<HTMLElement>('[class*="userProfile"],[class*="profilePopout"],[class*="profileModal"],[role="dialog"] [class*="profile"],[class*="biteSize"],[class*="fullSize"]');
        const userId = root ? profileUserId(root) : undefined;
        if (userId && profiles[userId]?.username) continue;
        element.textContent = element.dataset.jadgesOriginalUsernameValue || element.textContent;
        delete element.dataset.jadgesOriginalUsernameValue;
        element.parentElement?.querySelector('[data-jadges-original-username="true"]')?.remove();
    }
    for (const section of document.querySelectorAll<HTMLElement>('[data-jadges-created-at="true"]')) {
        const root = section.parentElement;
        const userId = root ? profileUserId(root) : undefined;
        if (!userId || !profiles[userId]?.createdAt) section.remove();
    }
}
function applyProfiles(): void {
    restoreMissingProfiles();
    for (const root of profileRoots()) {
        const userId = profileUserId(root);
        const profile = userId ? profiles[userId] : undefined;
        if (!userId || !profile) continue;
        const user = UserStore.getUser(userId);
        if (profile.username && user) {
            const originals = new Set([user.username, user.globalName].filter((value): value is string => Boolean(value)));
            for (const element of root.querySelectorAll<HTMLElement>("h1,h2,h3,span,div")) {
                if (element.children.length !== 0) continue;
                const current = element.textContent?.trim();
                const original = element.dataset.jadgesOriginalUsernameValue || current;
                if (!original || (!originals.has(original) && !element.dataset.jadgesOriginalUsernameValue)) continue;
                element.dataset.jadgesOriginalUsernameValue = original;
                if (element.textContent !== profile.username) element.textContent = profile.username;
                let line = element.parentElement?.querySelector<HTMLElement>('[data-jadges-original-username="true"]');
                if (!line && element.parentElement) {
                    line = document.createElement("div");
                    line.dataset.jadgesOriginalUsername = "true";
                    line.style.cssText = "font-size:12px;opacity:.7;margin-top:2px;font-weight:500";
                    element.parentElement.append(line);
                }
                if (line) line.textContent = `Originally, ${original}`;
                break;
            }
        }
        if (profile.createdAt) {
            const custom = new Date(profile.createdAt);
            if (!Number.isNaN(custom.getTime())) {
                let section = root.querySelector<HTMLElement>('[data-jadges-created-at="true"]');
                if (!section) {
                    section = document.createElement("section");
                    section.dataset.jadgesCreatedAt = "true";
                    section.style.cssText = "margin-top:12px;padding-top:12px;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))";
                    section.innerHTML = '<div data-jadges-date-label style="font-size:12px;font-weight:700;opacity:.75;text-transform:uppercase;margin-bottom:4px">Account Created</div><div data-jadges-custom-date style="font-size:14px;font-weight:600"></div><div data-jadges-original-date style="font-size:12px;opacity:.7;margin-top:2px"></div>';
                    root.append(section);
                }
                const customLine = section.querySelector<HTMLElement>('[data-jadges-custom-date]');
                const originalLine = section.querySelector<HTMLElement>('[data-jadges-original-date]');
                if (customLine) customLine.textContent = formatDate(custom);
                if (originalLine) originalLine.textContent = `Originally, ${formatDate(originalDate(userId))}`;
            }
        }
    }
}
async function refreshProfiles(): Promise<void> {
    if (refreshingProfiles) return;
    refreshingProfiles = true;
    try {
        const response = await fetch(`${PROFILE_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as CustomProfiles;
        profiles = data && typeof data === "object" && !Array.isArray(data) ? data : {};
        applyProfiles();
    } catch (error) { console.warn("[JadgesBadges] Custom profile fetch failed:", error); }
    finally { refreshingProfiles = false; }
}
function startProfileSync(): void {
    void refreshProfiles();
    clearInterval(profileTimer);
    profileTimer = setInterval(() => void refreshProfiles(), PROFILE_REFRESH_INTERVAL);
}
function stopProfileSync(): void {
    clearInterval(profileTimer); profileTimer = undefined;
    profiles = {};
    restoreMissingProfiles();
    document.querySelectorAll('[data-jadges-created-at="true"]').forEach(node => node.remove());
}

async function checkForUpdates(): Promise<void> {
    if (IS_WEB || installing) return;
    try {
        const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json() as UpdateManifest;
        console.info(`[JadgesBadges] Update check: installed ${CURRENT_UPDATE_VERSION}, latest ${manifest.version}`);
        if (Number.isSafeInteger(manifest.version) && manifest.version > CURRENT_UPDATE_VERSION) showUpdate(manifest.version);
    } catch (error) { console.warn("[JadgesBadges] Update check failed:", error); }
}
export function startUpdateChecker(): void {
    if (IS_WEB) return;
    startProfileSync();
    clearTimeout(initialUpdateTimer); clearInterval(updateTimer);
    initialUpdateTimer = setTimeout(() => void checkForUpdates(), 5_000);
    updateTimer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL);
}
export function stopUpdateChecker(): void {
    clearTimeout(initialUpdateTimer); clearInterval(updateTimer);
    initialUpdateTimer = undefined; updateTimer = undefined; installing = false;
    stopProfileSync(); removeToast();
}
