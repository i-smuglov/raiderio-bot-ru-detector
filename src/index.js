import http from 'node:http';
import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionType,
  MessageFlags,
} from 'discord.js';
import { createPool } from './dbPool.js';
import { GuildStore } from './guildStore.js';
import { registerSlashCommands } from './registerCommands.js';
import { handleRaiderIoMessage } from './raiderHandler.js';

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
    GatewayIntentBits.GuildMembers,
  ],
});

/**
 * @param {import('discord.js').Interaction} interaction
 */
async function handleInteraction(interaction) {
  if (!store) return;
  if (interaction.type !== InteractionType.ApplicationCommand || !interaction.inGuild()) return;
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, options } = interaction;
  if (!guildId) return;

  try {
    if (commandName === 'setup') {
      const guildName = options.getString('guild_name');
      const officerRoleId = options.getString('officer_role_id');
      /** @type {{ wow_guild_name?: string | null; officer_role_id?: string | null }} */
      const patch = {};
      if (guildName !== null) patch.wow_guild_name = guildName;
      if (officerRoleId !== null) patch.officer_role_id = officerRoleId;
      const s = await store.upsertSettings(guildId, patch);
      await interaction.reply({
        content: `Guild Name: ${s.wow_guild_name ?? '—'}\nOfficer Role ID: ${s.officer_role_id ?? '—'}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'info') {
      const s = await store.getSettings(guildId);
      const g = await store.listWhitelistedGuildNames(guildId);
      const p = await store.listWhitelistedPlayers(guildId);
      await interaction.reply({
        content: [
          `**WoW guild (tracked):** ${s?.wow_guild_name ?? '—'}`,
          `**Officer role ID:** ${s?.officer_role_id ?? '—'}`,
          `**Whitelisted WoW guilds:** ${g.length ? g.join(', ') : '—'}`,
          `**Whitelisted players:** ${p.length ? p.join(', ') : '—'}`,
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

function startBot() {
  token = process.env.DISCORD_TOKEN ?? '';
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN');
  }

  pool = createPool();
  store = new GuildStore(pool);

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    await registerSlashCommands(token, c.user.id);
    console.log('Slash commands registered');
  });

  client.on(Events.InteractionCreate, (i) => {
    void handleInteraction(i);
  });

  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (!message.guild || !store) return;
    const alwaysPingUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
    if (message.author.bot && message.author.username === 'Raider.IO') {
      await handleRaiderIoMessage(message, store, { alwaysPingUserId });
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
  try {
    startBot();
  } catch (e) {
    console.error('[boot] startup failed (health server is already listening):', e);
    process.exit(1);
  }
});
