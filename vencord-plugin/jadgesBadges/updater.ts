import { PluginNative } from "@utils/types";

const CURRENT_UPDATE_VERSION = 16;
const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;
const UPDATE_TOAST_ID = "jadges-update-toast";
const APPLIED_UPDATE_VERSION_KEY = "jadges-applied-update-version";

const Native = VencordNative.pluginHelpers.JadgesBadges as PluginNative<typeof import("./native")>;

interface UpdateManifest {
    version: number;
}

let updateTimer: ReturnType<typeof setInterval> | undefined;
let initialUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let notifiedUpdateVersion = 0;
let updateInstalling = false;

function removeUpdateToast(): void {
    document.getElementById(UPDATE_TOAST_ID)?.remove();
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text: string
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}

async function installLatestUpdate(
    version: number,
    installButton: HTMLButtonElement,
    status: HTMLParagraphElement
): Promise<void> {
    if (updateInstalling || IS_WEB) return;
    updateInstalling = true;

    installButton.disabled = true;
    installButton.textContent = "Updating…";
    status.classList.remove("jadges-update-status-error");
    status.textContent = "Downloading, building, and injecting the latest Jadges update…";

    try {
        const result = await Native.installLatestUpdate();
        if (!result.ok) {
            throw new Error(result.message || "The Jadges update could not be installed.");
        }

        localStorage.setItem(
            APPLIED_UPDATE_VERSION_KEY,
            String(result.version || version)
        );
        installButton.textContent = "Installed";
        status.textContent = "Update installed. Reloading Discord…";
        setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
        status.classList.add("jadges-update-status-error");
        status.textContent = error instanceof Error
            ? error.message
            : "The Jadges update failed.";
        installButton.disabled = false;
        installButton.textContent = "Retry update";
    } finally {
        updateInstalling = false;
    }
}

function showUpdateToast(version: number): void {
    const existing = document.getElementById(UPDATE_TOAST_ID);
    if (existing?.dataset.version === String(version)) return;
    existing?.remove();

    const toast = document.createElement("section");
    toast.id = UPDATE_TOAST_ID;
    toast.className = "jadges-update-toast";
    toast.dataset.version = String(version);
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const header = document.createElement("div");
    header.className = "jadges-update-header";

    const titleWrap = document.createElement("div");
    titleWrap.append(
        createTextElement("strong", "jadges-update-title", "Jadges update available"),
        createTextElement("span", "jadges-update-version", `Version ${version}`)
    );

    const closeButton = createTextElement("button", "jadges-update-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Dismiss Jadges update");
    closeButton.addEventListener("click", () => toast.remove());

    header.append(titleWrap, closeButton);

    const body = createTextElement(
        "p",
        "jadges-update-copy",
        "Install the newest plugin files, rebuild Vencord, and inject the update into Discord."
    );
    const status = createTextElement(
        "p",
        "jadges-update-status",
        "Discord will reload automatically when the update is ready."
    );

    const actions = document.createElement("div");
    actions.className = "jadges-update-actions";
    const installButton = createTextElement("button", "jadges-update-install", "Install update");
    installButton.type = "button";
    installButton.addEventListener("click", () => {
        void installLatestUpdate(version, installButton, status);
    });
    actions.append(installButton);

    toast.append(header, body, status, actions);
    document.body.append(toast);
}

async function checkForUpdates(): Promise<void> {
    if (IS_WEB || updateInstalling) return;

    try {
        const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) return;

        const manifest = await response.json() as UpdateManifest;
        const appliedVersion = Number(
            localStorage.getItem(APPLIED_UPDATE_VERSION_KEY) || 0
        );
        const needsUpdate =
            manifest.version > CURRENT_UPDATE_VERSION
            || appliedVersion < manifest.version;

        if (
            !Number.isSafeInteger(manifest.version)
            || manifest.version <= 0
            || !needsUpdate
            || manifest.version === notifiedUpdateVersion
        ) {
            return;
        }

        notifiedUpdateVersion = manifest.version;
        showUpdateToast(manifest.version);
    } catch (error) {
        console.warn("[JadgesBadges] Update check failed:", error);
    }
}

export function startUpdateChecker(): void {
    if (IS_WEB) return;

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
    removeUpdateToast();
}
