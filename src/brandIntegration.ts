import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { config } from "./config.js";
import { getOrCreateUser, mutateStore, readStore } from "./store.js";
import type { UserRecord } from "./types.js";

const SESSION_COOKIE = "jadges_session";
const MAX_BODY_SIZE = 32 * 1024;
const HEX_COLOR = /^#[0-9A-F]{6}$/;

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

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 54" fill="none">
  <defs>
    <linearGradient id="j" x1="10" y1="7" x2="36" y2="48" gradientUnits="userSpaceOnUse">
      <stop stop-color="#b89cff"/>
      <stop offset=".5" stop-color="#7c4dff"/>
      <stop offset="1" stop-color="#5b8cff"/>
    </linearGradient>
  </defs>
  <path d="M31 8v27.5C31 43 26.7 47 20.2 47c-5.4 0-9.2-2.8-10.7-7.6" stroke="url(#j)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const LOGO_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 54' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='j' x1='10' y1='7' x2='36' y2='48' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%23b89cff'/%3E%3Cstop offset='.5' stop-color='%237c4dff'/%3E%3Cstop offset='1' stop-color='%235b8cff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M31 8v27.5C31 43 26.7 47 20.2 47c-5.4 0-9.2-2.8-10.7-7.6' stroke='url(%23j)' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const BRAND_CSS = `

/* Jadges outlined J branding */
.logo-mark {
  width: 34px;
  height: 38px;
  background-image: url("${LOGO_DATA_URI}");
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
  filter: drop-shadow(0 8px 18px rgba(124, 77, 255, 0.3));
}

.logo-mark > * {
  display: none !important;
}
`;

let installed = false;
let brandedCss: Buffer | undefined;
let brandedJs: Buffer | undefined;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeaderValue(request.headers.host);

  if (host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
    const protocol = forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : "https";
    return `${protocol}://${host}`;
  }
  return config.publicUrl;
}

function signature(value: string): string {
  return createHmac("sha256", config.webSessionSecret)
    .update(value)
    .digest("base64url");
}

function sessionUserId(request: IncomingMessage): string | undefined {
  const cookie = (request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const raw = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return undefined;

  try {
    const token = decodeURIComponent(raw);
    const [body, suppliedSignature, extra] = token.split(".");
    if (!body || !suppliedSignature || extra) return undefined;

    const expected = Buffer.from(signature(body));
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return undefined;
    }

    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { kind?: unknown; userId?: unknown; expiresAt?: unknown };
    if (
      payload.kind !== "session" ||
      typeof payload.userId !== "string" ||
      !/^\d{15,22}$/.test(payload.userId) ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return payload.userId;
  } catch {
    return undefined;
  }
}

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

function userTheme(user: UserRecord | undefined): ThemeSettings {
  return normalizeTheme((user as ThemeUser | undefined)?.theme);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  contentType: string,
  body: Buffer,
  cacheControl = "public, max-age=300, must-revalidate",
): void {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
  cors = false,
): void {
  const buffer = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buffer.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(cors ? { "access-control-allow-origin": "*" } : {}),
  });
  if (request.method === "HEAD") response.end();
  else response.end(buffer);
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

