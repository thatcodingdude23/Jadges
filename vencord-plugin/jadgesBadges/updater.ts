import { showNotification } from "@api/Notifications";
import { PluginNative } from "@utils/types";

const CURRENT_UPDATE_VERSION = 13;
const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;

const Native = VencordNative.pluginHelpers.JadgesBadges as PluginNative<typeof import("./native")>;

interface UpdateManifest {
    version: number;
}

let updateTimer: ReturnType<typeof setInterval> | undefined;
let initialUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let notifiedUpdateVersion = 0;
let updateInstalling = false;

function showUpdateError(message: string): void {
    void showNotification({
        title: "Jadges",
        body: message,
        permanent: true,
        noPersist: true
    });
}

async function installLatestUpdate(): Promise<void> {
    if (updateInstalling || IS_WEB) return;
    updateInstalling = true;

    void showNotification({
        title: "Jadges",
        body: "Installing the latest Jadges update…",
        permanent: true,
        noPersist: true
    });

    try {
        const result = await Native.installLatestUpdate();
        if (!result.ok) {
            showUpdateError(result.message || "The Jadges update could not be installed.");
            return;
        }

        void showNotification({
            title: "Jadges",
            body: "Jadges was updated successfully. Refreshing Discord…",
            noPersist: true
        });

        setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
        showUpdateError(
            error instanceof Error
                ? `The Jadges update failed: ${error.message}`
                : "The Jadges update failed."
        );
    } finally {
        updateInstalling = false;
    }
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
        if (
            !Number.isSafeInteger(manifest.version)
            || manifest.version <= CURRENT_UPDATE_VERSION
            || manifest.version === notifiedUpdateVersion
        ) {
            return;
        }

        notifiedUpdateVersion = manifest.version;
        void showNotification({
            title: "Jadges",
            body: "Jadges has been updated! Click here to install the latest update.",
            permanent: true,
            noPersist: true,
            onClick: () => void installLatestUpdate()
        });
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
}
