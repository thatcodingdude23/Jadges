import { PluginNative } from "@utils/types";

const CURRENT_UPDATE_VERSION = 29;
const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;
const TOAST_ID = "jadges-update-toast";

const Native = VencordNative.pluginHelpers.JadgesBadges as PluginNative<typeof import("./native")>;

interface UpdateManifest {
    version: number;
}

let updateTimer: ReturnType<typeof setInterval> | undefined;
let initialUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let installing = false;
let shownVersion = 0;

function removeToast(): void {
    document.getElementById(TOAST_ID)?.remove();
}

function text<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    value: string
): HTMLElementTagNameMap[K] {
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
    toast.setAttribute("aria-live", "polite");

    const header = document.createElement("div");
    header.className = "jadges-update-header";

    const heading = document.createElement("div");
    heading.append(
        text("strong", "jadges-update-title", "Jadges update available"),
        text("span", "jadges-update-version", `Version ${version}`)
    );

    const close = text("button", "jadges-update-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss Jadges update");
    close.addEventListener("click", removeToast);
    header.append(heading, close);

    const copy = text(
        "p",
        "jadges-update-copy",
        "Install the update inside Discord with a live loading screen, percentage, and build logs."
    );
    const status = text(
        "p",
        "jadges-update-status",
        "Discord will pause during installation and restart automatically at 100%."
    );
    const actions = document.createElement("div");
    actions.className = "jadges-update-actions";
    const install = text("button", "jadges-update-install", "Install update");
    install.type = "button";

    install.addEventListener("click", async () => {
        if (installing) return;
        installing = true;
        install.disabled = true;
        install.textContent = "Opening installer…";
        status.classList.remove("jadges-update-status-error");
        status.textContent = "Switching Discord to the Jadges installer screen…";

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

async function checkForUpdates(): Promise<void> {
    if (IS_WEB || installing) return;

    try {
        const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) return;

        const manifest = await response.json() as UpdateManifest;
        if (
            Number.isSafeInteger(manifest.version)
            && manifest.version > CURRENT_UPDATE_VERSION
        ) {
            showUpdate(manifest.version);
        }
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
    installing = false;
    removeToast();
}
