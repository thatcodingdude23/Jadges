import { Settings } from "@api/Settings";

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const PARTNER_GUILD_REFRESH_INTERVAL = 5_000;
const HEADER_COMMUNITY_BADGE_SELECTOR =
    '[class*="guildIconV2Container_"] [aria-label="Community Server"]';
const HOVER_COMMUNITY_BADGE_SELECTOR =
    '[class*="rowGuildName_"] [aria-label="Community Server"]';
const GUILD_NAV_ITEM_SELECTOR = '[data-list-item-id^="guildsnav___"]';
const PARTNER_LABEL = "Discord Partner";
const DISCORD_ID = /^\d{15,22}$/;
const GUILD_NAV_ID = /^guildsnav___(\d{15,22})$/;
const PARTNER_ICON = `<svg aria-hidden="true" role="img" width="13" height="13" viewBox="0 0 16 16"><path d="M10.5906 6.39993L9.19223 7.29993C8.99246 7.39993 8.89258 7.39993 8.69281 7.29993C8.59293 7.19993 8.39317 7.09993 8.29328 6.99993C7.89375 6.89993 7.5941 6.99993 7.29445 7.19993L6.79504 7.49993L4.29797 9.19993C3.69867 9.49993 2.99949 9.39993 2.69984 8.79993C2.30031 8.29993 2.50008 7.59993 2.99949 7.19993L5.99598 5.19993C6.79504 4.69993 7.79387 4.49993 8.69281 4.69993C9.49188 4.89993 10.0912 5.29993 10.5906 5.89993C10.7904 6.09993 10.6905 6.29993 10.5906 6.39993Z" fill="var(--white)"></path><path d="M13.4871 7.79985C13.4871 8.19985 13.2874 8.59985 12.9877 8.79985L9.89135 10.7999C9.29206 11.1999 8.69276 11.3999 7.99358 11.3999C7.69393 11.3999 7.49417 11.3999 7.19452 11.2999C6.39545 11.0999 5.79616 10.6999 5.29674 10.0999C5.19686 9.89985 5.29674 9.69985 5.39663 9.59985L6.79499 8.69985C6.89487 8.59985 7.09463 8.59985 7.19452 8.69985C7.39428 8.79985 7.59405 8.89985 7.69393 8.99985C8.09346 8.99985 8.39311 8.99985 8.69276 8.79985L9.39194 8.39985L11.3896 6.99985L11.6892 6.79985C12.1887 6.49985 12.9877 6.59985 13.2874 7.09985C13.4871 7.39985 13.4871 7.59985 13.4871 7.79985Z" fill="var(--white)"></path></svg>`;

interface PartnerGuildResponse {
    guildIds?: unknown;
}

interface PatchedGuildBadge {
    guildId: string;
    label: string | null;
    flowerFill: string | null;
    childHtml: string;
}

let partnerGuildIds = new Set<string>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let observer: MutationObserver | undefined;
let applying = false;
let applyQueued = false;
const patchedBadges = new Map<HTMLElement, PatchedGuildBadge>();

function normalizeApiUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    return url || DEFAULT_API_URL;
}

function apiRoot(): string {
    return normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl)
        .replace(/\/badges\.json(?:\?.*)?$/, "");
}

function currentGuildId(): string | undefined {
    return /^\/channels\/(\d{15,22})(?:\/|$)/.exec(location.pathname)?.[1];
}

function guildIdFromHoverTooltip(target: HTMLElement): string | undefined {
    const listItem = target.closest<HTMLElement>('[class*="listItem_"]');
    const guildItem = listItem?.querySelector<HTMLElement>(GUILD_NAV_ITEM_SELECTOR);
    const listItemId = guildItem?.getAttribute("data-list-item-id") || "";
    return GUILD_NAV_ID.exec(listItemId)?.[1];
}

function guildIdForBadge(target: HTMLElement): string | undefined {
    const hoverGuildId = guildIdFromHoverTooltip(target);
    if (hoverGuildId) return hoverGuildId;

    if (target.closest('[class*="guildIconV2Container_"]')) {
        return currentGuildId();
    }

    return undefined;
}

function normalizePartnerGuildIds(value: unknown): Set<string> {
    const source: unknown[] = Array.isArray(value)
        ? value
        : value && typeof value === "object" && Array.isArray((value as PartnerGuildResponse).guildIds)
            ? (value as PartnerGuildResponse).guildIds as unknown[]
            : [];

    return new Set(
        source.filter((guildId): guildId is string =>
            typeof guildId === "string" && DISCORD_ID.test(guildId)
        )
    );
}

