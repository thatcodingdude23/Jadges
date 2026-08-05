import { UserStore } from "@webpack/common";

interface CustomProfile { username?: string; createdAt?: string; }
type CustomProfiles = Record<string, CustomProfile>;

const API_URL = "https://jadges.onrender.com/custom-profiles.json";
const REFRESH_INTERVAL = 5_000;
let profiles: CustomProfiles = {};
let timer: ReturnType<typeof setInterval> | undefined;
let observer: MutationObserver | undefined;

function roots(): HTMLElement[] {
    const selectors = [
        '[class*="userProfile"]', '[class*="profilePopout"]', '[class*="profileModal"]',
        '[role="dialog"] [class*="profile"]', '[class*="biteSize"]', '[class*="fullSize"]'
    ];
    return [...new Set(selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)]))];
}

function idFromRoot(root: HTMLElement): string | undefined {
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
        if (!user) continue;
        if ((user.globalName && visible.includes(user.globalName)) || visible.includes(user.username)) return userId;
    }
    return undefined;
}

function snowflakeDate(userId: string): Date {
    return new Date(Number((BigInt(userId) >> 22n) + 1420070400000n));
}

function formatDate(date: Date): string {
    return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(date);
}

function leafElements(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("h1,h2,h3,span,div,time")]
        .filter(element => element.children.length === 0 && Boolean(element.textContent?.trim()));
}

function addOriginalName(element: HTMLElement, original: string): void {
    const parent = element.parentElement;
    if (!parent || parent.querySelector('[data-jadges-original-username="true"]')) return;
    const line = document.createElement("div");
    line.dataset.jadgesOriginalUsername = "true";
    line.textContent = `Originally, ${original}`;
    line.style.cssText = "font-size:12px;opacity:.7;margin-top:2px;font-weight:500";
    parent.append(line);
}

function applyName(root: HTMLElement, userId: string, profile: CustomProfile): boolean {
    if (!profile.username) return false;
    const user = UserStore.getUser(userId);
    if (!user) return false;
    const originals = new Set([user.username, user.globalName].filter((value): value is string => Boolean(value)));
    let changed = false;

    for (const element of leafElements(root)) {
        const text = element.textContent?.trim();
        if (!text || !originals.has(text)) continue;
        const original = element.dataset.jadgesOriginalUsernameValue || text;
        element.dataset.jadgesOriginalUsernameValue = original;
        element.textContent = profile.username;
        addOriginalName(element, original);
        changed = true;
    }
    return changed;
}

function applyCreatedAt(root: HTMLElement, userId: string, profile: CustomProfile): boolean {
    if (!profile.createdAt) return false;
    const marker = root.querySelector<HTMLElement>('[data-jadges-created-at="true"]');
    const original = formatDate(snowflakeDate(userId));
    const custom = formatDate(new Date(profile.createdAt));

    if (marker) {
        marker.querySelector<HTMLElement>('[data-jadges-custom-date]')!.textContent = custom;
        marker.querySelector<HTMLElement>('[data-jadges-original-date]')!.textContent = `Originally, ${original}`;
        return true;
    }

    const section = document.createElement("section");
    section.dataset.jadgesCreatedAt = "true";
    section.style.cssText = "margin-top:12px;padding-top:12px;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))";
    const label = document.createElement("div");
    label.textContent = "Account Created";
    label.style.cssText = "font-size:12px;font-weight:700;opacity:.75;text-transform:uppercase;margin-bottom:4px";
    const value = document.createElement("div");
    value.dataset.jadgesCustomDate = "true";
    value.textContent = custom;
    value.style.cssText = "font-size:14px;font-weight:600";
    const originalLine = document.createElement("div");
    originalLine.dataset.jadgesOriginalDate = "true";
    originalLine.textContent = `Originally, ${original}`;
    originalLine.style.cssText = "font-size:12px;opacity:.7;margin-top:2px";
    section.append(label, value, originalLine);
    root.append(section);
    return true;
}

function applyAll(): void {
    let applied = 0;
    for (const root of roots()) {
        const userId = idFromRoot(root);
        if (!userId) continue;
        const profile = profiles[userId];
        if (!profile) continue;
        if (applyName(root, userId, profile) || applyCreatedAt(root, userId, profile)) applied++;
        else applyCreatedAt(root, userId, profile);
    }
    if (applied) console.info(`[JadgesBadges] Applied custom profile to ${applied} profile view(s)`);
}

async function refresh(): Promise<void> {
    try {
        const response = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid profile data");
        profiles = data as CustomProfiles;
        console.info(`[JadgesBadges] Loaded ${Object.keys(profiles).length} custom profile(s)`);
        applyAll();
    } catch (error) {
        console.warn("[JadgesBadges] Custom profile fetch failed:", error);
    }
}

export function startCustomProfileSync(): void {
    void refresh();
    clearInterval(timer);
    timer = setInterval(() => void refresh(), REFRESH_INTERVAL);
    observer?.disconnect();
    observer = new MutationObserver(() => queueMicrotask(applyAll));
    observer.observe(document.body, { childList: true, subtree: true });
}

export function stopCustomProfileSync(): void {
    clearInterval(timer);
    timer = undefined;
    observer?.disconnect();
    observer = undefined;
    profiles = {};
}
