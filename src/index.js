import http from 'node:http';
import {
  Client,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  GatewayIntentBits,
  InteractionType,
  MessageFlags,
} from 'discord.js';
import { createPool } from './dbPool.js';
import { GuildStore } from './guildStore.js';
import { registerSlashCommands } from './registerCommands.js';
import { handleRaiderIoMessage } from './raiderHandler.js';
import { catchupExecute, catchupPreview } from './catchup.js';

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const logDebug = (...args) => {
  if (LOG_LEVEL === 'debug') console.log(...args);
};

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
/** @type {(() => void) | undefined} */
let stopKeepalive;

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

  // Button interactions (used by /catchup confirm).
  if (interaction.isButton()) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const [kind, daysStr, userId] = String(interaction.customId || '').split(':');
    if (kind !== 'catchup_confirm') return;
    if (userId && interaction.user.id !== userId) {
      await interaction.reply({
        content: 'This confirmation button belongs to someone else. Run `/catchup` yourself.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const days = Math.max(1, Math.min(365, Number(daysStr || 0) || 7));
    const ch = interaction.channel;
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) {
      await interaction.reply({
        content: 'Run `/catchup` in the Raider.IO feed channel (text/announcement channel).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const alwaysPingUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
    const res = await catchupExecute(ch, store, { days, alwaysPingUserId });

    await interaction.editReply({
      content: [
        `Channel: <#${ch.id}>`,
        `Days: ${days}`,
        `Cutoff: ${res.cutoff.toISOString()}`,
        `Scanned: ${res.scanned} (in range: ${res.inRange})`,
        `Already threaded (skipped): ${res.alreadyThreaded}`,
        `Attempted handler calls: ${res.attempted}`,
        `Stop: ${res.stopReason}`,
      ].join('\n').slice(0, 2000),
    });
    return;
  }

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

    if (commandName === 'catchup') {
      const ch = interaction.channel;
      if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) {
        await interaction.reply({
          content: 'Run `/catchup` in the Raider.IO feed channel (text/announcement channel).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const days = Math.max(1, Math.min(365, options.getInteger('days') ?? 7));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const alwaysPingUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
      const preview = await catchupPreview(ch, store, { days, alwaysPingUserId });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`catchup_confirm:${days}:${interaction.user.id}`)
          .setLabel('Confirm')
          .setStyle(ButtonStyle.Danger),
      );

      await interaction.editReply({
        content: [
          `Channel: <#${ch.id}>`,
          `Days: ${days}`,
          `Cutoff: ${preview.cutoff.toISOString()}`,
          `Scanned: ${preview.scanned} (in range: ${preview.inRange})`,
          `Already threaded (will be skipped): ${preview.alreadyThreaded}`,
          `Candidates (unthreaded Raider.IO posts): ${preview.candidates}`,
          `Stop: ${preview.stopReason}`,
          '',
          'Press **Confirm** to create missing alert threads by running the normal detection procedure.',
        ].join('\n').slice(0, 2000),
        components: [row],
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
  // If an idle client errors (e.g. Postgres restart), pg emits an 'error' event on the pool.
  // Without a listener Node treats it as unhandled and crashes the process.
  pool.on('error', (err) => {
    console.warn(`[db] pool error: ${errorOneLine(err)}`);
  });
  store = new GuildStore(pool);
  stopKeepalive = startDbKeepalive(pool);

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    console.log(`[boot] in ${c.guilds.cache.size} guild(s):`, [...c.guilds.cache.values()].map((g) => `${g.name}(${g.id})`).join(', '));
    await registerSlashCommands(token, c.user.id);
    console.log('Slash commands registered');
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
      const alwaysPingUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
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
 * Run a cheap query periodically to keep the service + DB warm.
 * Returns a stop function so shutdown() can cancel it.
 *
 * Env:
 * - DB_KEEPALIVE_MS: interval in ms (default 300000 / 5 min). Set 0 to disable.
 * - DB_KEEPALIVE_RETRY_MS: interval in ms while DB is down (default 10000 / 10s).
 *
 * @param {import('pg').Pool} p
 */
function startDbKeepalive(p) {
  const msRaw = (process.env.DB_KEEPALIVE_MS ?? '300000').trim();
  const ms = Number(msRaw);
  if (!Number.isFinite(ms) || ms < 0) {
    console.warn(`[keepalive] invalid DB_KEEPALIVE_MS="${msRaw}", disabling keepalive`);
    return undefined;
  }
  if (ms === 0) return undefined;

  const retryMsRaw = (process.env.DB_KEEPALIVE_RETRY_MS ?? '10000').trim();
  const retryMs = Number(retryMsRaw);
  if (!Number.isFinite(retryMs) || retryMs <= 0) {
    console.warn(
      `[keepalive] invalid DB_KEEPALIVE_RETRY_MS="${retryMsRaw}", disabling keepalive`,
    );
    return undefined;
  }

  console.log(
    `[keepalive] DB ping every ${Math.round(ms / 1000)}s (retry ${Math.round(retryMs / 1000)}s until ok)`,
  );

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let stopped = false;
  let failures = 0;
  /** @type {'normal' | 'retry'} */
  let mode = 'normal';

  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
  };

  const tick = async () => {
    if (stopped) return;

    try {
      await p.query('SELECT 1');
      failures = 0;
      console.log(`[keepalive] db ok (${mode})`);
      mode = 'normal';
      schedule(ms);
      return;
    } catch (e) {
      failures += 1;
      const msg = errorOneLine(e);
      console.warn(`[keepalive] db ping failed (x${failures}, ${mode}): ${msg}`);
      mode = 'retry';
      schedule(retryMs);
    }
  };

  // First attempt immediately.
  schedule(0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * @param {string} signal
 */
async function shutdown(signal) {
  console.log(`${signal} received, closing DB pool`);
  if (stopKeepalive) stopKeepalive();
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
