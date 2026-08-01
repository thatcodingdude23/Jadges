import { Settings } from "@api/Settings";
import { UserStore } from "@webpack/common";

type ThemeMode = "dark" | "light";

interface AccountTheme {
    enabled: boolean;
    mode: ThemeMode;
    colors: string[];
    angle: number;
    intensity: number;
    updatedAt?: string;
}

type SettingsFeed = Record<string, { theme?: Partial<AccountTheme>; }>;

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;
const STYLE_ID = "jadges-account-theme-style";
const ROOT_ATTRIBUTE = "data-jadges-account-theme";
const HEX_COLOR = /^#[0-9A-F]{6}$/;

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastSignature = "";
let styleElement: HTMLStyleElement | undefined;
let originalThemeClasses: {
    htmlDark: boolean;
    htmlLight: boolean;
    bodyDark: boolean;
    bodyLight: boolean;
    colorScheme: string;
} | undefined;

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

function gradient(theme: AccountTheme): string {
    const alpha = Math.max(0.04, theme.intensity / 100 * 0.46);
    const stops = theme.colors.map((color, index) => {
        const position = theme.colors.length === 1
            ? 50
            : Math.round(index * 100 / (theme.colors.length - 1));
        return `${rgba(color, alpha)} ${position}%`;
    });
    return `linear-gradient(${theme.angle}deg, ${stops.join(", ")})`;
}

function buildCss(theme: AccountTheme): string {
    const primary = theme.colors[0]!;
    const secondary = theme.colors[1] || primary;
    const tertiary = theme.colors[2] || secondary;
    const strength = theme.intensity / 100;
    const light = theme.mode === "light";

    const backgroundPrimary = mixHex(light ? "#FFFFFF" : "#111214", primary, strength * (light ? 0.12 : 0.24));
    const backgroundSecondary = mixHex(light ? "#F2F3F5" : "#1A1B1E", secondary, strength * (light ? 0.10 : 0.19));
    const backgroundTertiary = mixHex(light ? "#E3E5E8" : "#0B0C0E", tertiary, strength * (light ? 0.11 : 0.20));
    const backgroundFloating = mixHex(backgroundTertiary, primary, light ? 0.07 : 0.12);
    const backgroundAccent = mixHex(backgroundSecondary, primary, light ? 0.18 : 0.30);
    const modifierHover = mixHex(backgroundSecondary, primary, light ? 0.13 : 0.22);
    const modifierActive = mixHex(backgroundSecondary, primary, light ? 0.20 : 0.30);
    const modifierSelected = mixHex(backgroundSecondary, primary, light ? 0.25 : 0.38);
    const textNormal = light ? "#252830" : "#E8EAF0";
    const textMuted = light ? "#626A78" : "#9BA3B0";
    const headerPrimary = light ? "#17191F" : "#F4F5F7";
    const headerSecondary = light ? "#4E5663" : "#C5CAD3";
    const appGradient = gradient(theme);

    return `
html[${ROOT_ATTRIBUTE}="active"] {
    color-scheme: ${theme.mode} !important;
    --brand-experiment: ${primary} !important;
    --brand-experiment-100: ${mixHex("#FFFFFF", primary, 0.12)} !important;
    --brand-experiment-200: ${mixHex("#FFFFFF", primary, 0.28)} !important;
    --brand-experiment-300: ${mixHex("#FFFFFF", primary, 0.46)} !important;
    --brand-experiment-400: ${mixHex("#FFFFFF", primary, 0.68)} !important;
    --brand-experiment-500: ${primary} !important;
    --brand-experiment-560: ${mixHex(primary, "#000000", 0.14)} !important;
    --brand-experiment-600: ${mixHex(primary, "#000000", 0.24)} !important;
    --brand-260: ${secondary} !important;
    --brand-360: ${primary} !important;
    --brand-500: ${primary} !important;
    --brand-560: ${mixHex(primary, "#000000", 0.14)} !important;
    --text-normal: ${textNormal} !important;
    --text-muted: ${textMuted} !important;
    --text-link: ${primary} !important;
    --header-primary: ${headerPrimary} !important;
    --header-secondary: ${headerSecondary} !important;
    --interactive-normal: ${primary} !important;
    --interactive-hover: ${secondary} !important;
    --interactive-active: ${headerPrimary} !important;
    --interactive-muted: ${textMuted} !important;
    --channels-default: ${textMuted} !important;
    --channel-icon: ${primary} !important;
    --background-primary: ${backgroundPrimary} !important;
    --background-secondary: ${backgroundSecondary} !important;
    --background-secondary-alt: ${backgroundSecondary} !important;
    --background-tertiary: ${backgroundTertiary} !important;
    --background-floating: ${backgroundFloating} !important;
    --background-nested-floating: ${backgroundFloating} !important;
    --background-accent: ${backgroundAccent} !important;
    --background-mobile-primary: ${backgroundPrimary} !important;
    --background-mobile-secondary: ${backgroundSecondary} !important;
    --background-modifier-hover: ${modifierHover} !important;
    --background-modifier-active: ${modifierActive} !important;
    --background-modifier-selected: ${modifierSelected} !important;
    --background-modifier-accent: ${backgroundAccent} !important;
    --background-message-hover: ${modifierHover} !important;
    --background-mentioned: ${rgba(primary, 0.13)} !important;
    --bg-base-primary: ${backgroundPrimary} !important;
    --bg-base-secondary: ${backgroundSecondary} !important;
    --bg-base-tertiary: ${backgroundTertiary} !important;
    --bg-surface-overlay: ${backgroundFloating} !important;
    --bg-surface-raised: ${backgroundSecondary} !important;
    --background-base-low: ${backgroundPrimary} !important;
    --background-base-lower: ${backgroundSecondary} !important;
    --background-base-lowest: ${backgroundTertiary} !important;
    --background-surface-high: ${backgroundAccent} !important;
    --background-surface-higher: ${modifierSelected} !important;
    --chat-background: ${backgroundPrimary} !important;
    --chat-input-container-background: ${backgroundAccent} !important;
    --input-background: ${backgroundAccent} !important;
    --modal-background: ${backgroundSecondary} !important;
    --modal-footer-background: ${backgroundTertiary} !important;
    --card-primary-bg: ${backgroundPrimary} !important;
    --card-secondary-bg: ${backgroundSecondary} !important;
    --jadges-account-gradient: ${appGradient};
}

html[${ROOT_ATTRIBUTE}="active"] body,
html[${ROOT_ATTRIBUTE}="active"] #app-mount,
html[${ROOT_ATTRIBUTE}="active"] [class*="appMount"] {
    background: var(--jadges-account-gradient), ${backgroundPrimary} !important;
}

html[${ROOT_ATTRIBUTE}="active"] [class*="appAsidePanelWrapper"],
html[${ROOT_ATTRIBUTE}="active"] [class*="layers"],
html[${ROOT_ATTRIBUTE}="active"] [class*="baseLayer"] {
    background: transparent !important;
}

html[${ROOT_ATTRIBUTE}="active"] [class*="guilds"],
html[${ROOT_ATTRIBUTE}="active"] [class*="sidebar"],
html[${ROOT_ATTRIBUTE}="active"] [class*="panels"],
html[${ROOT_ATTRIBUTE}="active"] [class*="membersWrap"] {
    background-color: color-mix(in srgb, ${backgroundTertiary} 91%, transparent) !important;
}

html[${ROOT_ATTRIBUTE}="active"] [class*="chatContent"],
html[${ROOT_ATTRIBUTE}="active"] [class*="contentRegion"],
html[${ROOT_ATTRIBUTE}="active"] [class*="standardSidebarView"] {
    background-color: color-mix(in srgb, ${backgroundPrimary} 88%, transparent) !important;
}

html[${ROOT_ATTRIBUTE}="active"] [class*="channelTextArea"],
html[${ROOT_ATTRIBUTE}="active"] [class*="searchBar"],
html[${ROOT_ATTRIBUTE}="active"] [class*="input"] {
    background-color: color-mix(in srgb, ${backgroundAccent} 92%, transparent) !important;
}
`;
}

