import http from 'node:http';
import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  InteractionType,
  MessageFlags,
} from 'discord.js';
import { createPool, waitForDb } from './dbPool.js';
import { GuildStore } from './guildStore.js';
import { registerSlashCommands } from './registerCommands.js';
import { handleRaiderIoMessage } from './raiderHandler.js';
import { catchupFromCursor } from './catchup.js';

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const logDebug = (...args) => {
  if (LOG_LEVEL === 'debug') console.log(...args);
};

const debugUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
const debugGuildIds = new Set(
  (process.env.BOT_DEBUG_GUILD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);

/**
 * Bind HTTP first and only then run DB/Discord startup.
 * Railway probes `/` immediately; if createPool() throws before listen(), health never comes up.
 *
 * @param {() => void} onListening
 */
function startHealthServer(onListening) {
  const port = process.env.PORT ?? '8080';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.on('error', (err) => {
    console.error('[health] failed to bind:', err);
    process.exit(1);
  });
  server.listen(Number(port), '0.0.0.0', () => {
    console.log(`[health] listening on 0.0.0.0:${port}`);
    onListening();
  });
}

/** @type {import('pg').Pool | undefined} */
let pool;
/** @type {GuildStore | undefined} */
let store;
let token = '';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/**
 * @param {import('discord.js').Interaction} interaction
 */
async function handleInteraction(interaction) {
  if (!store) return;
  if (!interaction.inGuild()) return;

  if (interaction.type !== InteractionType.ApplicationCommand) return;
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, options } = interaction;
  if (!guildId) return;

  try {
    if (commandName === 'setup') {
      const guildName = options.getString('guild_name');
      const officerRoleId = options.getString('officer_role_id');
      const detectGuildCyrillic = options.getBoolean('detect_guild_cyrillic');
      /** @type {{ wow_guild_name?: string | null; officer_role_id?: string | null; detect_guild_cyrillic?: boolean | null }} */
      const patch = {};
      if (guildName !== null) patch.wow_guild_name = guildName;
      if (officerRoleId !== null) patch.officer_role_id = officerRoleId;
      if (detectGuildCyrillic !== null) patch.detect_guild_cyrillic = detectGuildCyrillic;
      const s = await store.upsertSettings(guildId, patch);
      await interaction.reply({
        content: [
          `Guild Name: ${s.wow_guild_name ?? '—'}`,
          `Officer Role ID: ${s.officer_role_id ?? '—'}`,
          `Detect guild Cyrillic: ${s.detect_guild_cyrillic ? 'true' : 'false'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'info') {
      const s = await store.getSettings(guildId);
      await interaction.reply({
        content: [
          `**WoW guild (tracked):** ${s?.wow_guild_name ?? '—'}`,
          `**Officer role ID:** ${s?.officer_role_id ?? '—'}`,
          `**Detect guild Cyrillic:** ${s?.detect_guild_cyrillic ? 'true' : 'false'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

  } catch (e) {
    console.error(e);
    const msg = formatInteractionError(e);
    const content = `Error: ${msg}`.slice(0, 2000);
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp({ content, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

const RAILWAY_DB_ECONN_HINT =
  'Railway fix: Bot service → Variables → delete manual DATABASE_URL → add Variable reference → Postgres → DATABASE_URL → Redeploy (host must be *.railway.internal, not localhost).';

/**
 * @param {unknown} e
 */
function formatInteractionError(e) {
  if (e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0) {
    const parts = e.errors.map((sub) => errorOneLine(sub));
    const uniq = [...new Set(parts.filter(Boolean))];
    let text = uniq.join('; ') || e.message || 'AggregateError';
    if (e.code === 'ECONNREFUSED') text += ` ${RAILWAY_DB_ECONN_HINT}`;
    return text;
  }

  if (e instanceof Error) {
    let text = errorOneLine(e);
    const err = /** @type {Error & { code?: string }} */ (e);
    if (err.code === 'ECONNREFUSED') text += ` ${RAILWAY_DB_ECONN_HINT}`;
    return text;
  }

  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'code' in e) {
    const o = /** @type {{ code?: string; message?: string }} */ (e);
    return [o.message, o.code && `[${o.code}]`].filter(Boolean).join(' ') || 'Unknown error';
  }
  try {
    return JSON.stringify(e);
  } catch {
    return e === undefined || e === null ? 'Unknown error — check Railway logs' : String(e);
  }
}

/**
 * Single line, no Railway essay (used inside AggregateError).
 * @param {unknown} e
 */
function errorOneLine(e) {
  if (!(e instanceof Error)) return formatInteractionError(e);
  const err = /** @type {Error & { code?: string; syscall?: string; detail?: string }} */ (e);
  const bits = [];
  if (err.message?.trim()) bits.push(err.message.trim());
  if (err.code) bits.push(`[${err.code}]`);
  if (err.syscall) bits.push(err.syscall);
  if (err.detail) bits.push(err.detail);
  return bits.length ? bits.join(' ') : err.name || 'Error';
}

/**
 * On boot, scan forward from the stored cursor to catch any Raider.IO messages
 * that arrived while the process was offline (Railway sleep / restart).
 * Only runs if we have a previous checked_message_id for the guild.
 *
 * @param {import('discord.js').Guild} guild
 */
async function runStartupCatchup(guild) {
  if (!store) return;
  try {
    const state = await store.getBotState(guild.id);
    if (!state?.checked_channel_id || !state?.checked_message_id) {
      logDebug(`[startup-catchup] guild=${guild.id}: no cursor stored, skipping`);
      return;
    }

    const channel = await guild.channels.fetch(state.checked_channel_id).catch(() => null);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      console.warn(`[startup-catchup] guild=${guild.id}: channel ${state.checked_channel_id} not found or wrong type`);
      return;
    }

    const alwaysPingUserId = debugUserId && debugGuildIds.has(guild.id) ? debugUserId : undefined;
    const result = await catchupFromCursor(
      /** @type {import('discord.js').TextChannel | import('discord.js').NewsChannel} */ (channel),
      store,
      { afterMessageId: state.checked_message_id, alwaysPingUserId },
    );

    if (result.attempted > 0) {
      console.log(`[startup-catchup] guild=${guild.id}: scanned=${result.scanned} attempted=${result.attempted} stop=${result.stopReason}`);
    } else {
      logDebug(`[startup-catchup] guild=${guild.id}: no missed messages (scanned=${result.scanned})`);
    }
  } catch (e) {
    console.error(`[startup-catchup] guild=${guild.id} failed:`, e);
  }
}

async function startBot() {
  token = process.env.DISCORD_TOKEN ?? '';
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN');
  }

  pool = createPool();
  // If an idle client errors (e.g. Postgres restart), pg emits an 'error' event on the pool.
  // Without a listener Node treats it as unhandled and crashes the process.
  pool.on('error', (err) => {
    console.warn(`[db] pool error: ${errorOneLine(err)}`);
  });

  // Wait for Postgres to finish starting up before accepting Discord events.
  // Railway can take a few seconds to initialize the DB after deployment.
  await waitForDb(pool);

  store = new GuildStore(pool);

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    console.log(`[boot] in ${c.guilds.cache.size} guild(s):`, [...c.guilds.cache.values()].map((g) => `${g.name}(${g.id})`).join(', '));
    await registerSlashCommands(token, c.user.id);
    console.log('Slash commands registered');

    // Auto-catchup: process any Raider.IO messages that arrived while the bot was
    // offline (Railway sleep). Runs fire-and-forget per guild so it doesn't block
    // the ready event or other guilds.
    for (const guild of c.guilds.cache.values()) {
      void runStartupCatchup(guild);
    }
  });

  client.on(Events.GuildCreate, (g) => {
    console.log(`[guild] joined: ${g.name} (${g.id})`);
  });

  client.on(Events.Warn, (msg) => console.warn('[discord warn]', msg));
  client.on(Events.Error, (err) => console.error('[discord error]', err));

  client.on(Events.InteractionCreate, (i) => {
    void handleInteraction(i);
  });

  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      logDebug(`[msg] from "${message.author.username}" bot=${message.author.bot} guild=${message.guildId ?? 'none'} ch=${message.channelId}`);
      if (!message.guild || !store) { logDebug('[msg] skip: no guild or store'); return; }
      const alwaysPingUserId = debugUserId && debugGuildIds.has(message.guild.id) ? debugUserId : undefined;
      if (message.author.bot && message.author.username === 'Raider.IO') {
        try {
          await handleRaiderIoMessage(message, store, { alwaysPingUserId });
        } catch (e) {
          console.error('[msg] handleRaiderIoMessage threw:', e);
        }
      }
    })();
  });

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  client.login(token);
}

/**
 * @param {string} signal
 */
async function shutdown(signal) {
  console.log(`${signal} received, closing DB pool`);
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}

startHealthServer(() => {
  startBot().catch((e) => {
    console.error('[boot] startup failed (health server is already listening):', e);
    process.exit(1);
  });
});
