import { UserStore } from "@webpack/common";

const API_ORIGIN = "https://jadges.onrender.com";
const STORAGE_KEY = "jadges.clientAuthorizationToken";
const RETRY_AFTER_MS = 8_000;

type ConnectionStart = {
    deviceCode?: string;
    pollSecret?: string;
    authorizeUrl?: string;
    expiresAt?: string;
    intervalMs?: number;
};

type ConnectionPoll = {
    status?: string;
    token?: string;
    expiresAt?: string;
    error?: string;
};

let connecting = false;
let stopped = false;
let abortController: AbortController | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function clientAuthorizationToken(): string {
    try {
        return String(localStorage.getItem(STORAGE_KEY) || "").trim();
    } catch {
        return "";
    }
}

function saveToken(token: string): void {
    try {
        localStorage.setItem(STORAGE_KEY, token);
    } catch (error) {
        console.warn("[JadgesBadges] Could not save client authorization:", error);
    }
}

function clearToken(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {}
}

function scheduleRetry(): void {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void ensureClientAuthorization(), RETRY_AFTER_MS);
}

function openAuthorizationPage(url: string): void {
    const popup = window.open(url, "_blank", "noopener,noreferrer");
    if (!popup) {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.style.display = "none";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

async function startConnection(userId: string, signal: AbortSignal): Promise<void> {
    const startResponse = await fetch(`${API_ORIGIN}/api/client-connect/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, client: "Vencord" }),
        cache: "no-store",
        credentials: "omit",
        signal
    });
    const start = await startResponse.json().catch(() => ({})) as ConnectionStart & { error?: string; };
    if (!startResponse.ok) {
        throw new Error(start.error || `Jadges connection returned HTTP ${startResponse.status}`);
    }
    if (!start.deviceCode || !start.pollSecret || !start.authorizeUrl) {
        throw new Error("Jadges returned an incomplete connection request");
    }

    openAuthorizationPage(start.authorizeUrl);
    const interval = Math.max(1_000, Math.min(5_000, Number(start.intervalMs) || 2_000));
    const deadline = Date.parse(start.expiresAt || "") || Date.now() + 10 * 60_000;

    while (!signal.aborted && Date.now() < deadline) {
        await wait(interval, signal);
        const pollResponse = await fetch(`${API_ORIGIN}/api/client-connect/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                deviceCode: start.deviceCode,
                pollSecret: start.pollSecret
            }),
            cache: "no-store",
            credentials: "omit",
            signal
        });
        const poll = await pollResponse.json().catch(() => ({})) as ConnectionPoll;
        if (pollResponse.status === 202 || pollResponse.status === 429) continue;
        if (!pollResponse.ok) {
            throw new Error(poll.error || `Jadges authorization returned HTTP ${pollResponse.status}`);
        }
        if (poll.status === "authorized" && typeof poll.token === "string" && poll.token.startsWith("jdg_")) {
            saveToken(poll.token);
            console.info("[JadgesBadges] Client authorization connected automatically");
            return;
        }
    }

    throw new Error("Jadges authorization expired before it was completed");
}

export async function ensureClientAuthorization(): Promise<void> {
    if (stopped || connecting || clientAuthorizationToken()) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) {
        scheduleRetry();
        return;
    }

    connecting = true;
    clearTimeout(retryTimer);
    abortController?.abort();
    abortController = new AbortController();

    try {
        await startConnection(userId, abortController.signal);
    } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.warn("[JadgesBadges] Automatic authorization failed:", error);
            scheduleRetry();
        }
    } finally {
        connecting = false;
    }
}

export function invalidateClientAuthorization(): void {
    clearToken();
    void ensureClientAuthorization();
}

export function stopClientAuthorization(): void {
    stopped = true;
    connecting = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    abortController?.abort();
    abortController = undefined;
}

export function startClientAuthorization(): void {
    stopped = false;
    void ensureClientAuthorization();
}
