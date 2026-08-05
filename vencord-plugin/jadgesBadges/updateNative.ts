import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { app, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { unzipSync } from "fflate";

const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const REPOSITORY_ZIP_URL =
    "https://github.com/thatcodingdude23/Jadges/archive/refs/heads/main.zip";
const ARCHIVE_PLUGIN_PREFIX = "Jadges-main/vencord-plugin/jadgesBadges/";
const PLUGIN_FOLDER_NAME = "jadgesBadges";
const REQUIRED_PLUGIN_FILES = [
    "index.tsx",
    "base.tsx",
    "native.ts",
    "style.css",
    "updater.ts",
    "updateNative.ts"
] as const;

const INSTALLER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Installing Jadges update</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body {
    align-items: center;
    background:
        radial-gradient(circle at 50% 18%, rgba(88, 101, 242, .24), transparent 34%),
        linear-gradient(180deg, #15161b 0%, #0d0e12 100%);
    color: #f2f3f5;
    display: flex;
    justify-content: center;
    user-select: none;
}
.shell { width: min(760px, calc(100vw - 48px)); }
.brand { align-items: center; display: flex; gap: 14px; justify-content: center; margin-bottom: 28px; }
.logo {
    align-items: center;
    background: linear-gradient(135deg, #8b5cf6, #5865f2);
    border-radius: 18px;
    box-shadow: 0 16px 46px rgba(88, 101, 242, .35);
    display: flex;
    font-size: 31px;
    font-weight: 900;
    height: 66px;
    justify-content: center;
    width: 66px;
}
.brand-name { font-size: 27px; font-weight: 850; letter-spacing: -.7px; }
.card {
    background: rgba(30, 31, 36, .96);
    border: 1px solid rgba(255, 255, 255, .08);
    border-radius: 22px;
    box-shadow: 0 26px 90px rgba(0, 0, 0, .5);
    padding: 28px;
}
h1 { font-size: 25px; margin: 0; text-align: center; }
.status { color: #b5bac1; font-size: 14px; margin: 9px 0 0; min-height: 21px; text-align: center; }
.progress-row { align-items: center; display: flex; gap: 14px; margin-top: 24px; }
.track { background: #111216; border-radius: 999px; flex: 1; height: 12px; overflow: hidden; }
.bar {
    background: linear-gradient(90deg, #5865f2, #a78bfa);
    border-radius: inherit;
    box-shadow: 0 0 20px rgba(124, 92, 255, .55);
    height: 100%;
    transition: width 220ms ease;
    width: 0%;
}
.percent { font-size: 17px; font-variant-numeric: tabular-nums; font-weight: 800; min-width: 50px; text-align: right; }
.remaining { color: #949ba4; font-size: 12px; margin-top: 8px; text-align: right; }
.logs-title { color: #dbdee1; font-size: 12px; font-weight: 800; letter-spacing: .7px; margin: 22px 0 8px; text-transform: uppercase; }
.logs {
    background: #0c0d10;
    border: 1px solid #303238;
    border-radius: 12px;
    color: #b5bac1;
    font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    height: 210px;
    line-height: 1.55;
    overflow: auto;
    padding: 13px 14px;
    user-select: text;
    white-space: pre-wrap;
}
.log-line { margin: 0 0 3px; overflow-wrap: anywhere; }
.log-error { color: #fa777c; }
.log-success { color: #6dff9d; }
.actions { display: none; justify-content: center; margin-top: 18px; }
.return-button {
    background: #5865f2;
    border: 0;
    border-radius: 9px;
    color: white;
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 750;
    min-height: 40px;
    padding: 0 18px;
}
.error h1, .error .percent { color: #fa777c; }
.error .bar { background: #da373c; box-shadow: 0 0 20px rgba(218, 55, 60, .4); }
.complete .bar { background: #23a55a; box-shadow: 0 0 20px rgba(35, 165, 90, .4); }
@media (max-height: 650px) {
    .brand { margin-bottom: 16px; }
    .logo { height: 52px; width: 52px; }
    .card { padding: 22px; }
    .logs { height: 160px; }
}
</style>
</head>
<body>
<main class="shell">
    <div class="brand"><div class="logo">J</div><div class="brand-name">Jadges</div></div>
    <section id="card" class="card">
        <h1 id="heading">Installing update…</h1>
        <p id="status" class="status">Preparing the installer</p>
        <div class="progress-row">
            <div class="track"><div id="bar" class="bar"></div></div>
            <div id="percent" class="percent">0%</div>
        </div>
        <div id="remaining" class="remaining">100% remaining</div>
        <div class="logs-title">Installation logs</div>
        <div id="logs" class="logs" role="log" aria-live="polite"></div>
        <div id="actions" class="actions">
            <button id="return" class="return-button" type="button">Return to Discord</button>
        </div>
    </section>
</main>
<script>
(function () {
    var card = document.getElementById("card");
    var heading = document.getElementById("heading");
    var status = document.getElementById("status");
    var bar = document.getElementById("bar");
    var percent = document.getElementById("percent");
    var remaining = document.getElementById("remaining");
    var logs = document.getElementById("logs");
    var actions = document.getElementById("actions");

    document.getElementById("return").addEventListener("click", function () {
        location.href = "jadges:return";
    });

    window.jadgesInstallerUpdate = function (update) {
        var value = Math.max(0, Math.min(100, Number(update.percent) || 0));
        var rounded = Math.round(value);
        bar.style.width = rounded + "%";
        percent.textContent = rounded + "%";
        remaining.textContent = rounded >= 100 ? "Complete" : (100 - rounded) + "% remaining";

        if (update.heading) heading.textContent = update.heading;
        if (update.status) status.textContent = update.status;

        if (update.log) {
            var line = document.createElement("div");
            line.className = "log-line" + (update.logType ? " log-" + update.logType : "");
            line.textContent = update.log;
            logs.appendChild(line);
            while (logs.childElementCount > 240) logs.firstElementChild.remove();
            logs.scrollTop = logs.scrollHeight;
        }

        card.classList.toggle("error", Boolean(update.error));
        card.classList.toggle("complete", Boolean(update.complete));
        actions.style.display = update.showReturn ? "flex" : "none";
    };
}());
</script>
</body>
</html>`;

interface UpdateManifest {
    version: number;
}

interface InstallerUpdate {
    percent: number;
    heading?: string;
    status?: string;
    log?: string;
    logType?: "error" | "success";
    error?: boolean;
    complete?: boolean;
    showReturn?: boolean;
}

interface InstallerUi {
    window: BrowserWindow;
    hiddenWindows: BrowserWindow[];
    allowClose: boolean;
    canReturn: boolean;
}

export interface JadgesUpdateResult {
    ok: boolean;
    message: string;
    version?: number;
}

async function exists(target: string): Promise<boolean> {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

async function isVencordRoot(candidate: string): Promise<boolean> {
    return await exists(path.join(candidate, "package.json"))
        && await exists(path.join(candidate, "src", "userplugins"));
}

function parentCandidates(start: string): string[] {
    const result: string[] = [];
    let current = path.resolve(start);

    while (true) {
        result.push(current);
        const parent = path.dirname(current);
        if (parent === current) return result;
        current = parent;
    }
}

async function findVencordRoot(): Promise<string | undefined> {
    const home = homedir();
    const candidates = new Set<string>([
        ...(process.env.VENCORD_ROOT ? [process.env.VENCORD_ROOT] : []),
        ...(process.env.VENCORD_SRC ? [process.env.VENCORD_SRC] : []),
        ...parentCandidates(process.cwd()),
        path.join(home, "Vencord"),
        path.join(home, "vencord"),
        path.join(home, "Desktop", "Vencord"),
        path.join(home, "Documents", "Vencord"),
        path.join(home, "Downloads", "Vencord")
    ]);

    for (const candidate of candidates) {
        if (await isVencordRoot(candidate)) return path.resolve(candidate);
    }
    return undefined;
}

async function updateInstaller(ui: InstallerUi, update: InstallerUpdate): Promise<void> {
    if (ui.window.isDestroyed()) return;
    const payload = JSON.stringify(update);
    await ui.window.webContents
        .executeJavaScript(`window.jadgesInstallerUpdate?.(${payload});`, true)
        .catch(() => undefined);
}

function restoreDiscordWindows(ui: InstallerUi): void {
    ui.allowClose = true;
    if (!ui.window.isDestroyed()) ui.window.close();

    for (const window of ui.hiddenWindows) {
        if (!window.isDestroyed()) window.show();
    }
}

async function createInstallerUi(): Promise<InstallerUi> {
    const hiddenWindows = BrowserWindow.getAllWindows();
    const window = new BrowserWindow({
        width: 820,
        height: 680,
        minWidth: 680,
        minHeight: 560,
        center: true,
        frame: false,
        resizable: true,
        fullscreenable: false,
        alwaysOnTop: true,
        backgroundColor: "#0d0e12",
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    const ui: InstallerUi = {
        window,
        hiddenWindows,
        allowClose: false,
        canReturn: false
    };

    window.on("close", event => {
        if (!ui.allowClose) event.preventDefault();
    });

    window.webContents.on("will-navigate", (event, url) => {
        if (url !== "jadges:return" || !ui.canReturn) return;
        event.preventDefault();
        restoreDiscordWindows(ui);
    });

    window.webContents.on("before-input-event", (event, input) => {
        if (input.key !== "Escape" || !ui.canReturn) return;
        event.preventDefault();
        restoreDiscordWindows(ui);
    });

    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(INSTALLER_HTML)}`);

    for (const existingWindow of hiddenWindows) {
        if (!existingWindow.isDestroyed()) existingWindow.hide();
    }

    window.show();
    window.focus();
    return ui;
}

async function fetchLatestVersion(ui: InstallerUi): Promise<number> {
    await updateInstaller(ui, {
        percent: 8,
        status: "Checking the newest Jadges version…",
        log: "Checking the update manifest"
    });

    const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Update information returned HTTP ${response.status}`);

    const manifest = await response.json() as UpdateManifest;
    if (!Number.isSafeInteger(manifest.version) || manifest.version <= 0) {
        throw new Error("The update information is invalid.");
    }

    await updateInstaller(ui, {
        percent: 12,
        status: `Preparing Jadges version ${manifest.version}…`,
        log: `Latest version: ${manifest.version}`
    });
    return manifest.version;
}

async function downloadRepositoryZip(ui: InstallerUi): Promise<Uint8Array> {
    await updateInstaller(ui, {
        percent: 16,
        status: "Downloading the Jadges repository…",
        log: "Downloading main.zip from GitHub"
    });

    const response = await fetch(`${REPOSITORY_ZIP_URL}?t=${Date.now()}`, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(90_000)
    });

    if (!response.ok) {
        throw new Error(`Repository ZIP download returned HTTP ${response.status}`);
    }

    const total = Number(response.headers.get("content-length") || 0);
    const reader = response.body?.getReader();
    if (!reader) {
        const archive = new Uint8Array(await response.arrayBuffer());
        await updateInstaller(ui, {
            percent: 42,
            status: "Repository downloaded",
            log: `Downloaded ${(archive.length / 1024).toFixed(1)} KB`,
            logType: "success"
        });
        return archive;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    let shownPercent = 16;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        chunks.push(value);
        received += value.length;

        const nextPercent = total > 0
            ? 16 + Math.floor((received / total) * 26)
            : Math.min(41, 16 + Math.floor(received / (128 * 1024)));

        if (nextPercent > shownPercent) {
            shownPercent = Math.min(41, nextPercent);
            await updateInstaller(ui, {
                percent: shownPercent,
                status: "Downloading the Jadges repository…"
            });
        }
    }

    const archive = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        archive.set(chunk, offset);
        offset += chunk.length;
    }

    if (archive.length < 100) throw new Error("The downloaded repository ZIP was empty.");

    await updateInstaller(ui, {
        percent: 42,
        status: "Repository downloaded",
        log: `Downloaded ${(archive.length / 1024).toFixed(1)} KB`,
        logType: "success"
    });
    return archive;
}

async function extractPluginFromZip(
    ui: InstallerUi,
    archive: Uint8Array,
    destination: string
): Promise<void> {
    await updateInstaller(ui, {
        percent: 46,
        status: "Extracting the Jadges plugin…",
        log: "Opening the repository ZIP"
    });

    const files = unzipSync(archive);
    const entries = Object.entries(files).filter(([archivePath]) =>
        archivePath.startsWith(ARCHIVE_PLUGIN_PREFIX)
        && !archivePath.endsWith("/")
    );
    const root = path.resolve(destination);
    const rootPrefix = `${root}${path.sep}`;

    if (entries.length === 0) {
        throw new Error("The Jadges plugin folder was not found in the repository ZIP.");
    }

    await mkdir(destination, { recursive: true });

    for (let index = 0; index < entries.length; index++) {
        const [archivePath, data] = entries[index];
        const relative = archivePath.slice(ARCHIVE_PLUGIN_PREFIX.length);
        const normalized = path.posix.normalize(relative);

        if (normalized === ".." || normalized.startsWith("../")) {
            throw new Error("The repository ZIP contains an unsafe path.");
        }

        const target = path.resolve(destination, ...normalized.split("/"));
        if (!target.startsWith(rootPrefix)) {
            throw new Error("The repository ZIP contains an unsafe path.");
        }

        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(data));

        await updateInstaller(ui, {
            percent: 46 + Math.floor(((index + 1) / entries.length) * 14),
            status: "Extracting the Jadges plugin…",
            log: `Extracted ${normalized}`
        });
    }
}

async function validatePluginFolder(ui: InstallerUi, folder: string): Promise<void> {
    await updateInstaller(ui, {
        percent: 62,
        status: "Verifying the extracted plugin…",
        log: "Checking required plugin files"
    });

    for (const filename of REQUIRED_PLUGIN_FILES) {
        if (!await exists(path.join(folder, filename))) {
            throw new Error(`The repository ZIP is missing ${filename}.`);
        }
        await updateInstaller(ui, {
            percent: 63,
            status: "Verifying the extracted plugin…",
            log: `Verified ${filename}`,
            logType: "success"
        });
    }
}

function buildProcess(
    ui: InstallerUi,
    command: string,
    args: string[],
    root: string,
    startPercent: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let progress = startPercent;
        let output = "";

        const child = spawn(command, args, {
            cwd: root,
            windowsHide: true,
            shell: false,
            env: process.env
        });

        const progressTimer = setInterval(() => {
            if (progress >= 94) return;
            progress++;
            void updateInstaller(ui, {
                percent: progress,
                status: "Building Vencord…"
            });
        }, 1300);

        const addOutput = (source: "build" | "error", value: Buffer | string) => {
            const text = String(value);
            output = `${output}${text}`.slice(-6000);

            for (const line of text.split(/\r?\n/)) {
                const clean = line.trimEnd();
                if (!clean) continue;
                const actualError = source === "error"
                    && /(?:^|\b)(?:error|failed|failure|fatal|exception|enoent|eacces)(?:\b|:)/i.test(clean);
                const label = actualError ? "error" : "build";
                void updateInstaller(ui, {
                    percent: progress,
                    status: "Building Vencord…",
                    log: `[${label}] ${clean}`,
                    logType: actualError ? "error" : undefined
                });
            }
        };

        child.stdout?.on("data", value => addOutput("build", value));
        child.stderr?.on("data", value => addOutput("error", value));

        child.once("error", error => {
            if (settled) return;
            settled = true;
            clearInterval(progressTimer);
            reject(error);
        });

        child.once("close", code => {
            if (settled) return;
            settled = true;
            clearInterval(progressTimer);

            if (code === 0) {
                resolve();
                return;
            }

            const details = output.trim().slice(-1800);
            reject(new Error(details || `Vencord build exited with code ${code ?? "unknown"}.`));
        });
    });
}

async function runPnpmBuild(ui: InstallerUi, root: string, startPercent = 76): Promise<void> {
    await updateInstaller(ui, {
        percent: startPercent,
        status: "Building Vencord…",
        log: "Running pnpm build"
    });

    if (process.platform === "win32") {
        const command = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
        try {
            await buildProcess(ui, command, ["/d", "/s", "/c", "pnpm.cmd build"], root, startPercent);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/not recognized|not found|enoent/i.test(message)) throw error;

            await updateInstaller(ui, {
                percent: startPercent,
                status: "Building Vencord with Corepack…",
                log: "pnpm.cmd was unavailable; trying Corepack"
            });
            await buildProcess(ui, command, ["/d", "/s", "/c", "corepack.cmd pnpm build"], root, startPercent);
        }
        return;
    }

    await buildProcess(ui, "pnpm", ["build"], root, startPercent);
}

function scheduleDiscordRestart(ui: InstallerUi): void {
    const timer = setTimeout(() => {
        ui.allowClose = true;
        app.relaunch();
        app.exit(0);
    }, 1400);
    timer.unref();
}

export async function installLatestUpdate(
    _: IpcMainInvokeEvent
): Promise<JadgesUpdateResult> {
    const ui = await createInstallerUi();
    let root: string | undefined;
    let staging: string | undefined;
    let backup: string | undefined;
    let plugin: string | undefined;
    let movedOld = false;
    let installedNew = false;

    try {
        await updateInstaller(ui, {
            percent: 2,
            status: "Freezing Discord and starting the installer…",
            log: "Discord interface paused"
        });

        root = await findVencordRoot();
        if (!root) {
            throw new Error("Vencord source was not found. Put it in your user folder as Vencord, or set VENCORD_ROOT.");
        }

        await updateInstaller(ui, {
            percent: 5,
            status: "Vencord source located",
            log: `Vencord folder: ${root}`,
            logType: "success"
        });

        const userplugins = path.join(root, "src", "userplugins");
        plugin = path.join(userplugins, PLUGIN_FOLDER_NAME);
        const suffix = `${Date.now()}-${randomUUID()}`;
        staging = path.join(userplugins, `.${PLUGIN_FOLDER_NAME}-update-${suffix}`);
        backup = path.join(userplugins, `.${PLUGIN_FOLDER_NAME}-backup-${suffix}`);

        const version = await fetchLatestVersion(ui);
        const archive = await downloadRepositoryZip(ui);
        await extractPluginFromZip(ui, archive, staging);
        await validatePluginFolder(ui, staging);

        await updateInstaller(ui, {
            percent: 67,
            status: "Replacing the old Jadges plugin…",
            log: "Preparing the existing plugin backup"
        });

        if (await exists(plugin)) {
            await rename(plugin, backup);
            movedOld = true;
            await updateInstaller(ui, {
                percent: 70,
                status: "Replacing the old Jadges plugin…",
                log: "Old plugin moved to a temporary backup"
            });
        }

        await rename(staging, plugin);
        installedNew = true;
        await updateInstaller(ui, {
            percent: 74,
            status: "New Jadges files installed",
            log: "New plugin folder moved into userplugins",
            logType: "success"
        });

        await runPnpmBuild(ui, root);

        await updateInstaller(ui, {
            percent: 96,
            status: "Cleaning up the update…",
            log: "Vencord build completed",
            logType: "success"
        });

        if (movedOld && backup) await rm(backup, { recursive: true, force: true });

        await updateInstaller(ui, {
            percent: 100,
            heading: "Update installed",
            status: "Jadges is ready. Restarting Discord…",
            log: "Installation reached 100%. Restarting Discord now.",
            logType: "success",
            complete: true
        });

        scheduleDiscordRestart(ui);
        return {
            ok: true,
            version,
            message: "Jadges was installed and Discord is restarting."
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "The update failed.";

        await updateInstaller(ui, {
            percent: 96,
            heading: "Restoring the previous version…",
            status: "The update failed, so Jadges is rolling back safely.",
            log: reason,
            logType: "error"
        });

        try {
            if (installedNew && plugin) await rm(plugin, { recursive: true, force: true });
            if (movedOld && backup && plugin && await exists(backup)) {
                await rename(backup, plugin);
                await updateInstaller(ui, {
                    percent: 97,
                    status: "Previous plugin restored",
                    log: "Restored the previous Jadges folder",
                    logType: "success"
                });
            }
            if (staging && await exists(staging)) {
                await rm(staging, { recursive: true, force: true });
            }
            if (movedOld && root) await runPnpmBuild(ui, root, 97);
        } catch (rollbackError) {
            const recovery = rollbackError instanceof Error
                ? rollbackError.message
                : "Automatic recovery failed.";
            ui.canReturn = true;
            await updateInstaller(ui, {
                percent: 100,
                heading: "Update and recovery failed",
                status: "Review the logs below, then return to Discord.",
                log: recovery,
                logType: "error",
                error: true,
                showReturn: true
            });
            return {
                ok: false,
                message: `Update failed: ${reason}. Recovery failed: ${recovery}`
            };
        }

        ui.canReturn = true;
        await updateInstaller(ui, {
            percent: 100,
            heading: "Update was not installed",
            status: "Your previous Jadges version was restored safely.",
            log: "Rollback completed successfully",
            logType: "success",
            error: true,
            showReturn: true
        });
        return {
            ok: false,
            message: `The update was rolled back: ${reason}`
        };
    }
}
