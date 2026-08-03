# Jadges

Jadges is a custom Discord badge system that lets users submit profile badges, choose Nitro appearances, rearrange their Jadges badges, and display approved badges directly on Discord profiles.

**Official Discord server:** https://discord.gg/jaycord

## Supported clients

- **Vencord** — desktop
- **Revenge** — Android
- **Kettu** — Android and iOS

Only users with the Jadges plugin installed can see Jadges customizations.

## Features

- Custom badge images and names
- Bronze, Silver, Gold, Platinum, Diamond, Emerald, Ruby, and Opal Nitro presets
- Native Nitro and server-boosting badge removal mode
- Automatic Jaycord Staff badge
- Private Discord-authorized badge rearrangement page
- Drag-to-swap badge ordering
- Optional left-side or right-side badge placement
- Administrative badge deletion with a reason DM
- Staff approval and denial buttons
- Badge limits, booster slots, and badge-name filtering
- Vencord, Revenge, and Kettu support
- Dedicated Discord support responder with optional Groq AI understanding, a comprehensive Jadges knowledge base, and conversation memory

## Commands

```text
/badge create name:<name> image:<image>
/badge remove badge:<your badge>
/badge delete user:<user> badge:<badge> reason:<reason>
/badge rearrange
/badge staff badge:<admin|default>
/badge list [user]
/badge nitro set preset:<tier>
/badge nitro remove
/badge block user:<user>
/badge unblock user:<user>
```

`/badge delete`, `/badge block`, and `/badge unblock` are staff-only. The delete command's badge field uses autocomplete after a user is selected. The deleted user receives a DM containing the reason when DMs are available.

`/badge rearrange` returns an ephemeral, expiring link. The page requires Discord OAuth and only accepts the same Discord account that ran the command. The Jaycord Staff or Admin badge remains pinned first.

`/badge staff` is available to eligible Jaycord staff. The Admin option requires the Jaycord Admin role; Default restores the normal Jaycord Staff badge.

## Discord OAuth setup

The rearrangement page needs Discord OAuth.

1. Open the Discord Developer Portal for the Jadges application.
2. Add this OAuth redirect URI:

```text
https://jadges.onrender.com/oauth/callback
```

Use the exact value of `PUBLIC_URL` if it differs from the URL above.

3. Add these Render environment variables:

```text
DISCORD_CLIENT_SECRET=<Discord application client secret>
WEB_SESSION_SECRET=<long random secret>
```

`WEB_SESSION_SECRET` is optional but strongly recommended. When omitted, Jadges falls back to the Discord client secret or bot token for signing private links and sessions.

## Render variables

Required variables:

```text
DISCORD_TOKEN
CLIENT_ID
GUILD_ID
PROMPT_CHANNEL
VERIFIER_ROLE
PUBLIC_URL
DISCORD_CLIENT_SECRET
```

Optional variables:

```text
WEB_SESSION_SECRET
JAYCORD_STAFF_BADGE_URL
BLACKLISTED_WORDS
MAX_BADGES
EXTRA_BOOST_BADGES
MAX_BADGE_SIZE
GROQ_API_KEY
GROQ_SUPPORT_MODEL
GROQ_BASE_URL
```

`GROQ_API_KEY` enables natural-language support replies and follow-up understanding through Groq's OpenAI-compatible Chat Completions API. `GROQ_SUPPORT_MODEL` defaults to `llama-3.3-70b-versatile`. `GROQ_BASE_URL` defaults to `https://api.groq.com/openai/v1`.

The Groq system prompt is generated from `src/supportKnowledge.ts`. It contains confirmed Jadges information about the server, supported clients, installation, commands, roles, review flow, limits, Nitro tiers, Presets, OAuth security, staff badges, the leaderboard, troubleshooting, official links, and subjects the AI must not guess about.

Enable **Server Members Intent** in the Discord Developer Portal so automatic Jaycord role badges can sync. Enable **Message Content Intent** so the support responder can read support-channel messages.

## Vencord

Jadges is a custom Vencord userplugin, not a plugin from Vencord's normal built-in plugin list.

Copy this folder into `Vencord/src/userplugins/` and rebuild Vencord:

```text
vencord-plugin/jadgesBadges/
```

Restart Discord, open **Vencord Settings → Plugins**, search for **JadgesBadges**, and enable it.

## Revenge

Add this plugin source URL in Revenge:

```text
https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/revenge-plugin/
```

## Kettu

Open **Kettu Settings → Plugins**, add a plugin from URL, and paste:

```text
https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/kettu-plugin/
```

The Kettu build uses Kettu's Vendetta compatibility APIs for profile badge rendering and ordering, hidden-badge synchronization, and account-theme synchronization.

## Privacy and security

OAuth access is limited to the `identify` scope. Rearrangement links expire, are bound to the Discord user who ran the command, and require a signed session cookie before badge data can be changed. If a different Discord account attempts to open or authorize a rearrangement link, Jadges terminates that exact link and sends the original owner a security-alert DM.

The Groq support fallback sends the support question and a short recent conversation history to the configured Groq API so it can answer naturally. Users should never share bot tokens, API keys, passwords, session cookies, OAuth codes, or other secrets in the support channel.