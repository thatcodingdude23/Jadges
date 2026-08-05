import { PluginNative } from "@utils/types";
import { UserStore } from "@webpack/common";

const CURRENT_UPDATE_VERSION = 38;
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
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
}
function showUpdate(version: number): void {
    if (shownVersion === version || installing) return;
    shownVersion = version;
    removeToast();
    const toast = document.createElement("section");
    toast.id = TOAST_ID;
    toast.className = "jadges-update-toast";
    toast.setAttribute("role", "status");
    const header = document.createElement("div");
    header.className = "jadges-update-header";
    const heading = document.createElement("div");
    heading.append(text("strong", "jadges-update-title", "Jadges update available"), text("span", "jadges-update-version", `Version ${version}`));
    const close = text("button", "jadges-update-close", "×");
    close.type = "button";
    close.addEventListener("click", removeToast);
    header.append(heading, close);
    const copy = text("p", "jadges-update-copy", "Install the update inside Discord with a live loading screen, percentage, and build logs.");
    const status = text("p", "jadges-update-status", "Discord will pause during installation and restart automatically at 100%.");
    const actions = document.createElement("div");
    actions.className = "jadges-update-actions";
    const install = text("button", "jadges-update-install", "Install update");
    install.type = "button";
    install.addEventListener("click", async () => {
        if (installing) return;
        installing = true;
        install.disabled = true;
        install.textContent = "Opening installer…";
        try {
            const result = await Native.installLatestUpdate();
            if (!result.ok) throw new Error(result.message || "The update failed.");
        } catch (error) {
            status.classList.add("jadges-update-status-error");
            status.textContent = error instanceof Error ? error.message : "The update failed.";
            install.disabled = false;
            install.textContent = "Retry update";
            installing = false;
        }
    });
    actions.append(install);
    toast.append(header, copy, status, actions);
    document.body.append(toast);
}

const ROOT_SELECTOR = '[class*="userProfile"],[class*="profilePopout"],[class*="profileModal"],[role="dialog"] [class*="profile"],[class*="biteSize"],[class*="fullSize"]';

