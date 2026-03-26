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
].map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());

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
  } else {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  }
}
