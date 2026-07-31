# Jadges

Jadges is a custom Discord badge system that lets users submit their own profile badges and display approved badges directly on Discord profiles.

**Visit the Official Discord Server:** https://discord.gg/jaycord

## Supported clients

Jadges works on both:

- **Vencord** — desktop
- **Revenge** — Android

Approved badges use the native Discord profile badge row, including the badge image and hover description.

## Features

- Custom badge images and names
- Native Discord profile badge display
- Optional Bronze, Silver, Gold, Platinum, Diamond, Emerald, Ruby, and Opal Nitro presets
- Preset-specific Nitro icons and calculated subscriber dates
- Discord-styled badge directory for Nitro presets and custom badges on Vencord
- Works across Vencord and Revenge
- Staff approval and denial buttons
- User badge limits
- Extra badge slots for server boosters
- Badge-name blacklist
- Commands to create, delete, list, block, and unblock
- Approved badges automatically sync between supported clients

## Commands

```text
/badge create
/badge delete
/badge list
/badge block
/badge unblock
```

The optional `preset` choice on `/badge create` applies after the badge is approved.

## Vencord

Install the `JadgesBadges` userplugin in your Vencord source and rebuild Vencord. The plugin loads approved badges from the Jadges API and displays them using Discord's native badge system.

The current Vencord source is available in:

```text
vencord-plugin/jadgesBadges/
```

## Revenge

Open Revenge's plugin settings, choose **Add Plugin**, and paste this source URL:

```text
https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/
```

Revenge automatically loads `manifest.json` and the plugin JavaScript from that folder.

## How it works

1. A user submits a badge with `/badge create` and may select an optional Nitro preset.
2. Staff approve or deny the submission.
3. Approved badges and preset metadata are added to the public Jadges badge list.
4. The Vencord and Revenge plugins display the result on that user's Discord profile.

## Privacy

Tokens, Discord IDs, private configuration, stored badge data, and local environment files are not included in this repository.
