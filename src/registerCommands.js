import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure tracked WoW guild and officer role')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('guild_name').setDescription('WoW guild name (Raider.io)').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('officer_role_id').setDescription('Discord role ID to ping').setRequired(false),
    )
    .addBooleanOption((o) =>
      o
        .setName('detect_guild_cyrillic')
        .setDescription('Detect Cyrillic in guild names (default: false)')
        .setRequired(false),
    )
    .addChannelOption((o) =>
      o
        .setName('feed_channel')
        .setDescription('Raider.IO feed channel scanned by /cron/poll (text or announcement)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show saved setup')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('catchup')
    .setDescription('Scan last N days and create missing alert threads')
    // Explicitly allow everyone to see/run `/catchup`.
    // (Discord interprets "default_member_permissions: null" as "no restriction".)
    .setDefaultMemberPermissions(null)
    .addIntegerOption((o) =>
      o
        .setName('days')
        .setDescription('How many days back to scan (default: 7)')
        .setRequired(false),
    ),
].map((c) => c.toJSON());

/**
 * @param {string} token
 * @param {string} [applicationId] if omitted, resolved via GET /oauth2/applications/@me
 */
export async function registerSlashCommands(token, applicationId) {
  const rest = new REST().setToken(token);
  const appId =
    applicationId ??
    /** @type {{ id: string }} */ (await rest.get(Routes.oauth2CurrentApplication())).id;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), {
      body: commands,
    });
    const after = await rest.get(Routes.applicationGuildCommands(appId, guildId));
    console.log(
      '[commands] guild registered:',
      Array.isArray(after)
        ? after.map((c) => `${c.name} perms=${c.default_member_permissions ?? 'null'}`).join(', ')
        : after,
    );
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    const after = await rest.get(Routes.applicationCommands(appId));
    console.log(
      '[commands] global registered:',
      Array.isArray(after)
        ? after.map((c) => `${c.name} perms=${c.default_member_permissions ?? 'null'}`).join(', ')
        : after,
    );
  }
}
