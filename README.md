# Jadges

Jadges is a Discord custom-badge bot and public badge API inspired by GiBBy and Equibadges. It is designed for one Render web service with a persistent disk.

## What it does

- `/badge create` accepts an uploaded image and immediately saves it to the Render disk.
- Staff approve or deny submissions with Discord buttons.
- `/badge delete` and `/badge list` manage badges.
- `/badge block` and `/badge unblock` are verifier-only commands.
- `GET /badges.json` returns all approved badges.
- `GET /users/:discordId` returns one user's approved badges.
- `GET /badges/:filename` serves saved images.
- Badge metadata is stored in `/var/data/badges.json`; images are stored in `/var/data/badges/`.

MongoDB is not required. The persistent disk stores both the image files and the small JSON database.

## Discord setup

Create a Discord application and bot, then invite it with the `bot` and `applications.commands` scopes. The bot needs permission to view and send messages in the approval channel.

Keep the bot token, application ID, server ID, approval-channel ID, verifier-role ID, and blacklist configuration in private environment variables. Never commit their values to this repository.

## Render deployment

1. In Render, create a Blueprint from this repository using `render.yaml`.
2. Use a paid web-service plan because persistent disks are not attached to free instances.
3. Enter the private environment variables requested by Render.
4. Set `PUBLIC_URL` to the final service URL, for example `https://jadges.onrender.com`.
5. Keep the disk mounted at `/var/data`.

Required private variables:

```text
DISCORD_TOKEN
CLIENT_ID
GUILD_ID
PROMPT_CHANNEL
VERIFIER_ROLE
PUBLIC_URL
BLACKLISTED_WORDS
```

## API format

`GET /badges.json`

```json
{
  "123456789012345678": [
    {
      "name": "Developer",
      "tooltip": "Developer",
      "badge": "https://your-service.onrender.com/badges/file.png",
      "pending": false
    }
  ]
}
```

The response includes both `name` and `tooltip`, making it easy to consume as a BadgeVault-style or Vencord/Equicord-style source.

## Local development

Create a local `.env` file containing the required private variables. The `.gitignore` prevents `.env` files, local data, keys, logs, and generated output from being committed.

```bash
npm install
npm run dev
```

## Important limitation

This JSON-on-disk design is intended for one Render instance. Do not scale the service to multiple instances, because each instance cannot safely share the same mounted disk. For a large service or multiple instances, move the metadata to PostgreSQL or MongoDB and the images to object storage.
