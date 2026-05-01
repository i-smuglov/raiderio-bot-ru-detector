import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
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
    ),
  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show saved setup')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('catchup')
    .setDescription('Dry-run scan messages until the first threaded one')
    // Explicitly allow everyone to see/run `/catchup`.
    // (Discord interprets "default_member_permissions: null" as "no restriction".)
    .setDefaultMemberPermissions(null)
    .addIntegerOption((o) =>
      o
        .setName('max_messages')
        .setDescription('Maximum messages to scan (default: 2000)')
        .setRequired(false),
    ),
].map((c) => c.toJSON());

/**
 * @param {string} token
 * @param {string} applicationId
 */
export async function registerSlashCommands(token, applicationId) {
  const rest = new REST().setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commands,
    });
    const after = await rest.get(Routes.applicationGuildCommands(applicationId, guildId));
    console.log(
      '[commands] guild registered:',
      Array.isArray(after)
        ? after.map((c) => `${c.name} perms=${c.default_member_permissions ?? 'null'}`).join(', ')
        : after,
    );
  } else {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    const after = await rest.get(Routes.applicationCommands(applicationId));
    console.log(
      '[commands] global registered:',
      Array.isArray(after)
        ? after.map((c) => `${c.name} perms=${c.default_member_permissions ?? 'null'}`).join(', ')
        : after,
    );
  }
}
