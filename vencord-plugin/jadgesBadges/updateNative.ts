import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { app } from "electron";
import type { IpcMainInvokeEvent } from "electron";

const execFileAsync = promisify(execFile);
const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const REPOSITORY_ZIP_URL =
    "https://github.com/thatcodingdude23/Jadges/archive/refs/heads/main.zip";
const ARCHIVE_PLUGIN_PATH = path.join(
    "Jadges-main",
    "vencord-plugin",
    "jadgesBadges"
);
const PLUGIN_FOLDER_NAME = "jadgesBadges";
const REQUIRED_PLUGIN_FILES = [
    "index.tsx",
    "base.tsx",
    "native.ts",
    "style.css",
    "updater.ts",
    "updateNative.ts"
] as const;

interface UpdateManifest {
    version: number;
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

async function runCommand(
    command: string,
    args: string[],
    cwd?: string,
    timeout = 5 * 60 * 1000
): Promise<void> {
    try {
        await execFileAsync(command, args, {
            cwd,
            windowsHide: true,
            timeout,
            maxBuffer: 16 * 1024 * 1024
        });
    } catch (error) {
        const details = error as { stderr?: string; stdout?: string; message?: string };
        const output = String(details.stderr || details.stdout || details.message || error)
            .trim()
            .slice(-1800);
        throw new Error(output || `${command} failed`);
    }
}

function powershellLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

async function extractZip(zipFile: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });

    if (process.platform === "win32") {
        await runCommand("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `Expand-Archive -LiteralPath ${powershellLiteral(zipFile)} -DestinationPath ${powershellLiteral(destination)} -Force`
        ]);
        return;
    }

    if (process.platform === "darwin") {
        await runCommand("ditto", ["-x", "-k", zipFile, destination]);
        return;
    }

    await runCommand("unzip", ["-q", "-o", zipFile, "-d", destination]);
}

async function downloadRepositoryZip(target: string): Promise<void> {
    const response = await fetch(`${REPOSITORY_ZIP_URL}?t=${Date.now()}`, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(60_000)
    });

    if (!response.ok) {
        throw new Error(`Repository ZIP download returned HTTP ${response.status}`);
    }

    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length < 100) throw new Error("The downloaded repository ZIP was empty.");
    await writeFile(target, archive);
}

async function fetchLatestVersion(): Promise<number> {
    const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Update information returned HTTP ${response.status}`);

    const manifest = await response.json() as UpdateManifest;
    if (!Number.isSafeInteger(manifest.version) || manifest.version <= 0) {
        throw new Error("The update information is invalid.");
    }
    return manifest.version;
}

async function validatePluginFolder(folder: string): Promise<void> {
    for (const filename of REQUIRED_PLUGIN_FILES) {
        if (!await exists(path.join(folder, filename))) {
            throw new Error(`The repository ZIP is missing ${filename}.`);
        }
    }
}

async function runPnpmBuild(root: string): Promise<void> {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    await runCommand(command, ["build"], root);
}

function scheduleDiscordRestart(): void {
    const timer = setTimeout(() => {
        app.relaunch();
        app.exit(0);
    }, 1500);
    timer.unref();
}

export async function installLatestUpdate(
    _: IpcMainInvokeEvent
): Promise<JadgesUpdateResult> {
    const root = await findVencordRoot();
    if (!root) {
        return {
            ok: false,
            message: "Vencord source was not found. Put it in your user folder as Vencord, or set VENCORD_ROOT."
        };
    }

    const userplugins = path.join(root, "src", "userplugins");
    const plugin = path.join(userplugins, PLUGIN_FOLDER_NAME);
    const suffix = `${Date.now()}-${randomUUID()}`;
    const staging = path.join(userplugins, `.${PLUGIN_FOLDER_NAME}-update-${suffix}`);
    const backup = path.join(userplugins, `.${PLUGIN_FOLDER_NAME}-backup-${suffix}`);
    const temporary = await mkdtemp(path.join(tmpdir(), "jadges-update-"));
    const archive = path.join(temporary, "Jadges-main.zip");
    const extracted = path.join(temporary, "extracted");

    let movedOld = false;
    let installedNew = false;

    try {
        const version = await fetchLatestVersion();
        await downloadRepositoryZip(archive);
        await extractZip(archive, extracted);

        const source = path.join(extracted, ARCHIVE_PLUGIN_PATH);
        await validatePluginFolder(source);
        await cp(source, staging, {
            recursive: true,
            force: false,
            errorOnExist: true
        });

        if (await exists(plugin)) {
            await rename(plugin, backup);
            movedOld = true;
        }

        await rename(staging, plugin);
        installedNew = true;

        await runPnpmBuild(root);

        if (movedOld) await rm(backup, { recursive: true, force: true });
        scheduleDiscordRestart();

        return {
            ok: true,
            version,
            message: "Jadges was replaced from the repository ZIP and rebuilt. Discord is restarting."
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "The update failed.";

        try {
            if (installedNew) await rm(plugin, { recursive: true, force: true });
            if (movedOld && await exists(backup)) await rename(backup, plugin);
            if (await exists(staging)) await rm(staging, { recursive: true, force: true });
            if (movedOld) await runPnpmBuild(root);
        } catch (rollbackError) {
            const recovery = rollbackError instanceof Error
                ? rollbackError.message
                : "Automatic recovery failed.";
            return {
                ok: false,
                message: `Update failed: ${reason}. Recovery failed: ${recovery}`
            };
        }

        return {
            ok: false,
            message: `The update was rolled back: ${reason}`
        };
    } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
}
