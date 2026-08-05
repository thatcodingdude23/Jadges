import { PluginNative } from "@utils/types";
import { UserStore } from "@webpack/common";

const CURRENT_UPDATE_VERSION = 43;
const UPDATE_MANIFEST_URL = "https://jadges.onrender.com/vencord-update.json";
const PROFILE_URL = "https://jadges.onrender.com/custom-profiles.json";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;
const PROFILE_REFRESH_INTERVAL = 1_000;
const TOAST_ID = "jadges-update-toast";
const DISPLAY_NAME_SELECTOR = 'span[data-username-with-effects]';
const USER_TAG_SELECTOR = 'span[class*="userTagUsername_"]';
const MEMBER_SECTION_SELECTOR = 'section[class*="section_"]';
const PROFILE_ROOT_SELECTOR = '[class*="userProfile"],[class*="profilePopout"],[class*="profileModal"],[role="dialog"],[class*="biteSize"],[class*="fullSize"]';

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
function makeText<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
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
    const header = document.createElement("div");
    header.className = "jadges-update-header";
    const heading = document.createElement("div");
    heading.append(makeText("strong", "jadges-update-title", "Jadges update available"), makeText("span", "jadges-update-version", `Version ${version}`));
    const close = makeText("button", "jadges-update-close", "×");
    close.type = "button";
    close.onclick = removeToast;
    header.append(heading, close);
    const status = makeText("p", "jadges-update-status", "Discord will restart after installation.");
    const actions = document.createElement("div");
    actions.className = "jadges-update-actions";
    const install = makeText("button", "jadges-update-install", "Install update");
    install.type = "button";
    install.onclick = async () => {
        if (installing) return;
        installing = true;
        install.disabled = true;
        install.textContent = "Opening installer…";
        try {
            const result = await Native.installLatestUpdate();
            if (!result.ok) throw new Error(result.message || "The update failed.");
        } catch (error) {
            status.textContent = error instanceof Error ? error.message : "The update failed.";
            install.disabled = false;
            install.textContent = "Retry update";
            installing = false;
        }
    };
    actions.append(install);
    toast.append(header, status, actions);
    document.body.append(toast);
}

function profileRoot(element: Element): HTMLElement | null {
    return element.closest<HTMLElement>(PROFILE_ROOT_SELECTOR);
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
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}
function originalDate(userId: string): Date {
    return new Date(Number((BigInt(userId) >> 22n) + 1420070400000n));
}

function displayNameRow(target: HTMLElement): HTMLElement | null {
    return target.parentElement;
}
function originalNameHost(target: HTMLElement): HTMLElement | null {
    return displayNameRow(target)?.parentElement || null;
}
function ensureOriginalNameLine(target: HTMLElement, original: string): void {
    const row = displayNameRow(target);
    const host = originalNameHost(target);
    if (!row || !host) return;

    let line = host.querySelector<HTMLElement>(":scope > [data-jadges-original-name]");
    if (!line) {
        target.parentElement?.querySelectorAll('[data-jadges-original-name]').forEach(node => node.remove());
        line = document.createElement("div");
        line.dataset.jadgesOriginalName = "true";
        line.style.cssText = "display:block;position:static;width:100%;font-size:12px;line-height:16px;opacity:.7;margin-top:2px;font-weight:500;pointer-events:none";
        row.insertAdjacentElement("afterend", line);
    }
    line.textContent = `Originally, ${original}`;
}
function removeOriginalNameLine(target: HTMLElement): void {
    originalNameHost(target)?.querySelector(":scope > [data-jadges-original-name]")?.remove();
    target.parentElement?.querySelectorAll('[data-jadges-original-name]').forEach(node => node.remove());
}
function ensureOriginalDateLine(target: HTMLElement, original: string): void {
    const host = target.parentElement;
    if (!host) return;
    let line = host.querySelector<HTMLElement>(":scope > [data-jadges-original-date]");
    if (!line) {
        line = document.createElement("div");
        line.dataset.jadgesOriginalDate = "true";
        line.style.cssText = "display:block;position:static;width:100%;font-size:12px;line-height:16px;opacity:.7;margin-top:2px;font-weight:500;pointer-events:none";
        target.insertAdjacentElement("afterend", line);
    }
    line.textContent = `Originally, ${original}`;
}
function restoreDisplayName(target: HTMLElement): void {
    const original = target.dataset.jadgesOriginalDisplayName;
    if (!original) return;
    target.textContent = original;
    target.setAttribute("data-username-with-effects", original);
    delete target.dataset.jadgesOriginalDisplayName;
    removeOriginalNameLine(target);
}
function restoreUserTag(target: HTMLElement): void {
    const original = target.dataset.jadgesOriginalUserTag;
    if (!original) return;
    target.textContent = original;
    delete target.dataset.jadgesOriginalUserTag;
}
function exactMemberSinceDate(section: HTMLElement): HTMLElement | undefined {
    const heading = section.querySelector("h2");
    if (heading?.textContent?.trim().toLowerCase() !== "member since") return undefined;
    const headingContainer = section.querySelector<HTMLElement>('[class*="headings_"]');
    return [...section.children].find((child): child is HTMLElement => child instanceof HTMLElement && child !== headingContainer && !child.querySelector("h2"));
}
function restoreDate(target: HTMLElement): void {
    const original = target.dataset.jadgesOriginalMemberSince;
    if (!original) return;
    target.textContent = original;
    delete target.dataset.jadgesOriginalMemberSince;
    target.parentElement?.querySelector(':scope > [data-jadges-original-date]')?.remove();
}
function cleanupOldBlocks(root: HTMLElement): void {
    root.querySelectorAll('[data-jadges-created-at="true"],[data-jadges-original-username="true"]').forEach(node => node.remove());
}

