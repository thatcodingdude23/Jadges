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
const ALLOWED_UPDATE_FILES = new Set([
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
    return (
        await exists(path.join(candidate, "package.json"))
        && await exists(path.join(candidate, "src", "userplugins"))
    );
}

function parentCandidates(start: string): string[] {
    const result: string[] = [];
    let current = path.resolve(start);

    while (true) {
        result.push(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return result;
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
        path.join(home, "Downloads", "Vencord"),
        path.join(home, "source", "Vencord"),
        path.join(home, "dev", "Vencord")
    ]);

    for (const candidate of candidates) {
        if (await isVencordRoot(candidate)) return path.resolve(candidate);
    }

    return undefined;
}

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
        throw new Error(`Download returned HTTP ${response.status}`);
    }

    return response.text();
}

async function fetchManifest(): Promise<UpdateManifest> {
    const text = await fetchText(UPDATE_MANIFEST_URL);
    const manifest = JSON.parse(text) as UpdateManifest;

    if (
        !Number.isSafeInteger(manifest.version)
        || !Array.isArray(manifest.files)
        || manifest.files.length === 0
    ) {
        throw new Error("The update manifest is invalid");
    }

    for (const file of manifest.files) {
        if (
            !file
            || typeof file.path !== "string"
            || !ALLOWED_UPDATE_FILES.has(file.path)
            || typeof file.sha256 !== "string"
            || !/^[a-f0-9]{64}$/i.test(file.sha256)
        ) {
            throw new Error("The update manifest contains an invalid file");
        }
    }

    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) {
        throw new Error("The update manifest contains duplicate files");
    }

    return manifest;
}

async function runBuild(vencordRoot: string): Promise<void> {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

    try {
        await execFileAsync(command, ["build"], {
            cwd: vencordRoot,
            windowsHide: true,
            timeout: 5 * 60 * 1000,
            maxBuffer: 16 * 1024 * 1024
        });
    } catch (error) {
        const details = error as {
            stderr?: string;
            stdout?: string;
            message?: string;
        };
        const output = String(details.stderr || details.stdout || details.message || error)
            .trim()
            .slice(-1500);
        throw new Error(output || "pnpm build failed");
    }
}

export async function installLatestUpdate(
    _: IpcMainInvokeEvent
): Promise<JadgesUpdateResult> {
    const vencordRoot = await findVencordRoot();

    if (!vencordRoot) {
        return {
            ok: false,
            message:
                "I could not find your Vencord source folder. Put it in your user folder as Vencord, or set the VENCORD_ROOT environment variable."
        };
    }

    const userpluginsDir = path.join(vencordRoot, "src", "userplugins");
    const pluginDir = path.join(userpluginsDir, PLUGIN_FOLDER_NAME);
    const suffix = `${Date.now()}-${randomUUID()}`;
    const stagingDir = path.join(userpluginsDir, `.${PLUGIN_FOLDER_NAME}-update-${suffix}`);
    const backupDir = path.join(userpluginsDir, `.${PLUGIN_FOLDER_NAME}-backup-${suffix}`);

    let oldPluginMoved = false;
    let newPluginInstalled = false;

    try {
        const manifest = await fetchManifest();
        await mkdir(stagingDir, { recursive: false });

        for (const file of manifest.files) {
            const content = await fetchText(`${RAW_PLUGIN_ROOT}${file.path}`);
            const actualHash = sha256(content);

            if (actualHash !== file.sha256.toLowerCase()) {
                throw new Error(`Hash check failed for ${file.path}`);
            }

            await writeFile(path.join(stagingDir, file.path), content, "utf8");
        }

        if (await exists(pluginDir)) {
            await rename(pluginDir, backupDir);
            oldPluginMoved = true;
        }

        await rename(stagingDir, pluginDir);
        newPluginInstalled = true;

        await runBuild(vencordRoot);

        if (oldPluginMoved) {
            await rm(backupDir, { recursive: true, force: true });
        }

        return {
            ok: true,
            version: manifest.version,
            message: "Jadges was updated successfully."
        };
    } catch (error) {
        try {
            if (newPluginInstalled) {
                await rm(pluginDir, { recursive: true, force: true });
            }
            if (oldPluginMoved && await exists(backupDir)) {
                await rename(backupDir, pluginDir);
            }
            if (await exists(stagingDir)) {
                await rm(stagingDir, { recursive: true, force: true });
            }
        } catch (rollbackError) {
            console.error("[JadgesBadges] Update rollback failed:", rollbackError);
        }

        return {
            ok: false,
            message:
                error instanceof Error
                    ? `The update was rolled back: ${error.message}`
                    : "The update failed and was rolled back."
        };
    }
}
