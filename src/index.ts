import 'dotenv/config';
import http from 'node:http';
import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionType,
  type Interaction,
} from 'discord.js';
import { createPool } from './dbPool.js';
import { GuildStore } from './guildStore.js';
import { registerSlashCommands } from './registerCommands.js';
import { handleRaiderIoMessage } from './raiderHandler.js';

function startHealthServer(): void {
  const port = process.env.PORT ?? '8080';
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    })
    .listen(Number(port), '0.0.0.0', () => {
      console.log(`Health check on :${port}`);
    });
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error('Missing DISCORD_TOKEN');
}

const pool = createPool();
const store = new GuildStore(pool);

startHealthServer();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.type !== InteractionType.ApplicationCommand || !interaction.inGuild()) return;
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, options } = interaction;
  if (!guildId) return;

  try {
    if (commandName === 'setup') {
      const guildName = options.getString('guild_name');
      const officerRoleId = options.getString('officer_role_id');
      const patch: { wow_guild_name?: string | null; officer_role_id?: string | null } = {};
      if (guildName !== null) patch.wow_guild_name = guildName;
      if (officerRoleId !== null) patch.officer_role_id = officerRoleId;
      const s = await store.upsertSettings(guildId, patch);
      await interaction.reply({
        content: `Guild Name: ${s.wow_guild_name ?? '—'}\nOfficer Role ID: ${s.officer_role_id ?? '—'}`,
        ephemeral: true,
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
        ephemeral: true,
      });
      return;
    }

    if (commandName === 'add-guild-to-whitelist') {
      const guild = options.getString('guild', true);
      const list = await store.addWhitelistedGuild(guildId, guild);
      await interaction.reply({ content: list.join(', ') || '(empty)', ephemeral: true });
      return;
    }

    if (commandName === 'remove-guild-from-whitelist') {
      const guild = options.getString('guild', true);
      const list = await store.removeWhitelistedGuild(guildId, guild);
      await interaction.reply({ content: list.join(', ') || '(empty)', ephemeral: true });
      return;
    }

    if (commandName === 'add-player-to-whitelist') {
      const player = options.getString('player', true);
      const list = await store.addWhitelistedPlayer(guildId, player);
      await interaction.reply({ content: list.join(', ') || '(empty)', ephemeral: true });
      return;
    }

    if (commandName === 'remove-player-from-whitelist') {
      const player = options.getString('player', true);
      const list = await store.removeWhitelistedPlayer(guildId, player);
      await interaction.reply({ content: list.join(', ') || '(empty)', ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    const msg = (e as Error).message;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `Error: ${msg}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
    }
  }
}

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
    if (!message.guild) return;
    if (message.author.bot && message.author.username === 'Raider.IO') {
      await handleRaiderIoMessage(message, store);
    }
    const debug = process.env.BOT_DEBUG_USERNAME;
    if (debug && message.author.username === debug && message.content === 'Ping!') {
      await message.reply('Pong!');
    }
  })();
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, closing DB pool`);
  await pool.end().catch(() => {});
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

client.login(token);
