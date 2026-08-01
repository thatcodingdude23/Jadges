import { Settings } from "@api/Settings";
import { findByCodeLazy, findStoreLazy } from "@webpack";
import { ThemeStore, UserStore } from "@webpack/common";

type ThemeMode = "dark" | "light";

interface AccountTheme {
    enabled: boolean;
    mode: ThemeMode;
    colors: string[];
    angle: number;
    intensity: number;
    updatedAt?: string;
}

interface NitroThemeStoreLike {
    gradientPreset?: unknown;
}

type SettingsFeed = Record<string, { theme?: Partial<AccountTheme>; }>;

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;
const THEME_MARKER = "jadges-account-theme=1";
const LEGACY_STYLE_ID = "jadges-account-theme-style";
const LEGACY_ROOT_ATTRIBUTE = "data-jadges-account-theme";
const HEX_COLOR = /^#[0-9A-F]{6}$/;
const saveDiscordTheme = findByCodeLazy(
    'type:"UNSYNCED_USER_SETTINGS_UPDATE',
    '"system"==='
) as ((settings: { theme: string; }) => void);
const NitroThemeStore = findStoreLazy("ClientThemesBackgroundStore") as NitroThemeStoreLike;

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastSignature = "";
let activeThemeLink: string | undefined;
let originalDiscordTheme: string | undefined;

function normalizeApiUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    return url || DEFAULT_API_URL;
}

function apiRoot(): string {
    return normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl)
        .replace(/\/badges\.json(?:\?.*)?$/, "");
}

function normalizeHex(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const upper = value.trim().toUpperCase();
    if (/^#[0-9A-F]{3}$/.test(upper)) {
        return `#${upper[1]}${upper[1]}${upper[2]}${upper[2]}${upper[3]}${upper[3]}`;
    }
    return HEX_COLOR.test(upper) ? upper : undefined;
}

function clamp(value: unknown, minimum: number, maximum: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return minimum;
    return Math.min(maximum, Math.max(minimum, numeric));
}

function normalizeTheme(value: unknown): AccountTheme | undefined {
    if (!value || typeof value !== "object") return undefined;
    const source = value as Partial<AccountTheme>;
    const colors = Array.isArray(source.colors)
        ? source.colors
            .map(normalizeHex)
            .filter((color): color is string => Boolean(color))
            .slice(0, 5)
        : [];

    if (!source.enabled || colors.length === 0) return undefined;
    return {
        enabled: true,
        mode: source.mode === "light" ? "light" : "dark",
        colors,
        angle: Math.round(clamp(source.angle, 0, 360)),
        intensity: Math.round(clamp(source.intensity, 0, 100)),
        ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {})
    };
}

function isJadgesThemeLink(value: string): boolean {
    return value.includes(THEME_MARKER);
}

function hasActiveNitroTheme(): boolean {
    return NitroThemeStore?.gradientPreset != null;
}

function setThemeLink(link: string | undefined): void {
    const existing = Array.isArray(Settings.themeLinks)
        ? Settings.themeLinks.filter((value: string) => typeof value === "string" && !isJadgesThemeLink(value))
        : [];
    const next = link ? [...existing, link] : existing;

    if (JSON.stringify(Settings.themeLinks) !== JSON.stringify(next)) {
        Settings.themeLinks = next;
    }
    activeThemeLink = link;
}

function buildThemeLink(userId: string, theme: AccountTheme): string {
    const version = encodeURIComponent(theme.updatedAt || JSON.stringify(theme));
    return `${apiRoot()}/themes/${encodeURIComponent(userId)}.css?${THEME_MARKER}&v=${version}`;
}

function setDiscordTheme(mode: ThemeMode): void {
    if (!originalDiscordTheme) originalDiscordTheme = ThemeStore.theme;

    // Re-saving the current Discord mode disables an active Nitro client theme.
    // Do not skip this call while ClientThemesBackgroundStore still has a gradient preset.
    if (ThemeStore.theme === mode && !hasActiveNitroTheme()) return;

    try {
        saveDiscordTheme({ theme: mode });
    } catch (error) {
        console.warn("[JadgesBadges] Could not replace Discord's Nitro theme:", error);
    }
}

function restoreDiscordTheme(): void {
    if (!originalDiscordTheme) return;
    const previous = originalDiscordTheme;
    originalDiscordTheme = undefined;
    if (ThemeStore.theme === previous) return;

    try {
        saveDiscordTheme({ theme: previous });
    } catch (error) {
        console.warn("[JadgesBadges] Could not restore Discord's previous theme mode:", error);
    }
}

function removeLegacyThemeInjection(): void {
    document.getElementById(LEGACY_STYLE_ID)?.remove();
    document.documentElement.removeAttribute(LEGACY_ROOT_ATTRIBUTE);
}

function applyTheme(userId: string, theme: AccountTheme): void {
    const signature = JSON.stringify(theme);
    const link = buildThemeLink(userId, theme);
    setDiscordTheme(theme.mode);

    if (signature === lastSignature && activeThemeLink === link) return;
    lastSignature = signature;
    setThemeLink(link);
}

function removeTheme(): void {
    lastSignature = "";
    setThemeLink(undefined);
    restoreDiscordTheme();
    removeLegacyThemeInjection();
}

async function refreshTheme(): Promise<void> {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    try {
        const response = await fetch(`${apiRoot()}/settings.json`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) throw new Error(`Jadges settings returned HTTP ${response.status}`);

        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new TypeError("Jadges settings returned an invalid response");
        }

        const theme = normalizeTheme((data as SettingsFeed)[userId]?.theme);
        if (theme) applyTheme(userId, theme);
        else removeTheme();
    } catch (error) {
        console.error("[JadgesBadges] Failed to synchronize the account theme:", error);
    }
}

export function startThemeSync(): void {
    clearInterval(refreshTimer);
    removeLegacyThemeInjection();
    void refreshTheme();
    refreshTimer = setInterval(() => void refreshTheme(), REFRESH_INTERVAL);
}

export function stopThemeSync(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    removeTheme();
}