function applyProfiles(): void {
    for (const displayTarget of document.querySelectorAll<HTMLElement>(DISPLAY_NAME_SELECTOR)) {
        const root = profileRoot(displayTarget);
        if (!root) continue;
        cleanupOldBlocks(root);
        const userId = profileUserId(root);
        if (!userId) continue;
        const profile = profiles[userId];
        if (!profile?.username) {
            restoreDisplayName(displayTarget);
            root.querySelectorAll<HTMLElement>(USER_TAG_SELECTOR).forEach(restoreUserTag);
            continue;
        }

        const realUser = UserStore.getUser(userId);
        const originalDisplayName = displayTarget.dataset.jadgesOriginalDisplayName
            || displayTarget.getAttribute("data-username-with-effects")
            || displayTarget.textContent?.trim()
            || realUser?.globalName
            || realUser?.username;
        if (!originalDisplayName) continue;

        displayTarget.dataset.jadgesOriginalDisplayName = originalDisplayName;
        displayTarget.textContent = profile.username;
        displayTarget.setAttribute("data-username-with-effects", profile.username);
        ensureOriginalNameLine(displayTarget, originalDisplayName);

        for (const userTag of root.querySelectorAll<HTMLElement>(USER_TAG_SELECTOR)) {
            const originalTag = userTag.dataset.jadgesOriginalUserTag || userTag.textContent?.trim() || realUser?.username;
            if (!originalTag) continue;
            userTag.dataset.jadgesOriginalUserTag = originalTag;
            userTag.textContent = profile.username;
        }
    }

    for (const section of document.querySelectorAll<HTMLElement>(MEMBER_SECTION_SELECTOR)) {
        const target = exactMemberSinceDate(section);
        if (!target) continue;
        const root = profileRoot(section);
        if (!root) continue;
        const userId = profileUserId(root);
        if (!userId) continue;
        const profile = profiles[userId];
        if (!profile?.createdAt) {
            restoreDate(target);
            continue;
        }
        const custom = new Date(profile.createdAt);
        if (Number.isNaN(custom.getTime())) continue;
        const original = target.dataset.jadgesOriginalMemberSince || target.textContent?.trim() || formatDate(originalDate(userId));
        target.dataset.jadgesOriginalMemberSince = original;
        target.textContent = formatDate(custom);
        ensureOriginalDateLine(target, original);
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
    document.querySelectorAll<HTMLElement>(DISPLAY_NAME_SELECTOR).forEach(restoreDisplayName);
    document.querySelectorAll<HTMLElement>(USER_TAG_SELECTOR).forEach(restoreUserTag);
    document.querySelectorAll<HTMLElement>(MEMBER_SECTION_SELECTOR).forEach(section => {
        const date = exactMemberSinceDate(section);
        if (date) restoreDate(date);
    });
}
async function checkForUpdates(): Promise<void> {
    if (IS_WEB || installing) return;
    try {
        const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json() as UpdateManifest;
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
