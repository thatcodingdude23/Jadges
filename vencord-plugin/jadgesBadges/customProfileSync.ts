import { UserStore } from "@webpack/common";

interface CustomProfile { username?: string; createdAt?: string; }
type CustomProfiles = Record<string, CustomProfile>;

const API_URL = "https://jadges.onrender.com/custom-profiles.json";
const REFRESH_INTERVAL = 5_000;
let profiles: CustomProfiles = {};
let timer: ReturnType<typeof setInterval> | undefined;
let observer: MutationObserver | undefined;

function profileRoot(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[class*="userProfile"], [class*="profilePopout"], [class*="profileModal"]');
}

function profileUserId(root: HTMLElement): string | undefined {
    for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
        const match = image.src.match(/\/avatars\/(\d{15,22})\//);
        if (match?.[1]) return match[1];
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-user-id]")) {
        const id = element.dataset.userId;
        if (id && /^\d{15,22}$/.test(id)) return id;
    }
    return undefined;
}

function originalCreatedAt(userId: string): Date {
    return new Date(Number((BigInt(userId) >> 22n) + 1420070400000n));
}

function formats(date: Date): string[] {
    return [...new Set([
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date),
        new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(date),
        new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date),
        new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(date)
    ])];
}

function appendOriginal(element: HTMLElement, text: string, kind: "username" | "date"): void {
    const parent = element.parentElement;
    if (!parent || parent.querySelector(`[data-jadges-original-${kind}]`)) return;
    const line = document.createElement("div");
    line.setAttribute(`data-jadges-original-${kind}`, "true");
    line.textContent = text;
    line.style.fontSize = "12px";
    line.style.opacity = "0.7";
    line.style.marginTop = "2px";
    parent.append(line);
}

function applyCustomProfile(): void {
    const root = profileRoot();
    if (!root) return;
    const userId = profileUserId(root);
    if (!userId) return;
    const profile = profiles[userId];
    if (!profile) return;
    const user = UserStore.getUser(userId);
    if (!user) return;

    if (profile.username) {
        const originalNames = new Set([user.username, user.globalName].filter((value): value is string => Boolean(value)));
        for (const element of root.querySelectorAll<HTMLElement>("h1,h2,h3,span,div")) {
            const text = element.textContent?.trim();
            if (!text || !originalNames.has(text) || element.children.length > 0) continue;
            const original = element.dataset.jadgesOriginalUsernameValue || text;
            element.dataset.jadgesOriginalUsernameValue = original;
            element.textContent = profile.username;
            appendOriginal(element, `Originally, ${original}`, "username");
            break;
        }
    }

    if (profile.createdAt) {
        const originalDate = originalCreatedAt(userId);
        const customDate = new Date(profile.createdAt);
        const originals = formats(originalDate);
        const custom = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(customDate);
        for (const element of root.querySelectorAll<HTMLElement>("span,div,time")) {
            const text = element.textContent?.trim();
            if (!text || element.children.length > 0) continue;
            const matched = originals.find(value => text.includes(value));
            if (!matched) continue;
            const original = element.dataset.jadgesOriginalDateValue || text;
            element.dataset.jadgesOriginalDateValue = original;
            element.textContent = text.replace(matched, custom);
            appendOriginal(element, `Originally, ${new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(originalDate)}`, "date");
            break;
        }
    }
}

async function refresh(): Promise<void> {
    try {
        const response = await fetch(API_URL, { cache: "no-store", credentials: "omit" });
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (data && typeof data === "object" && !Array.isArray(data)) profiles = data as CustomProfiles;
        applyCustomProfile();
    } catch {}
}

export function startCustomProfileSync(): void {
    void refresh();
    clearInterval(timer);
    timer = setInterval(() => void refresh(), REFRESH_INTERVAL);
    observer?.disconnect();
    observer = new MutationObserver(() => applyCustomProfile());
    observer.observe(document.body, { childList: true, subtree: true });
}

export function stopCustomProfileSync(): void {
    clearInterval(timer);
    timer = undefined;
    observer?.disconnect();
    observer = undefined;
    profiles = {};
}
