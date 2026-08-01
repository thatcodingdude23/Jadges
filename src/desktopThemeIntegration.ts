import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { readStore } from "./store.js";
import type { UserRecord } from "./types.js";

interface ThemeSettings {
  enabled: boolean;
  mode: "dark" | "light";
  colors: string[];
  angle: number;
  intensity: number;
  updatedAt?: string;
}

type ThemeUser = UserRecord & { theme?: ThemeSettings };

const DEFAULT_THEME: ThemeSettings = {
  enabled: false,
  mode: "dark",
  colors: ["#15059E", "#283CA8", "#0367FF"],
  angle: 45,
  intensity: 71,
};
const HEX_COLOR = /^#[0-9A-F]{6}$/;
let installed = false;

function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(upper)) {
    return `#${upper[1]}${upper[1]}${upper[2]}${upper[2]}${upper[3]}${upper[3]}`;
  }
  return HEX_COLOR.test(upper) ? upper : undefined;
}

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, numeric)));
}

function normalizeTheme(value: unknown): ThemeSettings {
  const source = value && typeof value === "object"
    ? value as Partial<ThemeSettings>
    : {};
  const colors = Array.isArray(source.colors)
    ? source.colors
        .map(normalizeHex)
        .filter((color): color is string => Boolean(color))
        .slice(0, 5)
    : [];

  return {
    enabled: source.enabled === true,
    mode: source.mode === "light" ? "light" : "dark",
    colors: colors.length > 0 ? colors : [...DEFAULT_THEME.colors],
    angle: clampInteger(source.angle ?? DEFAULT_THEME.angle, 0, 360),
    intensity: clampInteger(source.intensity ?? DEFAULT_THEME.intensity, 0, 100),
    ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {}),
  };
}

function parseRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function mixHex(base: string, tint: string, ratio: number): string {
  const [baseRed, baseGreen, baseBlue] = parseRgb(base);
  const [tintRed, tintGreen, tintBlue] = parseRgb(tint);
  const amount = Math.min(1, Math.max(0, ratio));
  return rgbHex(
    baseRed + (tintRed - baseRed) * amount,
    baseGreen + (tintGreen - baseGreen) * amount,
    baseBlue + (tintBlue - baseBlue) * amount,
  );
}

function rgba(hex: string, alpha: number): string {
  const [red, green, blue] = parseRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;
}

function readableText(background: string): string {
  const [red, green, blue] = parseRgb(background).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return luminance > 0.43 ? "#16181D" : "#FFFFFF";
}

function gradient(theme: ThemeSettings): string {
  const alpha = Math.max(0.05, theme.intensity / 100 * 0.55);
  const stops = theme.colors.map((color, index) => {
    const position = theme.colors.length === 1
      ? 50
      : Math.round(index * 100 / (theme.colors.length - 1));
    return `${rgba(color, alpha)} ${position}%`;
  });
  return `linear-gradient(${theme.angle}deg, ${stops.join(", ")})`;
}

