/*
 * Jadges profile badges for Vencord
 * Adds approved custom badges, Nitro presets, native Discord badge ordering,
 * badge placement, native badge removal, and a badge directory popup.
 */

import "./style.css";

import {
    addProfileBadge,
    BadgePosition,
    type BadgeUserArgs,
    type ProfileBadge,
    removeProfileBadge
} from "@api/Badges";
import { Settings } from "@api/Settings";
import { ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

type NitroKey =
    | "bronze"
    | "silver"
    | "gold"
    | "platinum"
    | "diamond"
    | "emerald"
    | "ruby"
    | "opal"
    | "remove";

type BadgeSide = "left" | "right";

interface NitroPreset {
    key: NitroKey;
    label: string;
    months: number;
    profileIcon: string;
    mobileIcon?: string;
    hoverImage: string;
    subscriberSince: string;
    hideNativeBadges?: boolean;
}

interface PublicNativeBadge {
    key: string;
    name: string;
    image: string;
}

interface JadgesBadge {
    key?: string;
    name?: string;
    tooltip?: string;
    badge: string;
    createdAt?: string;
    side?: BadgeSide;
    nitro?: NitroPreset;
    metadata?: boolean;
    order?: string[];
    nativeBadges?: PublicNativeBadge[];
}

interface JadgesSettings {
    side: BadgeSide;
    order: string[];
    nativeBadges: PublicNativeBadge[];
}

type JadgesResponse = Record<string, JadgesBadge[]>;
type BadgeSettingsResponse = Record<string, {
    side?: BadgeSide;
    order?: string[];
    nativeBadges?: PublicNativeBadge[];
}>;

type NativeDiscordBadge = ProfileBadge & {
    id: string;
    iconSrc: string;
};

interface DirectoryEntry {
    id: string;
    title: string;
    icon: string;
    detailImage: string;
    subtitle: string;
    description: string;
    nitro?: NitroPreset;
}

interface NativeControl {
    control: HTMLElement;
    key: string;
    name: string;
    image: string;
}

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;
const NATIVE_REPORT_INTERVAL = 60_000;

const NITRO_TIMELINE = [
    { key: "bronze", label: "Bronze", months: 1, icon: "https://cdn.discordapp.com/assets/content/c5dc1f8986bff763de576a33d2c465f32a3a475a5ce6dbc4a72312f453088188.svg" },
    { key: "silver", label: "Silver", months: 3, icon: "https://cdn.discordapp.com/assets/content/f51ac5f51631c7c2ed16d0b1a6755f2846dafe6cf9fe251ac0a6a090f80cd06a.svg" },
    { key: "gold", label: "Gold", months: 6, icon: "https://cdn.discordapp.com/assets/content/3b2f45966655f984d8281007eb28616801fb16bbe5dd3bf22dc1f34a9c946610.svg" },
    { key: "platinum", label: "Platinum", months: 12, icon: "https://cdn.discordapp.com/assets/content/b87a705edd16d3cc22d0e3fee412e2fe9d75a7b5afccd88ca72fca8b41d924b5.svg" },
    { key: "diamond", label: "Diamond", months: 24, icon: "https://cdn.discordapp.com/assets/content/460eee7bd8bf7539132d7b57377239c2189edaada600673d8a05f90eb661816a.svg" },
    { key: "emerald", label: "Emerald", months: 36, icon: "https://cdn.discordapp.com/assets/content/4eb3961177fe90543e08d82ccfa21fa90aefbbd38651221568b9ed653d6fedb7.svg" },
    { key: "ruby", label: "Ruby", months: 60, icon: "https://cdn.discordapp.com/assets/content/96a2e93cb1b3dd4eb4699b9d178926228707b192e5a9dafcb61ceef0ddeb183d.svg" },
    { key: "opal", label: "Opal", months: 72, icon: "https://cdn.discordapp.com/assets/content/0cb2f03c88887c7a8a31a348281ba835f6fbec76307f574c96f8ece87c8f7544.svg" }
] as const;

let badgeData: JadgesResponse = {};
let settingsData: BadgeSettingsResponse = {};
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let profileObserver: MutationObserver | undefined;
let lastRenderedUserId: string | undefined;
let reorderingDom = false;

const reportedNative = new Map<string, { signature: string; reportedAt: number; }>();
const originalGroupOrder = new Map<HTMLElement, HTMLElement[]>();

function normalizeApiUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    return url || DEFAULT_API_URL;
}

