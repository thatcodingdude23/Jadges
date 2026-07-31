import type { NitroPreset, PublicNitroPreset } from "./types.js";

interface NitroPresetDefinition {
  key: NitroPreset;
  label: string;
  months: number;
  profileIcon: string;
  hoverImage: string;
  hideNativeBadges?: boolean;
}

export const NITRO_PRESETS: Record<NitroPreset, NitroPresetDefinition> = {
  bronze: {
    key: "bronze",
    label: "Bronze",
    months: 1,
    profileIcon: "https://cdn.discordapp.com/assets/content/c5dc1f8986bff763de576a33d2c465f32a3a475a5ce6dbc4a72312f453088188.svg",
    hoverImage: "https://static.wikia.nocookie.net/discord/images/4/4b/Nitro_Badge_Bronze.png/revision/latest?cb=20250125142910",
  },
  silver: {
    key: "silver",
    label: "Silver",
    months: 3,
    profileIcon: "https://cdn.discordapp.com/assets/content/f51ac5f51631c7c2ed16d0b1a6755f2846dafe6cf9fe251ac0a6a090f80cd06a.svg",
    hoverImage: "https://static.wikia.nocookie.net/discord/images/7/7d/Nitro_Badge_Silver.png/revision/latest?cb=20250125142948",
  },
  gold: {
    key: "gold",
    label: "Gold",
    months: 6,
    profileIcon: "https://cdn.discordapp.com/assets/content/3b2f45966655f984d8281007eb28616801fb16bbe5dd3bf22dc1f34a9c946610.svg",
    hoverImage: "https://cdn.discordapp.com/assets/content/1518ef16d0790bcc0d2a409db2e71a25d7b8726703150612a9b06b45219f4066.png",
  },
  platinum: {
    key: "platinum",
    label: "Platinum",
    months: 12,
    profileIcon: "https://cdn.discordapp.com/assets/content/b87a705edd16d3cc22d0e3fee412e2fe9d75a7b5afccd88ca72fca8b41d924b5.svg",
    hoverImage: "https://discord.fandom.com/wiki/Special:Redirect/file/Nitro_Badge_Platinum.png",
  },
  diamond: {
    key: "diamond",
    label: "Diamond",
    months: 24,
    profileIcon: "https://cdn.discordapp.com/assets/content/460eee7bd8bf7539132d7b57377239c2189edaada600673d8a05f90eb661816a.svg",
    hoverImage: "https://discord.fandom.com/wiki/Special:Redirect/file/Nitro_Badge_Diamond.png",
  },
  emerald: {
    key: "emerald",
    label: "Emerald",
    months: 36,
    profileIcon: "https://cdn.discordapp.com/assets/content/4eb3961177fe90543e08d82ccfa21fa90aefbbd38651221568b9ed653d6fedb7.svg",
    hoverImage: "https://discord.fandom.com/wiki/Special:Redirect/file/Nitro_Badge_Emerald.png",
  },
  ruby: {
    key: "ruby",
    label: "Ruby",
    months: 60,
    profileIcon: "https://cdn.discordapp.com/assets/content/96a2e93cb1b3dd4eb4699b9d178926228707b192e5a9dafcb61ceef0ddeb183d.svg",
    hoverImage: "https://discord.fandom.com/wiki/Special:Redirect/file/Nitro_Badge_Ruby.png",
  },
  opal: {
    key: "opal",
    label: "Opal",
    months: 72,
    profileIcon: "https://cdn.discordapp.com/assets/content/0cb2f03c88887c7a8a31a348281ba835f6fbec76307f574c96f8ece87c8f7544.svg",
    hoverImage: "https://discord.fandom.com/wiki/Special:Redirect/file/Nitro_Badge_Opal.png",
  },
  remove: {
    key: "remove",
    label: "Remove",
    months: 0,
    profileIcon: "https://cdn.discordapp.com/badge-icons/51040c70d4f20a921ad6674ff86fc95c.png",
    hoverImage: "https://cdn.discordapp.com/badge-icons/51040c70d4f20a921ad6674ff86fc95c.png",
    hideNativeBadges: true,
  },
};

export const NITRO_PRESET_CHOICES = Object.values(NITRO_PRESETS).map((preset) => ({
  name: preset.key === "remove" ? "Remove Nitro Badge" : `${preset.label} Nitro`,
  value: preset.key,
}));

export function isNitroPreset(value: string | null | undefined): value is NitroPreset {
  return Boolean(value && Object.hasOwn(NITRO_PRESETS, value));
}

function subtractUtcMonths(value: Date, months: number): Date {
  const date = new Date(value);
  const originalDay = date.getUTCDate();

  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);

  const finalDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(originalDay, finalDay));

  return date;
}

export function publicNitroPreset(
  key: NitroPreset,
  approvedAt: string,
): PublicNitroPreset {
  const preset = NITRO_PRESETS[key];
  const reference = new Date(approvedAt);
  const safeReference = Number.isNaN(reference.getTime()) ? new Date() : reference;

  return {
    key: preset.key,
    label: preset.label,
    months: preset.months,
    profileIcon: preset.profileIcon,
    hoverImage: preset.hoverImage,
    subscriberSince: subtractUtcMonths(safeReference, preset.months).toISOString(),
    hideNativeBadges: preset.hideNativeBadges,
  };
}
