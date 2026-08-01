import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { IpcMainInvokeEvent } from "electron";

const execFileAsync = promisify(execFile);
const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/update.json";
const RAW_PLUGIN_ROOT =
    "https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/vencord-plugin/jadgesBadges/";
const PLUGIN_FOLDER_NAME = "jadgesBadges";
const ALLOWED_FILES = new Set([
    "index.tsx",
    "base.tsx",
    "native.ts",
    "style.css",
    "updater.ts",
    "updateNative.ts"
]);

interface UpdateFile {
    path: string;
    sha256: string;
}

interface UpdateManifest {
    version: number;
    files: UpdateFile[];
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

function sha256(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

async function fetchText(url: string): Promise<string> {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${separator}t=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Download returned HTTP ${response.status}`);
    return response.text();
}

async function fetchManifest(): Promise<UpdateManifest> {
    const manifest = JSON.parse(await fetchText(UPDATE_MANIFEST_URL)) as UpdateManifest;

    if (
        !Number.isSafeInteger(manifest.version)
        || !Array.isArray(manifest.files)
        || manifest.files.length !== ALLOWED_FILES.size
    ) {
        throw new Error("The update manifest is invalid.");
    }

    const paths = new Set<string>();
    for (const file of manifest.files) {
        if (
            !file
            || !ALLOWED_FILES.has(file.path)
            || paths.has(file.path)
            || !/^[a-f0-9]{64}$/i.test(file.sha256)
        ) {
            throw new Error("The update manifest contains an invalid file.");
        }
        paths.add(file.path);
    }

    return manifest;
}

async function runPnpm(
    root: string,
    script: "build" | "inject"
): Promise<void> {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

    try {
        await execFileAsync(command, [script], {
            cwd: root,
            windowsHide: true,
            timeout: 5 * 60 * 1000,
            maxBuffer: 16 * 1024 * 1024
        });
    } catch (error) {
        const details = error as { stderr?: string; stdout?: string; message?: string };
        const output = String(details.stderr || details.stdout || details.message || error)
            .trim()
            .slice(-1500);
        throw new Error(output || `pnpm ${script} failed`);
    }
}

async function buildAndInject(root: string): Promise<void> {
    await runPnpm(root, "build");
    await runPnpm(root, "inject");
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
    let movedOld = false;
    let installedNew = false;

    try {
        const manifest = await fetchManifest();
        await mkdir(staging);

        for (const file of manifest.files) {
            const content = await fetchText(`${RAW_PLUGIN_ROOT}${file.path}`);
            if (sha256(content) !== file.sha256.toLowerCase()) {
                throw new Error(`Hash check failed for ${file.path}`);
            }
            await writeFile(path.join(staging, file.path), content, "utf8");
        }

        if (await exists(plugin)) {
            await rename(plugin, backup);
            movedOld = true;
        }

        await rename(staging, plugin);
        installedNew = true;
        await buildAndInject(root);

        if (movedOld) await rm(backup, { recursive: true, force: true });
        return {
            ok: true,
            version: manifest.version,
            message: "Jadges was updated, rebuilt, and injected successfully."
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "The update failed.";

        try {
            if (installedNew) await rm(plugin, { recursive: true, force: true });
            if (movedOld && await exists(backup)) await rename(backup, plugin);
            if (await exists(staging)) await rm(staging, { recursive: true, force: true });
            if (movedOld) await buildAndInject(root);
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
    }
}