function apiRoot(): string {
    return normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl)
        .replace(/\/badges\.json(?:\?.*)?$/, "");
}

function formatDate(value: string | undefined, twoDigitYear = false): string {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: twoDigitYear ? "2-digit" : "numeric"
    }).format(date);
}

function getSettings(userId: string): JadgesSettings {
    const badges = badgeData[userId];
    const stored = settingsData[userId];

    const side = stored?.side === "right"
        || (!stored?.side && badges?.some(badge => badge?.side === "right"))
        ? "right"
        : "left";

    return {
        side,
        order: Array.isArray(stored?.order)
            ? stored.order.filter((value): value is string => typeof value === "string")
            : [],
        nativeBadges: Array.isArray(stored?.nativeBadges)
            ? stored.nativeBadges.filter(badge =>
                badge
                && typeof badge.key === "string"
                && typeof badge.name === "string"
                && typeof badge.image === "string"
            )
            : []
    };
}

function getUserNitro(userId: string): NitroPreset | undefined {
    const badges = badgeData[userId];
    if (!Array.isArray(badges)) return undefined;
    return badges.find(badge => badge?.nitro)?.nitro;
}

function removesNativeBadges(nitro: NitroPreset | undefined): boolean {
    return nitro?.hideNativeBadges === true || nitro?.key === "remove";
}

function buildDirectoryEntries(userId: string): DirectoryEntry[] {
    const badges = badgeData[userId];
    if (!Array.isArray(badges)) return [];

    const entries: DirectoryEntry[] = [];

    badges.forEach((badge, index) => {
        if (badge.metadata) return;

        if (badge.nitro) {
            if (removesNativeBadges(badge.nitro)) return;
            entries.push({
                id: `jadges_nitro_${userId}_${index}`,
                title: `Nitro ${badge.nitro.label}`,
                icon: badge.nitro.profileIcon,
                detailImage: badge.nitro.hoverImage || badge.nitro.profileIcon,
                subtitle: `Unlocked on ${formatDate(badge.nitro.subscriberSince, true)}`,
                description: "A Nitro appearance equipped through Jadges.",
                nitro: badge.nitro
            });
            return;
        }

        if (typeof badge.badge !== "string" || !badge.badge.startsWith("https://")) return;
        const title = badge.tooltip || badge.name || "Jadges Badge";
        entries.push({
            id: `jadges_custom_${userId}_${index}`,
            title,
            icon: badge.badge,
            detailImage: badge.badge,
            subtitle: badge.createdAt
                ? `Unlocked on ${formatDate(badge.createdAt, true)}`
                : "Approved through Jadges",
            description: `A profile badge displayed through Jadges. Other Jadges users can also see “${title}”.`
        });
    });

    getSettings(userId).nativeBadges.forEach((badge, index) => {
        entries.push({
            id: `jadges_native_${userId}_${index}`,
            title: badge.name,
            icon: badge.image,
            detailImage: badge.image,
            subtitle: "Native Discord badge",
            description: "A native Discord badge whose position is customized locally by the Jadges plugin."
        });
    });

    return entries;
}

