# Raider.IO RU Detector Bot

A Discord bot that monitors [Raider.IO](https://raider.io) group messages and alerts officers when guild members are spotted in groups with Cyrillic-named players.

## How It Works

1. A **scheduled HTTP job** (or external cron) calls `POST` or `GET` `/cron/poll` on this service. The job uses the Discord **REST API** to read new messages in your configured feed channel (no WebSocket / Gateway worker).
2. When a Raider.IO bot message matches the detection rules, the app creates an alert **thread** and pings your officer role (same behavior as before).
3. **Slash commands** (`/setup`, `/info`, `/catchup`) are served over Discord’s **Interactions** endpoint (`POST /interactions` on this service).

---

## Setup

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Name it (e.g. `raiderio-bot-ru-detector`)
3. Go to **Bot** tab:
   - Click **Add Bot**
   - Copy the **Bot Token** — you’ll need it later
4. Under **General Information**, copy the **Application ID** and **Public Key** (used for HTTP interactions).

### 2. Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator**
2. Under **Scopes**, select: `bot`, `applications.commands`
3. Under **Bot Permissions**, select:

   - View Channels
   - Send Messages
   - Create Private Threads
   - Send Messages in Threads
   - Embed Links
   - Read Message History

   For a manual invite URL, the same bitmask is **`343597468672`** (`permissions=` query parameter).

4. Copy the generated URL, open it in a browser, and authorize for your server

### 3. Grant Channel Access

The bot must be able to see the channel where Raider.IO posts:

1. Right-click the Raider.IO channel → **Edit Channel → Permissions**
2. Add the bot and ensure **View Channel** and **Read Message History** are allowed

### 4. Set Up a Database

The bot requires a **PostgreSQL** database. You can use [Railway](https://railway.app), Supabase, or any Postgres provider.

Run the schema once to create the required tables:

```bash
psql $DATABASE_URL -f db/schema.sql
```

### 5. Register Slash Commands (one-off)

After setting `DISCORD_TOKEN` in `.env`:

```bash
npm run register-commands
```

If `DISCORD_GUILD_ID` is set in `.env`, commands are registered for that guild only (faster iteration). Otherwise they are registered globally.

### 6. Point Discord at Your HTTPS URL

1. In the Developer Portal → **General Information** → **Interactions Endpoint URL**, set:

   `https://<your-public-host>/interactions`

2. Discord will POST signed payloads to that path. Your service must be reachable over **HTTPS** with a valid certificate (local tunnels such as [ngrok](https://ngrok.com) work for development).

### 7. Deploy the Service

The process is a normal Node HTTP server: `GET /` (health), `POST /interactions` (Discord), `POST` or `GET` `/cron/poll` (your scheduler).

#### Option A: Railway (or similar PaaS)

1. Create a project and add **PostgreSQL**
2. Deploy this repo as a web service
3. Set environment variables (see table below)
4. Add a **cron** or scheduled job that calls `/cron/poll` on your public URL with the `CRON_SECRET` you configured (e.g. `Authorization: Bearer <CRON_SECRET>`)

#### Option B: Self-hosted

```bash
npm install
cp .env.example .env   # fill in variables
npm run register-commands
npm start
```

Requires Node.js >= 20.

---

## Configuration (Slash Commands)

`/setup` and `/info` require the **Manage Server** permission.

### `/setup`

| Option | Description |
|---|---|
| `guild_name` | Your WoW guild name exactly as it appears on Raider.IO |
| `officer_role_id` | Discord role ID to ping when an alert fires |
| `detect_guild_cyrillic` | Whether to treat Cyrillic in **guild names** on the roster as a signal |
| `feed_channel` | Text or announcement channel the **cron job** should poll for new Raider.IO posts |

Without `feed_channel`, `/cron/poll` does nothing for that guild until the feed channel is set.

To get a role ID: enable Developer Mode in Discord settings → right-click the role → **Copy Role ID**.

### `/info`

Shows current configuration (tracked WoW guild, officer role, feed channel, and poll watermark state in the database).

### `/catchup`

Scans recent history in the **current** channel (where you run the command) and can create missing alert threads (same as before, implemented via REST).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_PUBLIC_KEY` | Yes | Application public key (Interactions signature verification) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `CRON_SECRET` | Recommended | Shared secret; `/cron/poll` requires `Authorization: Bearer …` or header `x-cron-secret` |
| `PORT` | No | HTTP port (default `8080`) |
| `DISCORD_GUILD_ID` | No | If set, `npm run register-commands` registers commands to this guild only |
| `PG_POOL_MAX` | No | Postgres pool size (default `3`; use `1` on tight serverless plans) |
| `BOT_DEBUG_USER_ID` | No | Discord user ID to always ping when detection logic would alert |

---

## Serverless notes

- There is **no long-lived Gateway connection**; the app wakes on HTTP requests only.
- After you respond to an interaction, some hosts may freeze the process; `/catchup` **defers** the reply then edits it—ensure your platform allows work to continue until the edit finishes (or raise the function timeout).
- `/cron/poll` should run every minute or few minutes depending on how fast you need alerts.
