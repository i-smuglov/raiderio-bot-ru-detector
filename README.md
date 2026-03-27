# Raider.IO RU Detector Bot

A Discord bot that monitors [Raider.IO](https://raider.io) group messages and alerts officers when guild members are spotted in groups with Cyrillic-named players.

## How It Works

1. The bot listens for messages from the **Raider.IO** bot in your configured channel
2. When a message contains Cyrillic characters, it resolves each player's WoW guild via the Raider.IO API
3. If any player from your tracked WoW guild is found in that group, a private thread is created and officers are pinged

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
| `BOT_DEBUG_USER_ID` | *(Optional)* Your Discord user ID — pings you on every Raider.IO message for testing |

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

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | HTTP health check port (default: `8080`) |
| `BOT_DEBUG_USER_ID` | No | Discord user ID to always ping on every Raider.IO message |
| `DISCORD_GUILD_ID` | No | If set, registers slash commands to this guild only (faster for testing) |