function BadgeDirectoryModal({ userId, modalProps }: { userId: string; modalProps: any; }) {
    const entries = buildDirectoryEntries(userId);
    const [selectedId, setSelectedId] = React.useState(entries[0]?.id);
    const selected = entries.find(entry => entry.id === selectedId) || entries[0];

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} aria-label="Badge Directory">
            <ModalHeader className="jadges-directory-header">
                <div>
                    <h1 className="jadges-directory-heading">Your badges</h1>
                    <div className="jadges-directory-subheading">
                        Browse Jadges and detected Discord profile badges.
                    </div>
                </div>
                <button className="jadges-directory-close" aria-label="Close" onClick={modalProps.onClose}>×</button>
            </ModalHeader>

            <ModalContent className="jadges-directory-content">
                {entries.length === 0 || !selected ? (
                    <div className="jadges-directory-empty">No visible badges were found for this user.</div>
                ) : (
                    <div className="jadges-directory-layout">
                        <section className="jadges-directory-list">
                            <div className="jadges-directory-grid" role="tablist" aria-label="Your badges">
                                {entries.map(entry => (
                                    <button
                                        key={entry.id}
                                        role="tab"
                                        aria-selected={selected.id === entry.id}
                                        aria-label={entry.title}
                                        className={`jadges-directory-slot${selected.id === entry.id ? " jadges-directory-slot-selected" : ""}`}
                                        onClick={() => setSelectedId(entry.id)}
                                    >
                                        <img src={entry.icon} alt="" aria-hidden="true" />
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="jadges-directory-detail" role="tabpanel">
                            <img className="jadges-directory-graphic" src={selected.detailImage} alt="" aria-hidden="true" />
                            <div className="jadges-directory-identity">
                                <h2>{selected.title}</h2>
                                <div>{selected.subtitle}</div>
                            </div>
                            <div className="jadges-directory-card-row">
                                <div className="jadges-directory-stat-card">
                                    <strong>{selected.nitro ? "Rare" : "Badge"}</strong>
                                    <span>{selected.nitro ? "Rarity" : "Badge type"}</span>
                                </div>
                                <div className="jadges-directory-description-card"><div>{selected.description}</div></div>
                            </div>

                            {selected.nitro && (
                                <div className="jadges-directory-timeline-wrap">
                                    <div className="jadges-directory-tier-note">Unlock more tiers the longer you have Nitro</div>
                                    <div className="jadges-directory-timeline" role="list">
                                        {NITRO_TIMELINE.map(tier => {
                                            const unlocked = tier.months <= selected.nitro!.months;
                                            return (
                                                <div key={tier.key} role="listitem" className={`jadges-directory-tier${unlocked ? "" : " jadges-directory-tier-locked"}`}>
                                                    <img src={tier.icon} alt="" aria-hidden="true" />
                                                    <strong>{tier.label}</strong>
                                                    <span>{tier.months >= 12
                                                        ? `${tier.months / 12} year${tier.months === 12 ? "" : "s"}`
                                                        : `${tier.months} month${tier.months === 1 ? "" : "s"}`}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </section>
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

function openBadgeDirectory(userId: string): void {
    openModal(modalProps => <BadgeDirectoryModal userId={userId} modalProps={modalProps} />);
}

function valueStrings(control: HTMLElement, image: HTMLImageElement): string[] {
    return [
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("href"),
        image.getAttribute("alt"),
        image.currentSrc,
        image.src
    ].filter((value): value is string => Boolean(value));
}

function slug(value: string): string {
    return value
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72);
}

function nativeKey(values: string[]): string | undefined {
    const text = values.join(" ").toLowerCase();

    if (
        text.includes("server boosting")
        || text.includes("guild-boosting")
        || text.includes("premium guild subscriber")
        || text.includes("51040c70d4f20a921ad6674ff86fc95c")
    ) {
        return "discord:boosting";
    }

    if (
        text.includes("subscriber since")
        || text.includes("settings/premium")
        || text.includes("discord nitro")
    ) {
        return "discord:nitro";
    }

    const image = values.find(value => /^https:\/\//i.test(value));
    const hash = image?.match(/(?:badge-icons|assets\/content)\/([a-z0-9_-]{8,})/i)?.[1];
    if (hash) return `discord:icon-${hash.toLowerCase()}`;

    const seed = values.find(value => value.trim().length > 0);
    const normalized = seed ? slug(seed) : "";
    return normalized ? `discord:${normalized}` : undefined;
}

function nativeName(values: string[]): string {
    const preferred = values.find(value =>
        !/^https:\/\//i.test(value)
        && !value.startsWith("/")
        && value.trim().length > 0
    );
    return preferred?.trim().slice(0, 100) || "Discord Badge";
}

function controlFromImage(image: HTMLImageElement): HTMLElement | undefined {
    return image.closest<HTMLElement>("a, button") || image.parentElement || undefined;
}

function collectBadgeGroups(): Map<HTMLElement, HTMLElement[]> {
    const groups = new Map<HTMLElement, HTMLElement[]>();
    const seen = new Set<HTMLElement>();

    document
        .querySelectorAll<HTMLImageElement>('img[class*="badge"], img.jadges-profile-badge-image')
        .forEach(image => {
            const control = controlFromImage(image);
            const parent = control?.parentElement;
            if (!control || !parent || seen.has(control)) return;
            seen.add(control);
            const group = groups.get(parent) || [];
            group.push(control);
            groups.set(parent, group);
        });

    for (const [parent, controls] of [...groups]) {
        const hasJadges = controls.some(control =>
            Boolean(control.querySelector("[data-jadges-key]"))
        );
        if (!hasJadges && controls.length < 2) groups.delete(parent);
    }

    return groups;
}

function nativeControl(control: HTMLElement): NativeControl | undefined {
    const image = control.querySelector<HTMLImageElement>('img[class*="badge"]');
    if (!image || image.classList.contains("jadges-profile-badge-image")) return undefined;
    const values = valueStrings(control, image);
    const key = nativeKey(values);
    const source = image.currentSrc || image.src;
    if (!key || !source?.startsWith("https://")) return undefined;

    return {
        control,
        key,
        name: nativeName(values),
        image: source
    };
}

async function reportNativeBadges(userId: string, badges: PublicNativeBadge[]): Promise<void> {
    const unique = [...new Map(badges.map(badge => [badge.key, badge])).values()].slice(0, 25);
    const signature = JSON.stringify(unique);
    const previous = reportedNative.get(userId);
    const now = Date.now();

    if (
        previous
        && previous.signature === signature
        && now - previous.reportedAt < NATIVE_REPORT_INTERVAL
    ) {
        return;
    }

    reportedNative.set(userId, { signature, reportedAt: now });

    try {
        await fetch(`${apiRoot()}/api/native-badges`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId, badges: unique }),
            credentials: "omit",
            cache: "no-store"
        });
    } catch (error) {
        console.warn("[JadgesBadges] Could not report native badges:", error);
    }
}

function keyForControl(control: HTMLElement): { key?: string; isJadges: boolean; native?: NativeControl; } {
    const jadgesImage = control.querySelector<HTMLImageElement>("[data-jadges-key]");
    const jadgesKey = jadgesImage?.dataset.jadgesKey;
    if (jadgesKey) return { key: jadgesKey, isJadges: true };

    const native = nativeControl(control);
    return { key: native?.key, isJadges: false, native };
}

function reorderGroup(
    parent: HTMLElement,
    controls: HTMLElement[],
    settings: JadgesSettings
): PublicNativeBadge[] {
    if (!originalGroupOrder.has(parent)) {
        originalGroupOrder.set(parent, [...controls]);
    }

    const rank = new Map(settings.order.map((key, index) => [key, index]));
    const entries = controls.map((control, index) => ({
        control,
        index,
        ...keyForControl(control)
    }));

    const nativeBadges = entries
        .map(entry => entry.native)
        .filter((badge): badge is NativeControl => Boolean(badge))
        .map(badge => ({ key: badge.key, name: badge.name, image: badge.image }));

    const fallbackRank = (entry: typeof entries[number]): number => {
        if (entry.key === "staff") return -100_000;
        const explicit = entry.key ? rank.get(entry.key) : undefined;
        if (explicit !== undefined) return explicit;
        const group = settings.side === "left"
            ? (entry.isJadges ? 0 : 1)
            : (entry.isJadges ? 1 : 0);
        return 100_000 + group * 10_000 + entry.index;
    };

    const sorted = [...entries].sort((left, right) =>
        fallbackRank(left) - fallbackRank(right)
    );

    const changed = sorted.some((entry, index) => entry.control !== controls[index]);
    if (changed) {
        reorderingDom = true;
        for (const entry of sorted) parent.append(entry.control);
        queueMicrotask(() => {
            reorderingDom = false;
        });
    }

    return nativeBadges;
}

function setNativeBadgeHidden(selector: string, shouldHide: boolean, kind: "nitro" | "boosting"): void {
    document.querySelectorAll<HTMLAnchorElement>(selector).forEach(anchor => {
        if (!anchor.querySelector('img[class*="badge"]')) return;
        if (shouldHide) {
            if (!anchor.dataset.jadgesOriginalDisplay) {
                anchor.dataset.jadgesOriginalDisplay = anchor.style.display || "__empty__";
            }
            anchor.style.display = "none";
            anchor.dataset.jadgesHiddenKind = kind;
            return;
        }
        if (anchor.dataset.jadgesHiddenKind === kind) {
            const original = anchor.dataset.jadgesOriginalDisplay;
            anchor.style.display = original === "__empty__" ? "" : original || "";
            delete anchor.dataset.jadgesHiddenKind;
            delete anchor.dataset.jadgesOriginalDisplay;
        }
    });
}

function updateNativeNitroVisibility(): void {
    const nitro = lastRenderedUserId ? getUserNitro(lastRenderedUserId) : undefined;
    setNativeBadgeHidden('a[href*="/settings/premium"]', Boolean(nitro), "nitro");
    setNativeBadgeHidden(
        'a[href*="/settings/guild-boosting"], a[aria-label^="Server boosting since"]',
        removesNativeBadges(nitro),
        "boosting"
    );
}

function syncProfileDom(): void {
    if (reorderingDom) return;
    const userId = lastRenderedUserId;
    if (!userId) return;

    updateNativeNitroVisibility();

    const settings = getSettings(userId);
    const collected = new Map<string, PublicNativeBadge>();

    for (const [parent, controls] of collectBadgeGroups()) {
        for (const badge of reorderGroup(parent, controls, settings)) {
            collected.set(badge.key, badge);
        }
    }

    if (collected.size > 0) {
        void reportNativeBadges(userId, [...collected.values()]);
    }
}

function handleProfileBadgeClick(event: MouseEvent): void {
    const target = event.target;
    const userId = lastRenderedUserId;
    if (!(target instanceof Element) || !userId || buildDirectoryEntries(userId).length === 0) return;
    if (target.closest(".jadges-directory-content")) return;
    const control = target.closest("a, button");
    const isJadgesBadge = Boolean(target.closest(".jadges-profile-badge-image"));
    const isNativeBadge = Boolean(control?.querySelector('img[class*="badge"]'));
    if (!isJadgesBadge && !isNativeBadge) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openBadgeDirectory(userId);
}

function startProfileObserver(): void {
    profileObserver?.disconnect();
    profileObserver = new MutationObserver(() => syncProfileDom());
    profileObserver.observe(document.body, { childList: true, subtree: true });
    syncProfileDom();
}

function restoreProfileDom(): void {
    document.querySelectorAll<HTMLAnchorElement>('a[data-jadges-hidden-kind]').forEach(anchor => {
        const original = anchor.dataset.jadgesOriginalDisplay;
        anchor.style.display = original === "__empty__" ? "" : original || "";
        delete anchor.dataset.jadgesHiddenKind;
        delete anchor.dataset.jadgesOriginalDisplay;
    });

    for (const [parent, controls] of originalGroupOrder) {
        if (!parent.isConnected) continue;
        for (const control of controls) {
            if (control.isConnected) parent.append(control);
        }
    }
    originalGroupOrder.clear();
}

async function refreshBadges(): Promise<void> {
    const apiUrl = normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl);
    try {
        const [badgeResponse, settingsResponse] = await Promise.all([
            fetch(apiUrl, { cache: "no-store", credentials: "omit" }),
            fetch(`${apiRoot()}/settings.json`, { cache: "no-store", credentials: "omit" })
        ]);

        if (!badgeResponse.ok) {
            throw new Error(`Jadges API returned HTTP ${badgeResponse.status}`);
        }

        const data: unknown = await badgeResponse.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new TypeError("Jadges API returned an invalid response");
        }
        badgeData = data as JadgesResponse;

        if (settingsResponse.ok) {
            const settings: unknown = await settingsResponse.json();
            if (settings && typeof settings === "object" && !Array.isArray(settings)) {
                settingsData = settings as BadgeSettingsResponse;
            }
        }

        syncProfileDom();
    } catch (error) {
        console.error("[JadgesBadges] Failed to refresh badges:", error);
    }
}

function makeImageBadge(
    id: string,
    orderKey: string,
    description: string,
    image: string,
    userId: string,
    position: BadgePosition
): NativeDiscordBadge {
    return {
        id,
        key: id,
        description,
        image,
        rawImage: true,
        iconSrc: image,
        position,
        onClick: () => openBadgeDirectory(userId),
        props: {
            alt: " ",
            "aria-hidden": true,
            className: "jadges-profile-badge-image",
            "data-jadges-key": orderKey,
            style: { width: "20px", height: "20px", objectFit: "contain" }
        } as any
    };
}

function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    lastRenderedUserId = userId;
    queueMicrotask(syncProfileDom);

    const badges = badgeData[userId];
    if (!Array.isArray(badges)) return [];

    const settings = getSettings(userId);
    const position = settings.side === "right" ? BadgePosition.END : BadgePosition.START;
    const output: NativeDiscordBadge[] = [];

    badges.forEach((badge, index) => {
        if (badge.metadata) return;

        if (badge.nitro) {
            if (removesNativeBadges(badge.nitro)) return;
            const image = badge.nitro.profileIcon;
            if (!image?.startsWith("https://")) return;
            output.push(makeImageBadge(
                `jadges_nitro_${userId}_${index}`,
                badge.key || "nitro",
                `Subscriber since ${formatDate(badge.nitro.subscriberSince, true)}`,
                image,
                userId,
                position
            ));
            return;
        }

        if (typeof badge.badge !== "string" || !badge.badge.startsWith("https://")) return;
        output.push(makeImageBadge(
            `jadges_${userId}_${index}`,
            badge.key || `custom:${index}`,
            badge.tooltip || badge.name || "Jadges Badge",
            badge.badge,
            userId,
            position
        ));
    });

    return output;
}

const profileBadge: ProfileBadge = {
    getBadges,
    position: BadgePosition.START
};

export default definePlugin({
    name: "JadgesBadges",
    description: "Displays and rearranges Jadges and native Discord profile badges for Jadges users.",
    authors: [{ name: "Jaycord", id: 0n }],
    dependencies: ["BadgeAPI"],
    options: {
        apiUrl: {
            type: OptionType.STRING,
            description: "Full Jadges badges.json API URL",
            default: DEFAULT_API_URL,
            restartNeeded: true
        }
    },
    async start() {
        addProfileBadge(profileBadge);
        startProfileObserver();
        document.addEventListener("click", handleProfileBadgeClick, true);
        await refreshBadges();
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => void refreshBadges(), REFRESH_INTERVAL);
    },
    stop() {
        removeProfileBadge(profileBadge);
        clearInterval(refreshTimer);
        refreshTimer = undefined;
        profileObserver?.disconnect();
        profileObserver = undefined;
        document.removeEventListener("click", handleProfileBadgeClick, true);
        restoreProfileDom();
        badgeData = {};
        settingsData = {};
        lastRenderedUserId = undefined;
        reportedNative.clear();
    }
});
