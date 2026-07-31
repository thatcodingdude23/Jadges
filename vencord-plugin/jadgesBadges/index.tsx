/*
 * Jadges profile badges for Vencord
 * Adds approved custom badges, Nitro presets, badge ordering/placement,
 * native badge removal, and a badge directory popup.
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

interface JadgesBadge {
    key?: string;
    name?: string;
    tooltip?: string;
    badge: string;
    createdAt?: string;
    side?: BadgeSide;
    nitro?: NitroPreset;
}

type JadgesResponse = Record<string, JadgesBadge[]>;

type NativeDiscordBadge = ProfileBadge & {
    id: string;
    iconSrc: string;
};

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

interface DirectoryEntry {
    id: string;
    title: string;
    icon: string;
    detailImage: string;
    subtitle: string;
    description: string;
    nitro?: NitroPreset;
}

const DEFAULT_API_URL = "https://jadges.onrender.com/badges.json";
const REFRESH_INTERVAL = 5_000;

let badgeData: JadgesResponse = {};
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let profileObserver: MutationObserver | undefined;
let lastRenderedUserId: string | undefined;

function normalizeApiUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    return url || DEFAULT_API_URL;
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

function getUserNitro(userId: string): NitroPreset | undefined {
    const badges = badgeData[userId];
    if (!Array.isArray(badges)) return undefined;
    return badges.find(badge => badge?.nitro)?.nitro;
}

function getBadgeSide(userId: string): BadgeSide {
    const badges = badgeData[userId];
    return badges?.find(badge => badge?.side === "right") ? "right" : "left";
}

function removesNativeBadges(nitro: NitroPreset | undefined): boolean {
    return nitro?.hideNativeBadges === true || nitro?.key === "remove";
}

function buildDirectoryEntries(userId: string): DirectoryEntry[] {
    const badges = badgeData[userId];
    if (!Array.isArray(badges)) return [];

    const entries: DirectoryEntry[] = [];
    badges.forEach((badge, index) => {
        if (badge.nitro) {
            if (removesNativeBadges(badge.nitro)) return;
            entries.push({
                id: `jadges_nitro_${userId}_${index}`,
                title: `Nitro ${badge.nitro.label}`,
                icon: badge.nitro.profileIcon,
                detailImage: badge.nitro.hoverImage || badge.nitro.profileIcon,
                subtitle: `Unlocked on ${formatDate(badge.nitro.subscriberSince, true)}`,
                description: "Stay subscribed to Nitro to level up this badge.",
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
            description: `A profile badge approved through Jadges. Other people using the plugin can also see “${title}”.`
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
                        Browse the badges equipped through Jadges.
                    </div>
                </div>
                <button className="jadges-directory-close" aria-label="Close" onClick={modalProps.onClose}>×</button>
            </ModalHeader>

            <ModalContent className="jadges-directory-content">
                {entries.length === 0 || !selected ? (
                    <div className="jadges-directory-empty">No visible Jadges badges were found for this user.</div>
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
                                    <strong>{selected.nitro ? "Rare" : "Custom"}</strong>
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
    profileObserver = new MutationObserver(() => updateNativeNitroVisibility());
    profileObserver.observe(document.body, { childList: true, subtree: true });
    updateNativeNitroVisibility();
}

function restoreNativeNitroBadges(): void {
    document.querySelectorAll<HTMLAnchorElement>('a[data-jadges-hidden-kind]').forEach(anchor => {
        const original = anchor.dataset.jadgesOriginalDisplay;
        anchor.style.display = original === "__empty__" ? "" : original || "";
        delete anchor.dataset.jadgesHiddenKind;
        delete anchor.dataset.jadgesOriginalDisplay;
    });
}

async function refreshBadges(): Promise<void> {
    const apiUrl = normalizeApiUrl(Settings.plugins.JadgesBadges?.apiUrl);
    try {
        const response = await fetch(apiUrl, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`Jadges API returned HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new TypeError("Jadges API returned an invalid response");
        }
        badgeData = data as JadgesResponse;
        updateNativeNitroVisibility();
    } catch (error) {
        console.error("[JadgesBadges] Failed to refresh badges:", error);
    }
}

function makeImageBadge(
    id: string,
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
            style: { width: "20px", height: "20px", objectFit: "contain" }
        }
    };
}

function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    lastRenderedUserId = userId;
    queueMicrotask(updateNativeNitroVisibility);

    const badges = badgeData[userId];
    if (!Array.isArray(badges)) return [];

    const position = getBadgeSide(userId) === "right" ? BadgePosition.END : BadgePosition.START;
    const output: NativeDiscordBadge[] = [];

    badges.forEach((badge, index) => {
        if (badge.nitro) {
            if (removesNativeBadges(badge.nitro)) return;
            const image = badge.nitro.profileIcon;
            if (!image?.startsWith("https://")) return;
            output.push(makeImageBadge(
                `jadges_nitro_${userId}_${index}`,
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
    description: "Displays approved Jadges badges, custom ordering, Nitro presets, and native badge removal.",
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
        restoreNativeNitroBadges();
        badgeData = {};
        lastRenderedUserId = undefined;
    }
});