function profileRoots(): HTMLElement[] {
    return [...new Set([...document.querySelectorAll<HTMLElement>(ROOT_SELECTOR)])];
}
function profileUserId(root: HTMLElement): string | undefined {
    const direct = root.closest<HTMLElement>("[data-user-id]")?.dataset.userId
        || root.querySelector<HTMLElement>("[data-user-id]")?.dataset.userId;
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
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}
function originalDate(userId: string): Date {
    return new Date(Number((BigInt(userId) >> 22n) + 1420070400000n));
}
function leaves(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("h1,h2,h3,span,div,time")]
        .filter(element => element.children.length === 0 && Boolean(element.textContent?.trim()));
}
function originalLine(after: HTMLElement, kind: "name" | "date"): HTMLElement {
    const selector = kind === "name" ? '[data-jadges-original-name]' : '[data-jadges-original-date]';
    let line = after.parentElement?.querySelector<HTMLElement>(selector);
    if (!line) {
        line = document.createElement("div");
        if (kind === "name") line.dataset.jadgesOriginalName = "true";
        else line.dataset.jadgesOriginalDate = "true";
        line.style.cssText = "font-size:12px;opacity:.7;margin-top:2px;font-weight:500";
        after.insertAdjacentElement("afterend", line);
    }
    return line;
}
function removeOldInjectedBlocks(root: HTMLElement): void {
    root.querySelectorAll('[data-jadges-created-at="true"], [data-jadges-original-username="true"]').forEach(node => node.remove());
}
function restoreElement(element: HTMLElement, attribute: "jadgesOriginalNameValue" | "jadgesOriginalDateValue"): void {
    const original = element.dataset[attribute];
    if (original) element.textContent = original;
    delete element.dataset[attribute];
}
function restoreRoot(root: HTMLElement): void {
    for (const element of root.querySelectorAll<HTMLElement>("[data-jadges-original-name-value]")) restoreElement(element, "jadgesOriginalNameValue");
    for (const element of root.querySelectorAll<HTMLElement>("[data-jadges-original-date-value]")) restoreElement(element, "jadgesOriginalDateValue");
    root.querySelectorAll('[data-jadges-original-name], [data-jadges-original-date], [data-jadges-created-at="true"], [data-jadges-original-username="true"]').forEach(node => node.remove());
}
function findNameElement(root: HTMLElement, originals: Set<string>): HTMLElement | undefined {
    const candidates = leaves(root).filter(element => {
        if (element.closest("[data-jadges-original-name],[data-jadges-original-date]")) return false;
        const value = element.dataset.jadgesOriginalNameValue || element.textContent?.trim();
        return Boolean(value && originals.has(value));
    });
    return candidates.sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0];
}
function findMemberSinceDate(root: HTMLElement, userId: string): HTMLElement | undefined {
    const expected = formatDate(originalDate(userId));
    const all = leaves(root);
    const direct = all.find(element => {
        const value = element.dataset.jadgesOriginalDateValue || element.textContent?.trim();
        return value === expected;
    });
    if (direct) return direct;

    const label = all.find(element => /^member since$/i.test(element.textContent?.trim() || ""));
    if (!label) return undefined;
    let container: HTMLElement | null = label.parentElement;
    for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
        const candidate = leaves(container).find(element => element !== label && /\b(?:19|20)\d{2}\b/.test(element.textContent?.trim() || ""));
        if (candidate) return candidate;
    }
    return undefined;
}
function applyProfile(root: HTMLElement, userId: string, profile: CustomProfile): void {
    removeOldInjectedBlocks(root);
    const user = UserStore.getUser(userId);

    if (profile.username && user) {
        const originals = new Set([user.username, user.globalName].filter((value): value is string => Boolean(value)));
        const target = findNameElement(root, originals);
        if (target) {
            const original = target.dataset.jadgesOriginalNameValue || target.textContent?.trim() || user.username;
            target.dataset.jadgesOriginalNameValue = original;
            target.textContent = profile.username;
            originalLine(target, "name").textContent = `Originally, ${original}`;
        }
    }

    if (profile.createdAt) {
        const custom = new Date(profile.createdAt);
        const target = findMemberSinceDate(root, userId);
        if (!Number.isNaN(custom.getTime()) && target) {
            const original = target.dataset.jadgesOriginalDateValue || target.textContent?.trim() || formatDate(originalDate(userId));
            target.dataset.jadgesOriginalDateValue = original;
            target.textContent = formatDate(custom);
            originalLine(target, "date").textContent = `Originally, ${original}`;
        }
    }
}
function applyProfiles(): void {
    for (const root of profileRoots()) {
        const userId = profileUserId(root);
        const profile = userId ? profiles[userId] : undefined;
        if (!userId || !profile) {
            restoreRoot(root);
            continue;
        }
        applyProfile(root, userId, profile);
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
    } catch (error) {
        console.warn("[JadgesBadges] Custom profile fetch failed:", error);
    } finally {
        refreshingProfiles = false;
    }
}
function startProfileSync(): void {
    void refreshProfiles();
    clearInterval(profileTimer);
    profileTimer = setInterval(() => void refreshProfiles(), PROFILE_REFRESH_INTERVAL);
}
function stopProfileSync(): void {
    clearInterval(profileTimer);
    profileTimer = undefined;
    profiles = {};
    for (const root of profileRoots()) restoreRoot(root);
}

async function checkForUpdates(): Promise<void> {
    if (IS_WEB || installing) return;
    try {
        const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json() as UpdateManifest;
        console.info(`[JadgesBadges] Update check: installed ${CURRENT_UPDATE_VERSION}, latest ${manifest.version}`);
        if (Number.isSafeInteger(manifest.version) && manifest.version > CURRENT_UPDATE_VERSION) showUpdate(manifest.version);
    } catch (error) {
        console.warn("[JadgesBadges] Update check failed:", error);
    }
}
export function startUpdateChecker(): void {
    if (IS_WEB) return;
    startProfileSync();
    clearTimeout(initialUpdateTimer);
    clearInterval(updateTimer);
    initialUpdateTimer = setTimeout(() => void checkForUpdates(), 5_000);
    updateTimer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL);
}
export function stopUpdateChecker(): void {
    clearTimeout(initialUpdateTimer);
    clearInterval(updateTimer);
    initialUpdateTimer = undefined;
    updateTimer = undefined;
    installing = false;
    stopProfileSync();
    removeToast();
}