function badgeParts(target: HTMLElement): {
    flowerPath: SVGPathElement;
    child: HTMLElement;
} | undefined {
    const flowerPath = target.querySelector<SVGPathElement>(
        'svg[class*="flowerStar_"] path'
    );
    const child = target.querySelector<HTMLElement>('[class*="childContainer_"]');
    if (!flowerPath || !child) return undefined;
    return { flowerPath, child };
}

function restorePatchedBadge(target: HTMLElement, state: PatchedGuildBadge): void {
    if (!target.isConnected) {
        patchedBadges.delete(target);
        return;
    }

    if (target.getAttribute("aria-label") !== PARTNER_LABEL) {
        patchedBadges.delete(target);
        return;
    }

    const parts = badgeParts(target);
    if (!parts) {
        patchedBadges.delete(target);
        return;
    }

    if (state.label === null) target.removeAttribute("aria-label");
    else target.setAttribute("aria-label", state.label);

    if (state.flowerFill === null) parts.flowerPath.removeAttribute("fill");
    else parts.flowerPath.setAttribute("fill", state.flowerFill);
    if (parts.child.innerHTML !== state.childHtml) parts.child.innerHTML = state.childHtml;
    patchedBadges.delete(target);
}

function patchCommunityBadge(target: HTMLElement, guildId: string): void {
    const parts = badgeParts(target);
    if (!parts) return;

    let state = patchedBadges.get(target);
    if (!state) {
        state = {
            guildId,
            label: target.getAttribute("aria-label"),
            flowerFill: parts.flowerPath.getAttribute("fill"),
            childHtml: parts.child.innerHTML
        };
        patchedBadges.set(target, state);
    }

    const currentLabel = target.getAttribute("aria-label");
    if (currentLabel !== PARTNER_LABEL && currentLabel !== state.label) {
        patchedBadges.delete(target);
        return;
    }

    if (currentLabel !== PARTNER_LABEL) target.setAttribute("aria-label", PARTNER_LABEL);
    if (parts.flowerPath.getAttribute("fill") !== "var(--brand-500)") {
        parts.flowerPath.setAttribute("fill", "var(--brand-500)");
    }
    if (parts.child.innerHTML !== PARTNER_ICON) parts.child.innerHTML = PARTNER_ICON;
}

function applyPartnerGuildBadge(): void {
    if (applying) return;
    applying = true;

    try {
        for (const [target, state] of [...patchedBadges]) {
            if (!target.isConnected) {
                patchedBadges.delete(target);
                continue;
            }

            const guildId = guildIdForBadge(target);
            if (!guildId || !partnerGuildIds.has(guildId) || state.guildId !== guildId) {
                restorePatchedBadge(target, state);
                continue;
            }

            patchCommunityBadge(target, guildId);
        }

        const selectors = `${HEADER_COMMUNITY_BADGE_SELECTOR}, ${HOVER_COMMUNITY_BADGE_SELECTOR}`;
        for (const target of document.querySelectorAll<HTMLElement>(selectors)) {
            const guildId = guildIdForBadge(target);
            if (!guildId || !partnerGuildIds.has(guildId)) continue;
            patchCommunityBadge(target, guildId);
        }
    } finally {
        applying = false;
    }
}

function scheduleApply(): void {
    if (applyQueued) return;
    applyQueued = true;
    queueMicrotask(() => {
        applyQueued = false;
        applyPartnerGuildBadge();
    });
}

async function refreshPartnerGuilds(): Promise<void> {
    try {
        const response = await fetch(`${apiRoot()}/partner-guilds.json?t=${Date.now()}`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) {
            throw new Error(`Jadges partner guilds returned HTTP ${response.status}`);
        }

        partnerGuildIds = normalizePartnerGuildIds(await response.json());
        scheduleApply();
    } catch (error) {
        console.warn("[JadgesBadges] Could not synchronize partner guilds:", error);
    }
}

export function startPartnerGuildSync(): void {
    clearInterval(refreshTimer);
    observer?.disconnect();

    observer = new MutationObserver(() => scheduleApply());
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "data-list-item-id"]
    });

    void refreshPartnerGuilds();
    scheduleApply();
    refreshTimer = setInterval(
        () => void refreshPartnerGuilds(),
        PARTNER_GUILD_REFRESH_INTERVAL
    );
}

export function stopPartnerGuildSync(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    partnerGuildIds.clear();
    applyQueued = false;

    for (const [target, state] of [...patchedBadges]) {
        restorePatchedBadge(target, state);
    }
    patchedBadges.clear();
}