function captureOriginalTheme(): void {
    if (originalThemeClasses) return;
    originalThemeClasses = {
        htmlDark: document.documentElement.classList.contains("theme-dark"),
        htmlLight: document.documentElement.classList.contains("theme-light"),
        bodyDark: document.body?.classList.contains("theme-dark") ?? false,
        bodyLight: document.body?.classList.contains("theme-light") ?? false,
        colorScheme: document.documentElement.style.colorScheme
    };
}

function setThemeMode(mode: ThemeMode): void {
    captureOriginalTheme();
    const targets = [document.documentElement, document.body].filter(Boolean) as HTMLElement[];
    for (const target of targets) {
        target.classList.toggle("theme-dark", mode === "dark");
        target.classList.toggle("theme-light", mode === "light");
    }
    document.documentElement.style.colorScheme = mode;
}

function applyTheme(theme: AccountTheme): void {
    const signature = JSON.stringify(theme);
    setThemeMode(theme.mode);
    document.documentElement.setAttribute(ROOT_ATTRIBUTE, "active");

    if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.id = STYLE_ID;
        document.head.append(styleElement);
    }

    if (signature === lastSignature) return;
    lastSignature = signature;
    styleElement.textContent = buildCss(theme);
}

function restoreOriginalTheme(): void {
    document.documentElement.removeAttribute(ROOT_ATTRIBUTE);
    styleElement?.remove();
    styleElement = undefined;
    lastSignature = "";

    if (!originalThemeClasses) return;
    document.documentElement.classList.toggle("theme-dark", originalThemeClasses.htmlDark);
    document.documentElement.classList.toggle("theme-light", originalThemeClasses.htmlLight);
    if (document.body) {
        document.body.classList.toggle("theme-dark", originalThemeClasses.bodyDark);
        document.body.classList.toggle("theme-light", originalThemeClasses.bodyLight);
    }
    document.documentElement.style.colorScheme = originalThemeClasses.colorScheme;
    originalThemeClasses = undefined;
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
        if (theme) applyTheme(theme);
        else restoreOriginalTheme();
    } catch (error) {
        console.error("[JadgesBadges] Failed to synchronize the account theme:", error);
    }
}

export function startThemeSync(): void {
    clearInterval(refreshTimer);
    void refreshTheme();
    refreshTimer = setInterval(() => void refreshTheme(), REFRESH_INTERVAL);
}

export function stopThemeSync(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    restoreOriginalTheme();
}
