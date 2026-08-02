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
- User-bound authorization tokens for client profile reports
- Vencord, Revenge, and Kettu support

## Commands

```text
/badge create name:<name> image:<image>
/badge remove badge:<your badge>
/badge delete user:<user> badge:<badge> reason:<reason>
/badge rearrange
/badge list [user]
/badge nitro set preset:<tier>
/badge nitro remove
/badge block user:<user>
/badge unblock user:<user>
```

`/badge delete` is staff-only. Its badge field uses autocomplete after a user is selected. The deleted user receives a DM containing the reason.

`/badge rearrange` returns an ephemeral, expiring link. The page requires Discord OAuth and only accepts the same Discord account that ran the command. The Jaycord Staff badge remains pinned first.

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
```

Enable **Server Members Intent** in the Discord Developer Portal so the automatic Jaycord Staff role badge can sync.

## Plugin authorization

The native-badge inventory and visible-profile report APIs require a user-bound bearer token.

1. Sign in to the Jadges website dashboard.
2. Under **Plugin authorization token**, select **Generate token**.
3. Copy the token and paste it into the Jadges plugin settings in Vencord, Revenge, or Kettu.

Only the token hash is stored on the server. Tokens expire after 90 days, are restricted to the Discord account that generated them, and can be rotated or revoked from the dashboard. Generating a replacement invalidates the previous token immediately.

## Vencord

Copy this folder into `Vencord/src/userplugins/` and rebuild Vencord:

```text
vencord-plugin/jadgesBadges/
```

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

The Kettu build uses Kettu's Vendetta compatibility APIs for profile badge rendering and ordering, hidden-badge synchronization, account-theme synchronization, and protected client reporting.

## Privacy and security

OAuth access is limited to the `identify` scope. Rearrangement links expire, are bound to the Discord user who ran the command, and require a signed session cookie before badge data can be changed. If a different Discord account attempts to open or authorize a rearrangement link, Jadges terminates that exact link and sends the original owner a security-alert DM.

Client report tokens are never embedded in public JavaScript or plugin files. The server accepts profile reports only when the bearer token is active and belongs to the same Discord user ID contained in the request.
