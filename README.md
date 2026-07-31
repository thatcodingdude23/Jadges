# Jadges

Jadges is a custom Discord badge system that lets users submit their own profile badges and display approved badges directly on Discord profiles.

## Supported clients

Jadges works on both:

- **Vencord** — desktop
- **Revenge** — Android

Approved badges use the native Discord profile badge row, including the badge image and hover description.

## Features

- Custom badge images and names
- Native Discord profile badge display
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

## Vencord

Install the `JadgesBadges` userplugin in your Vencord source and rebuild Vencord. The plugin loads approved badges from the Jadges API and displays them using Discord's native badge system.

## Revenge

Open Revenge's plugin settings, choose **Add Plugin**, and paste this source URL:

```text
https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/
```

Revenge automatically loads `manifest.json` and the plugin JavaScript from that folder.

## How it works

1. A user submits a badge with `/badge create`.
2. Staff approve or deny the submission.
3. Approved badges are added to the public Jadges badge list.
4. The Vencord and Revenge plugins display the badge on that user's Discord profile.

## Privacy

Tokens, Discord IDs, private configuration, stored badge data, and local environment files are not included in this repository.
