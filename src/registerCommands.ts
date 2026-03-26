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
    .addStringOption((o) =>
      o.setName('guild_name').setDescription('WoW guild name (Raider.io)').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('officer_role_id').setDescription('Discord role ID to ping').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show saved setup and whitelists'),
  new SlashCommandBuilder()
    .setName('add-guild-to-whitelist')
    .setDescription('Ignore players in this WoW guild when detecting Cyrillic names')
    .addStringOption((o) =>
      o.setName('guild').setDescription('WoW guild name').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('remove-guild-from-whitelist')
    .setDescription('Remove a WoW guild from the detection whitelist')
    .addStringOption((o) =>
      o.setName('guild').setDescription('WoW guild name').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('add-player-to-whitelist')
    .setDescription('Do not alert for these character names (suspects list)')
    .addStringOption((o) =>
      o.setName('player').setDescription('Character name as in Raider.io link').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('remove-player-from-whitelist')
    .setDescription('Remove a character from the suspect whitelist')
    .addStringOption((o) =>
      o.setName('player').setDescription('Character name').setRequired(true),
    ),
]
  .map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());

export async function registerSlashCommands(
  token: string,
  applicationId: string,
): Promise<void> {
  const rest = new REST().setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commands,
    });
  } else {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  }
}
