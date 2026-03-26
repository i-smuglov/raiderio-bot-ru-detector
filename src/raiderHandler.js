import {
  ChannelType,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import {
  namesAndRealms,
  ensureGuildsResolved,
  shouldAlertForCyrillicUnwhitelisted,
  suspectNamesMatchingGuild,
  embedFromMessageEmbed,
} from './helper.js';

const CYRILLIC_REGEX = /[а-яА-Я]/;

/**
 * @param {import('discord.js').Message['channel']} ch
 * @returns {ch is import('discord.js').TextChannel | import('discord.js').NewsChannel}
 */
function isRaidEmbedChannel(ch) {
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement
  );
}

/**
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 */
async function createAlertThread(channel) {
  const name = `ru-detector-${Date.now()}`.slice(0, 100);
  const base = {
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: 'Raider.IO RU detector alert',
  };
  if (channel.type === ChannelType.GuildText) {
    return channel.threads.create({ ...base, type: ChannelType.PrivateThread });
  }
  return channel.threads.create({ ...base, type: ChannelType.AnnouncementThread });
}

/**
 * @param {import('discord.js').Message} message
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ alwaysPingUserId?: string }} [opts]
 */
export async function handleRaiderIoMessage(message, store, opts = {}) {
  if (!message.guild || !isRaidEmbedChannel(message.channel)) return;

  const embed = message.embeds[0];
  if (!embed) return;

  const description = embed.description;
  if (!description) return;

  const guildId = message.guild.id;
  const pairs = namesAndRealms(description);
  if (pairs.length === 0) return;

  if (!CYRILLIC_REGEX.test(description)) return;

  const whitelistedGuilds = await store.listWhitelistedGuildNames(guildId);

  /** @type {Map<string, string | null>} */
  const guildByPair = new Map();
  const cyrillicPlayerPairs = pairs.filter(([, playerName]) => CYRILLIC_REGEX.test(playerName));
  await ensureGuildsResolved(cyrillicPlayerPairs, guildByPair);

  if (!shouldAlertForCyrillicUnwhitelisted(description, whitelistedGuilds, pairs, guildByPair)) {
    return;
  }

  await ensureGuildsResolved(pairs, guildByPair);

  const settings = await store.getSettings(guildId);
  const wowGuildName = settings?.wow_guild_name ?? null;
  const suspectNames = suspectNamesMatchingGuild(wowGuildName, pairs, guildByPair);
  const playerWhitelist = await store.listWhitelistedPlayers(guildId);

  if (suspectNames.length > 0 && suspectNames.every((n) => playerWhitelist.includes(n))) {
    return;
  }

  const strikes = await Promise.all(
    suspectNames.map((name) => store.incrementStrike(guildId, name)),
  );

  const parts = suspectNames.map((name, i) => {
    const count = strikes[i] ?? 0;
    const label = count === 1 ? 'strike' : 'strikes';
    return `${name} (${count} ${label})`;
  });

  const mentionParts = [
    opts.alwaysPingUserId ? `<@${opts.alwaysPingUserId}>` : '',
    settings?.officer_role_id ? `<@&${settings.officer_role_id}>` : '',
  ].filter(Boolean);
  const mention = mentionParts.length ? `${mentionParts.join(' ')} ` : '';

  const thread = await createAlertThread(message.channel);
  await thread.send({
    content: `${mention}Imposter detected. ${parts.join(', ')}`,
    embeds: [embedFromMessageEmbed(embed)],
  });
}
