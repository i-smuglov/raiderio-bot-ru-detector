# Raider.IO RU Detector Bot

A Discord bot that monitors [Raider.IO](https://raider.io) group messages and alerts officers when guild members are spotted in groups with Cyrillic-named players.

## How It Works

1. The bot listens for messages from the **Raider.IO** bot in your configured channel
2. When a message contains Cyrillic characters, it resolves each player's WoW guild via the Raider.IO API
3. If any player from your tracked WoW guild is found in that group, a private alert thread is created and officers are pinged
4. On every startup the bot automatically scans for any Raider.IO posts it missed while offline and processes them

---

## Setup

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Name it (e.g. `raiderio-bot-ru-detector`)
3. Go to **Bot** tab:
   - Click **Add Bot**
   - Under **Privileged Gateway Intents**, enable:
     - **Server Members Intent**
     - **Message Content Intent**
   - Copy the **Bot Token** — you'll need it later

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

Run the schema to create the required tables (safe to re-run on updates):

```bash
psql "postgresql://USER:PASSWORD@HOST:PORT/DBNAME" -f db/schema.sql
```

> **Railway note:** use the **Public Network** connection URL from the Postgres service → Connect tab, not the internal `.railway.internal` hostname.

### 5. Deploy the Bot

#### Option A: Railway (recommended)

1. Create a new project on [railway.app](https://railway.app)
2. Add a **PostgreSQL** service
3. Deploy this repo as a new service
4. Set the following environment variables on the bot service:

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from step 1 |
| `DATABASE_URL` | PostgreSQL connection string (use Railway's internal reference) |
| `BOT_DEBUG_USER_ID` | *(Optional)* Discord user ID to ping alongside the officer role when an alert fires (normal checks still apply) |
| `BOT_DEBUG_GUILD_IDS` | *(Optional)* Comma-separated Discord guild IDs where the debug user should be pinged |

#### Option B: Self-hosted

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN and DATABASE_URL
npm start
```

Requires Node.js >= 20.

---

## Configuration (Slash Commands)

All commands require the **Manage Server** permission.

### `/setup`

Configure the bot for your server.

| Option | Description |
|---|---|
| `guild_name` | Your WoW guild name exactly as it appears on Raider.IO |
| `officer_role_id` | Discord role ID to ping when an alert fires |

To get a role ID: enable Developer Mode in Discord settings → right-click the role → **Copy Role ID**.

### `/info`

Shows current configuration (tracked WoW guild and officer role ID).

---

## Gap Detection & Sleep Mode

The bot tracks the last Raider.IO message it successfully evaluated. On every startup it automatically fetches and processes any messages that arrived while it was offline (e.g. during Railway sleep). No manual intervention is needed.

Alert threads are named `alert-{messageId}` internally, which lets the bot identify already-processed posts using Discord as the source of truth — even if the database was not reachable when the post was first handled.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | HTTP health check port (default: `8080`) |
| `BOT_DEBUG_USER_ID` | No | Discord user ID to ping alongside the officer role when an alert fires (normal checks still apply) |
| `BOT_DEBUG_GUILD_IDS` | No | Comma-separated Discord guild IDs where the debug user should be pinged |
| `DISCORD_GUILD_ID` | No | If set, registers slash commands to this guild only (faster for testing) |
| `LOG_LEVEL` | No | Set to `debug` for verbose per-message logging |