function mobileThemeDocument(theme: ThemeSettings, userId: string): unknown {
  const primary = theme.colors[0] || DEFAULT_THEME.colors[0]!;
  const secondary = theme.colors[1] || primary;
  const tertiary = theme.colors[2] || secondary;
  const strength = theme.intensity / 100;
  const light = theme.mode === "light";

  const backgroundPrimary = mixHex(light ? "#FFFFFF" : "#111214", primary, strength * (light ? 0.12 : 0.24));
  const backgroundSecondary = mixHex(light ? "#F2F3F5" : "#1A1B1E", secondary, strength * (light ? 0.10 : 0.19));
  const backgroundTertiary = mixHex(light ? "#E3E5E8" : "#0B0C0E", tertiary, strength * (light ? 0.11 : 0.20));
  const backgroundAccent = mixHex(backgroundSecondary, primary, 0.48);
  const modifierHover = mixHex(backgroundSecondary, primary, light ? 0.13 : 0.22);
  const modifierSelected = mixHex(backgroundSecondary, primary, light ? 0.22 : 0.34);
  const headerPrimary = light ? "#17191F" : "#F4F5F7";
  const headerSecondary = light ? "#4E5663" : "#C5CAD3";
  const textNormal = light ? "#252830" : "#E8EAF0";
  const textMuted = light ? "#626A78" : "#9BA3B0";
  const values = (value: string) => [value, value, value];

  return {
    name: `Jadges Account Theme ${userId}`,
    description: "Automatically generated from the user's Jadges dashboard appearance settings.",
    authors: [{ name: "Jadges", id: "0" }],
    spec: 2,
    semanticColors: {
      ANDROID_RIPPLE: values(modifierHover),
      CHAT_BACKGROUND: values(backgroundPrimary),
      HEADER_PRIMARY: values(headerPrimary),
      HEADER_SECONDARY: values(headerSecondary),
      TEXT_NORMAL: values(textNormal),
      TEXT_PRIMARY: values(textNormal),
      TEXT_MUTED: values(textMuted),
      TEXT_LINK: values(primary),
      INTERACTIVE_NORMAL: values(primary),
      INTERACTIVE_HOVER: values(secondary),
      INTERACTIVE_ACTIVE: values(headerPrimary),
      INTERACTIVE_MUTED: values(textMuted),
      CHANNELS_DEFAULT: values(textMuted),
      CHANNEL_ICON: values(primary),
      BACKGROUND_PRIMARY: values(backgroundPrimary),
      BG_BASE_PRIMARY: values(backgroundPrimary),
      CARD_PRIMARY_BG: values(backgroundPrimary),
      BACKGROUND_MOBILE_PRIMARY: values(backgroundPrimary),
      BACKGROUND_SECONDARY: values(backgroundSecondary),
      BG_BASE_SECONDARY: values(backgroundSecondary),
      CARD_SECONDARY_BG: values(backgroundSecondary),
      BACKGROUND_MOBILE_SECONDARY: values(backgroundSecondary),
      BACKGROUND_SECONDARY_ALT: values(backgroundSecondary),
      BACKGROUND_TERTIARY: values(backgroundTertiary),
      BG_BASE_TERTIARY: values(backgroundTertiary),
      BACKGROUND_FLOATING: values(backgroundTertiary),
      BACKGROUND_NESTED_FLOATING: values(backgroundTertiary),
      BACKGROUND_ACCENT: values(backgroundAccent),
      BACKGROUND_MESSAGE_HOVER: values(modifierHover),
      BACKGROUND_MODIFIER_HOVER: values(modifierHover),
      BACKGROUND_MODIFIER_ACTIVE: values(modifierHover),
      BACKGROUND_MODIFIER_SELECTED: values(modifierSelected),
      BACKGROUND_MODIFIER_ACCENT: values(backgroundAccent),
      REDESIGN_ACTIVITY_CARD_BACKGROUND: values(backgroundSecondary),
      REDESIGN_BUTTON_SECONDARY_BACKGROUND: values(backgroundAccent),
      REDESIGN_BUTTON_SECONDARY_BORDER: values(backgroundTertiary),
      REDESIGN_CHANNEL_CATEGORY_NAME_TEXT: values(textMuted),
      REDESIGN_CHANNEL_NAME_TEXT: values(textNormal),
      REDESIGN_CHAT_INPUT_BACKGROUND: values(backgroundAccent),
      REDESIGN_BUTTON_TERTIARY_BACKGROUND: values(backgroundAccent),
    },
    rawColors: {
      BLACK: backgroundTertiary,
      WHITE: headerPrimary,
      WHITE_500: headerPrimary,
      PRIMARY_100: headerPrimary,
      PRIMARY_200: headerPrimary,
      PRIMARY_300: headerSecondary,
      PRIMARY_330: headerSecondary,
      PRIMARY_360: textMuted,
      PRIMARY_400: textMuted,
      PRIMARY_460: backgroundAccent,
      PRIMARY_500: primary,
      PRIMARY_530: secondary,
      PRIMARY_600: backgroundAccent,
      PRIMARY_630: backgroundSecondary,
      PRIMARY_660: backgroundSecondary,
      PRIMARY_700: backgroundTertiary,
      PRIMARY_800: backgroundTertiary,
      BRAND_260: secondary,
      BRAND_360: primary,
      BRAND_500: primary,
      BRAND_560: mixHex(primary, "#000000", 0.15),
      PLUM_3: headerPrimary,
      PLUM_4: modifierSelected,
      PLUM_6: primary,
      PLUM_10: textMuted,
      PLUM_15: textMuted,
      PLUM_16: backgroundAccent,
      PLUM_17: backgroundPrimary,
      PLUM_18: backgroundSecondary,
      PLUM_19: backgroundTertiary,
      PLUM_20: backgroundTertiary,
      PLUM_24: backgroundPrimary,
    },
  };
}

async function serveCombinedAsset(
  request: IncomingMessage,
  response: ServerResponse,
  filename: "jadges.css" | "jadges.js",
): Promise<void> {
  if (filename === "jadges.css") {
    if (!brandedCss) {
      const [original, appearance] = await Promise.all([
        readFile(new URL("../web/jadges.css", import.meta.url), "utf8"),
        readFile(new URL("../web/jadges-theme.css", import.meta.url), "utf8"),
      ]);
      brandedCss = Buffer.from(`${original}\n${BRAND_CSS}\n${appearance}`, "utf8");
    }
    send(request, response, "text/css; charset=utf-8", brandedCss);
    return;
  }

  if (!brandedJs) {
    const [original, appearance] = await Promise.all([
      readFile(new URL("../web/jadges.js", import.meta.url), "utf8"),
      readFile(new URL("../web/jadges-theme.js", import.meta.url), "utf8"),
    ]);
    brandedJs = Buffer.from(`${original}\n${appearance}`, "utf8");
  }
  send(request, response, "text/javascript; charset=utf-8", brandedJs);
}