function desktopThemeCss(theme: ThemeSettings): string {
  const primary = theme.colors[0] || DEFAULT_THEME.colors[0]!;
  const secondary = theme.colors[1] || primary;
  const tertiary = theme.colors[2] || secondary;
  const quaternary = theme.colors[3] || tertiary;
  const strength = theme.intensity / 100;
  const light = theme.mode === "light";

  const backgroundPrimary = mixHex(light ? "#FFFFFF" : "#111214", primary, strength * (light ? 0.14 : 0.28));
  const backgroundSecondary = mixHex(light ? "#F2F3F5" : "#1A1B1E", secondary, strength * (light ? 0.12 : 0.24));
  const backgroundTertiary = mixHex(light ? "#E3E5E8" : "#0B0C0E", tertiary, strength * (light ? 0.13 : 0.25));
  const backgroundFloating = mixHex(light ? "#FFFFFF" : "#15161A", quaternary, strength * (light ? 0.10 : 0.22));
  const backgroundAccent = mixHex(backgroundSecondary, primary, light ? 0.22 : 0.38);
  const surfaceLowest = mixHex(backgroundTertiary, "#000000", light ? 0.02 : 0.18);
  const surfaceLower = mixHex(backgroundSecondary, backgroundTertiary, 0.46);
  const surfaceLow = mixHex(backgroundPrimary, backgroundSecondary, 0.56);
  const surfaceHigh = mixHex(backgroundSecondary, primary, light ? 0.13 : 0.21);
  const surfaceHigher = mixHex(backgroundSecondary, primary, light ? 0.20 : 0.30);
  const surfaceHighest = mixHex(backgroundSecondary, primary, light ? 0.27 : 0.39);
  const modifierFaint = mixHex(backgroundSecondary, primary, light ? 0.06 : 0.10);
  const modifierSubtle = mixHex(backgroundSecondary, primary, light ? 0.11 : 0.18);
  const modifierStrong = mixHex(backgroundSecondary, primary, light ? 0.19 : 0.31);
  const borderFaint = mixHex(backgroundSecondary, light ? "#000000" : "#FFFFFF", light ? 0.07 : 0.08);
  const borderSubtle = mixHex(backgroundSecondary, light ? "#000000" : "#FFFFFF", light ? 0.13 : 0.14);
  const borderStrong = mixHex(backgroundSecondary, light ? "#000000" : "#FFFFFF", light ? 0.23 : 0.24);
  const headerPrimary = light ? "#17191F" : "#F4F5F7";
  const headerSecondary = light ? "#4E5663" : "#C5CAD3";
  const textNormal = light ? "#252830" : "#E8EAF0";
  const textMuted = light ? "#626A78" : "#A2AAB8";
  const textSubtle = light ? "#777F8D" : "#858E9D";
  const accentText = readableText(primary);
  const appGradient = gradient(theme);

  return `/* Jadges generated desktop account theme */
:root,
.theme-dark,
.theme-light,
.theme-darker,
.theme-midnight {
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
  --brand-600: ${mixHex(primary, "#000000", 0.24)} !important;

  --header-primary: ${headerPrimary} !important;
  --header-secondary: ${headerSecondary} !important;
  --text-default: ${textNormal} !important;
  --text-normal: ${textNormal} !important;
  --text-strong: ${headerPrimary} !important;
  --text-muted: ${textMuted} !important;
  --text-subtle: ${textSubtle} !important;
  --text-link: ${primary} !important;
  --text-brand: ${primary} !important;
  --interactive-normal: ${textMuted} !important;
  --interactive-hover: ${headerSecondary} !important;
  --interactive-active: ${headerPrimary} !important;
  --interactive-muted: ${textSubtle} !important;
  --icon-default: ${textMuted} !important;
  --icon-muted: ${textSubtle} !important;
  --icon-subtle: ${textSubtle} !important;
  --icon-strong: ${headerPrimary} !important;
  --channels-default: ${textMuted} !important;
  --channel-icon: ${textMuted} !important;

  --background-primary: ${backgroundPrimary} !important;
  --background-secondary: ${backgroundSecondary} !important;
  --background-secondary-alt: ${surfaceLower} !important;
  --background-tertiary: ${backgroundTertiary} !important;
  --background-floating: ${backgroundFloating} !important;
  --background-nested-floating: ${backgroundFloating} !important;
  --background-accent: ${backgroundAccent} !important;
  --background-mobile-primary: ${backgroundPrimary} !important;
  --background-mobile-secondary: ${backgroundSecondary} !important;
  --background-modifier-hover: ${modifierSubtle} !important;
  --background-modifier-active: ${modifierStrong} !important;
  --background-modifier-selected: ${surfaceHigher} !important;
  --background-modifier-accent: ${borderSubtle} !important;
  --background-message-hover: ${modifierFaint} !important;
  --background-mentioned: ${rgba(primary, 0.16)} !important;
  --background-mentioned-hover: ${rgba(primary, 0.22)} !important;

  --bg-base-primary: ${backgroundPrimary} !important;
  --bg-base-secondary: ${backgroundSecondary} !important;
  --bg-base-tertiary: ${backgroundTertiary} !important;
  --bg-surface-overlay: ${backgroundFloating} !important;
  --bg-surface-overlay-tmp: ${backgroundFloating} !important;
  --bg-surface-raised: ${surfaceHigh} !important;
  --bg-mod-faint: ${modifierFaint} !important;
  --bg-mod-subtle: ${modifierSubtle} !important;
  --bg-mod-strong: ${modifierStrong} !important;

  --background-base-lowest: ${surfaceLowest} !important;
  --background-base-lower: ${surfaceLower} !important;
  --background-base-low: ${surfaceLow} !important;
  --background-base-high: ${surfaceHigh} !important;
  --background-base-higher: ${surfaceHigher} !important;
  --background-base-highest: ${surfaceHighest} !important;
  --background-surface-lowest: ${surfaceLowest} !important;
  --background-surface-lower: ${surfaceLower} !important;
  --background-surface-low: ${surfaceLow} !important;
  --background-surface-high: ${surfaceHigh} !important;
  --background-surface-higher: ${surfaceHigher} !important;
  --background-surface-highest: ${surfaceHighest} !important;

  --border-faint: ${borderFaint} !important;
  --border-subtle: ${borderSubtle} !important;
  --border-normal: ${borderSubtle} !important;
  --border-strong: ${borderStrong} !important;
  --divider-subtle: ${borderSubtle} !important;

  --chat-background: ${backgroundPrimary} !important;
  --chat-input-container-background: ${backgroundAccent} !important;
  --input-background: ${backgroundAccent} !important;
  --modal-background: ${backgroundSecondary} !important;
  --modal-footer-background: ${backgroundTertiary} !important;
  --card-primary-bg: ${backgroundPrimary} !important;
  --card-secondary-bg: ${backgroundSecondary} !important;
  --home-background: ${backgroundPrimary} !important;
  --deprecated-card-bg: ${surfaceLow} !important;
  --deprecated-store-bg: ${backgroundPrimary} !important;
  --custom-channel-members-bg: ${backgroundSecondary} !important;
  --custom-channel-sidebar-bg: ${backgroundTertiary} !important;
  --custom-channel-chat-content-bg: ${backgroundPrimary} !important;
  --custom-status-bubble-background: ${backgroundFloating} !important;

  --button-secondary-background: ${surfaceHigher} !important;
  --button-secondary-background-hover: ${surfaceHighest} !important;
  --button-secondary-background-active: ${modifierStrong} !important;
  --button-outline-primary-background-hover: ${primary} !important;
  --button-positive-background: ${primary} !important;
  --button-positive-background-hover: ${mixHex(primary, "#000000", 0.12)} !important;
  --button-danger-background: #DA373C !important;
  --button-filled-brand-text: ${accentText} !important;

  --scrollbar-auto-thumb: ${surfaceHighest} !important;
  --scrollbar-auto-track: ${surfaceLowest} !important;
  --scrollbar-thin-thumb: ${surfaceHighest} !important;
  --scrollbar-thin-track: transparent !important;

  --profile-gradient-primary-color: ${backgroundPrimary} !important;
  --profile-gradient-secondary-color: ${backgroundSecondary} !important;
  --profile-gradient-overlay-color: transparent !important;
  --profile-gradient-button-color: ${surfaceHigher} !important;

  --jadges-account-gradient: ${appGradient};
  --jadges-account-primary: ${backgroundPrimary};
  --jadges-account-secondary: ${backgroundSecondary};
  --jadges-account-tertiary: ${backgroundTertiary};
  --jadges-account-floating: ${backgroundFloating};
}

html,
body,
#app-mount {
  background: var(--jadges-account-gradient), var(--jadges-account-primary) !important;
}

#app-mount [class*="appMount"],
#app-mount [class*="appAsidePanelWrapper"],
#app-mount [class*="layers"],
#app-mount [class*="baseLayer"] {
  background-color: transparent !important;
}

#app-mount [class*="guilds"],
#app-mount [class*="sidebarList"],
#app-mount [class*="sidebar"] [class*="scroller"],
#app-mount [class*="panels"],
#app-mount [class*="membersWrap"] {
  background-color: ${rgba(backgroundTertiary, 0.94)} !important;
}

#app-mount [class*="chatContent"],
#app-mount [class*="contentRegion"],
#app-mount [class*="contentRegionScroller"],
#app-mount [class*="standardSidebarView"] {
  background-color: ${rgba(backgroundPrimary, 0.93)} !important;
}

#app-mount [class*="channelTextArea"] [class*="scrollableContainer"],
#app-mount [class*="searchBar"] [class*="searchBarComponent"],
#app-mount [class*="inputDefault"] {
  background-color: ${backgroundAccent} !important;
}

#app-mount [role="dialog"],
#app-mount [class*="popout"] {
  --background-primary: ${backgroundFloating} !important;
  --background-secondary: ${backgroundFloating} !important;
  --background-floating: ${backgroundFloating} !important;
  --modal-background: ${backgroundFloating} !important;
}
`;
}

