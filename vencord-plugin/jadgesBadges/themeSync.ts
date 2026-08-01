import { Settings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import {
    createOrUpdateThemeColorVars,
    disableClientTheme,
    startClientTheme
} from "@plugins/clientTheme/utils/styleUtils";
import { createAndAppendStyle } from "@utils/css";
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
const EXTRA_STYLE_ID = "jadges-client-theme-extra";
const LEGACY_STYLE_ID = "jadges-account-theme-style";
const LEGACY_ROOT_ATTRIBUTE = "data-jadges-account-theme";
const HEX_COLOR = /^#[0-9A-F]{6}$/;

// This is the same Discord user-settings action used by Vencord's ClientTheme
// settings screen. Re-saving the base mode disables an active Nitro theme.
const saveDiscordTheme = findByCodeLazy(
    'type:"UNSYNCED_USER_SETTINGS_UPDATE',
    '"system"==='
) as ((settings: { theme: string; }) => void);
const NitroThemeStore = findStoreLazy("ClientThemesBackgroundStore") as NitroThemeStoreLike;

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let lastSignature = "";
let clientThemeStarted = false;
let extraStyle: HTMLStyleElement | undefined;
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

function parseRgb(hex: string): [number, number, number] {
    return [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16)
    ];
}

function rgbHex(red: number, green: number, blue: number): string {
    return `#${[red, green, blue]
        .map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0"))
        .join("")}`.toUpperCase();
}

function mixHex(base: string, tint: string, ratio: number): string {
    const [baseRed, baseGreen, baseBlue] = parseRgb(base);
    const [tintRed, tintGreen, tintBlue] = parseRgb(tint);
    const amount = Math.min(1, Math.max(0, ratio));
    return rgbHex(
        baseRed + (tintRed - baseRed) * amount,
        baseGreen + (tintGreen - baseGreen) * amount,
        baseBlue + (tintBlue - baseBlue) * amount
    );
}

function rgba(hex: string, alpha: number): string {
    const [red, green, blue] = parseRgb(hex);
    return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;
}

function effectiveClientThemeColor(theme: AccountTheme): string {
    const neutral = theme.mode === "light" ? "#F2F3F5" : "#313338";
    return mixHex(neutral, theme.colors[0]!, theme.intensity / 100).slice(1);
}

function gradient(theme: AccountTheme): string {
    const alpha = theme.intensity / 100 * 0.34;
    const stops = theme.colors.map((color, index) => {
        const position = theme.colors.length === 1
            ? 50
            : Math.round(index * 100 / (theme.colors.length - 1));
        return `${rgba(color, alpha)} ${position}%`;
    });
    return `linear-gradient(${theme.angle}deg, ${stops.join(", ")})`;
}

function extraCss(theme: AccountTheme): string {
    const primary = theme.colors[0]!;
    const secondary = theme.colors[1] || primary;
    const appGradient = gradient(theme);

    return `
:root {
    --brand-260: ${secondary} !important;
    --brand-360: ${primary} !important;
    --brand-500: ${primary} !important;
    --brand-560: ${mixHex(primary, "#000000", 0.14)} !important;
    --text-link: ${primary} !important;
    --text-brand: ${primary} !important;
    --jadges-client-gradient: ${appGradient};
}

html,
body,
#app-mount {
    background-image: var(--jadges-client-gradient) !important;
    background-color: var(--background-primary) !important;
    background-attachment: fixed !important;
}
`;
}

function removeLegacyThemeLink(): void {
    const links = Array.isArray(Settings.themeLinks) ? Settings.themeLinks : [];
    const cleaned = links.filter((value: string) =>
        typeof value === "string" && !value.includes(THEME_MARKER)
    );
    if (JSON.stringify(links) !== JSON.stringify(cleaned)) {
        Settings.themeLinks = cleaned;
    }

    document.getElementById(LEGACY_STYLE_ID)?.remove();
    document.documentElement.removeAttribute(LEGACY_ROOT_ATTRIBUTE);
}

function setDiscordTheme(mode: ThemeMode, force = false): void {
    if (!originalDiscordTheme) originalDiscordTheme = ThemeStore.theme;
    if (!force && ThemeStore.theme === mode) return;

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

function updateExtraStyle(theme: AccountTheme): void {
    extraStyle ??= createAndAppendStyle(EXTRA_STYLE_ID, managedStyleRootNode);
    extraStyle.textContent = extraCss(theme);
}

async function applyTheme(theme: AccountTheme): Promise<void> {
    const signature = JSON.stringify(theme);

    // If the user turns a Nitro theme back on while Jadges is active, clear it
    // immediately using the same action as Vencord's own ClientTheme plugin.
    if (signature === lastSignature) {
        if (NitroThemeStore?.gradientPreset != null) {
            setDiscordTheme(theme.mode, true);
        }
        return;
    }

    lastSignature = signature;
    removeLegacyThemeLink();

    // Always re-save the base mode for a newly applied Jadges theme. Discord
    // treats this as selecting Dark/Light and removes the active Nitro preset.
    setDiscordTheme(theme.mode, true);

    const color = effectiveClientThemeColor(theme);
    if (!clientThemeStarted) {
        await startClientTheme(color);
        clientThemeStarted = true;
    } else {
        createOrUpdateThemeColorVars(color);
    }
    updateExtraStyle(theme);
}

async function restoreVencordClientTheme(): Promise<void> {
    const clientTheme = Settings.plugins.ClientTheme;
    if (!clientTheme?.enabled || typeof clientTheme.color !== "string") return;

    const color = clientTheme.color.replace(/^#/, "");
    if (/^[0-9A-F]{6}$/i.test(color)) {
        await startClientTheme(color);
        clientThemeStarted = true;
    }
}

async function removeTheme(): Promise<void> {
    if (!lastSignature && !clientThemeStarted && !extraStyle) {
        removeLegacyThemeLink();
        return;
    }

    lastSignature = "";
    extraStyle?.remove();
    extraStyle = undefined;
    disableClientTheme();
    clientThemeStarted = false;
    removeLegacyThemeLink();
    restoreDiscordTheme();
    await restoreVencordClientTheme();
}

async function refreshTheme(): Promise<void> {
    if (refreshing) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    refreshing = true;
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
        if (theme) await applyTheme(theme);
        else await removeTheme();
    } catch (error) {
        console.error("[JadgesBadges] Failed to synchronize the account theme:", error);
    } finally {
        refreshing = false;
    }
}

export function startThemeSync(): void {
    clearInterval(refreshTimer);
    removeLegacyThemeLink();
    void refreshTheme();
    refreshTimer = setInterval(() => void refreshTheme(), REFRESH_INTERVAL);
}

export function stopThemeSync(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshing = false;
    void removeTheme();
}