async function handleThemeApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const userId = sessionUserId(request);
  if (!userId) {
    sendJson(request, response, 401, { error: "Login required" });
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const data = await readStore();
    sendJson(request, response, 200, { theme: userTheme(data.users[userId]) });
    return;
  }

  if (request.method !== "POST") {
    sendJson(request, response, 405, { error: "Method not allowed" });
    return;
  }

  const suppliedOrigin = firstHeaderValue(request.headers.origin);
  const expectedOrigin = requestOrigin(request);
  if (suppliedOrigin && suppliedOrigin !== expectedOrigin && suppliedOrigin !== config.publicUrl) {
    sendJson(request, response, 403, { error: "Origin check failed" });
    return;
  }

  try {
    const body = await readJson(request) as Partial<ThemeSettings> & { reset?: unknown };
    let saved: ThemeSettings;

    await mutateStore((data) => {
      const user = getOrCreateUser(data, userId) as ThemeUser;
      if (body.reset === true) {
        delete user.theme;
        saved = { ...DEFAULT_THEME, colors: [...DEFAULT_THEME.colors] };
        return;
      }

      if (!Array.isArray(body.colors) || body.colors.length < 1 || body.colors.length > 5) {
        throw new Error("Choose between one and five colors");
      }
      const colors = body.colors.map(normalizeHex);
      if (colors.some((color) => !color)) throw new Error("One of the hex colors is invalid");
      if (body.mode !== "dark" && body.mode !== "light") {
        throw new Error("Choose Dark Mode or Light Mode");
      }

      saved = {
        enabled: body.enabled !== false,
        mode: body.mode,
        colors: colors as string[],
        angle: clampInteger(body.angle, 0, 360),
        intensity: clampInteger(body.intensity, 0, 100),
        updatedAt: new Date().toISOString(),
      };
      user.theme = saved;
    });

    sendJson(request, response, 200, { theme: saved! });
  } catch (error) {
    sendJson(request, response, 400, {
      error: error instanceof Error ? error.message : "Invalid theme settings",
    });
  }
}

async function handleSettingsFeed(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(request, response, 405, { error: "Method not allowed" }, true);
    return;
  }

  const data = await readStore();
  const result: Record<string, unknown> = {};
  for (const [userId, rawUser] of Object.entries(data.users)) {
    const user = rawUser as ThemeUser;
    const theme = user.theme ? normalizeTheme(user.theme) : undefined;
    if (
      !user.badgeSide &&
      !user.badgeOrder?.length &&
      !user.nativeBadges?.length &&
      !theme
    ) {
      continue;
    }

    result[userId] = {
      side: user.badgeSide,
      order: user.badgeOrder ? [...user.badgeOrder] : [],
      nativeBadges: (user.nativeBadges || []).map((badge) => ({
        key: badge.key,
        name: badge.name,
        image: badge.image,
      })),
      ...(theme ? { theme } : {}),
    };
  }

  sendJson(request, response, 200, result, true);
}

async function handleMobileTheme(
  request: IncomingMessage,
  response: ServerResponse,
  userId: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(request, response, 405, { error: "Method not allowed" }, true);
    return;
  }
  if (!/^\d{15,22}$/.test(userId)) {
    sendJson(request, response, 400, { error: "Invalid Discord user ID" }, true);
    return;
  }

  const data = await readStore();
  const theme = userTheme(data.users[userId]);
  if (!theme.enabled) {
    sendJson(request, response, 404, { error: "No active Jadges theme" }, true);
    return;
  }
  sendJson(request, response, 200, mobileThemeDocument(theme, userId), true);
}

async function serveBrandAsset(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url || "/", config.publicUrl);

  if (
    (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    send(
      request,
      response,
      "image/svg+xml; charset=utf-8",
      Buffer.from(FAVICON_SVG, "utf8"),
    );
    return true;
  }

  if (url.pathname === "/assets/jadges.css" || url.pathname === "/assets/jadges.js") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(request, response, 405, { error: "Method not allowed" });
      return true;
    }
    await serveCombinedAsset(
      request,
      response,
      url.pathname.endsWith(".css") ? "jadges.css" : "jadges.js",
    );
    return true;
  }

  if (url.pathname === "/api/theme") {
    await handleThemeApi(request, response);
    return true;
  }

  if (url.pathname === "/settings.json") {
    await handleSettingsFeed(request, response);
    return true;
  }

  const mobileThemeMatch = /^\/themes\/(\d{15,22})\.json$/.exec(url.pathname);
  if (mobileThemeMatch?.[1]) {
    await handleMobileTheme(request, response, mobileThemeMatch[1]);
    return true;
  }

  return false;
}

function wrap(listener: RequestListener): RequestListener {
  return (request, response) => {
    void serveBrandAsset(request, response)
      .then((handled) => {
        if (!handled) listener(request, response);
      })
      .catch((error) => {
        console.error("Jadges brand/theme integration error:", error);
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ error: "Could not load Jadges branding or theme" }));
        }
      });
  };
}

export function installBrandIntegration(): void {
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