function sendCss(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  css: string,
): void {
  const body = Buffer.from(css, "utf8");
  response.writeHead(status, {
    "content-type": "text/css; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store, max-age=0",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

async function handleDesktopTheme(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", "http://localhost");
  const match = /^\/themes\/(\d{15,22})\.css$/.exec(url.pathname);
  if (!match?.[1]) return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendCss(request, response, 405, "/* Method not allowed */");
    return true;
  }

  const data = await readStore();
  const theme = normalizeTheme((data.users[match[1]] as ThemeUser | undefined)?.theme);
  if (!theme.enabled) {
    sendCss(request, response, 404, "/* No active Jadges desktop theme */");
    return true;
  }

  sendCss(request, response, 200, desktopThemeCss(theme));
  return true;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void handleDesktopTheme(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges desktop theme request failed:", error);
        if (response.headersSent) response.destroy();
        else sendCss(request, response, 500, "/* Jadges desktop theme failed */");
      });
  };
}

export function installDesktopThemeIntegration(): void {
  if (installed) return;
  installed = true;

  const mutable = http as typeof http & {
    createServer: (...args: any[]) => http.Server;
  };
  const original = mutable.createServer.bind(http) as (...args: any[]) => http.Server;

  mutable.createServer = ((...args: any[]): http.Server => {
    const listenerIndex = typeof args[0] === "function"
      ? 0
      : typeof args[1] === "function"
        ? 1
        : -1;
    if (listenerIndex !== -1) {
      args[listenerIndex] = wrap(args[listenerIndex] as RequestListener);
    }
    return original(...args);
  }) as typeof http.createServer;
}
