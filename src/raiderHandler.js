import {
  ChannelType,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import {
  namesAndRealms,
  ensureGuildsResolved,
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
  const name = `flagged-run-${Date.now()}`.slice(0, 100);
  const base = {
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: 'Raider.IO RU detector alert',
  };
  try {
    if (channel.type === ChannelType.GuildText) {
      return await channel.threads.create({ ...base, type: ChannelType.PrivateThread });
    }
    return await channel.threads.create({ ...base, type: ChannelType.AnnouncementThread });
  } catch (e) {
    console.error('[createAlertThread] failed to create thread:', e);
    throw e;
  }
}

/**
 * @param {import('discord.js').Message} message
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ alwaysPingUserId?: string }} [opts]
 */
export async function handleRaiderIoMessage(message, store, opts = {}) {
  const tag = `[raider-handler][ch:${message.channelId}]`;

  if (!message.guild) { console.log(tag, 'skip: no guild'); return; }
  if (!isRaidEmbedChannel(message.channel)) { console.log(tag, 'skip: channel type', message.channel.type); return; }

  const embed = message.embeds[0];
  if (!embed) { console.log(tag, 'skip: no embed'); return; }

  const description = embed.description;
  if (!description) { console.log(tag, 'skip: no description'); return; }

  const guildId = message.guild.id;
  const pairs = namesAndRealms(description);
  console.log(tag, `pairs found: ${pairs.length}`, pairs.map(([r, n]) => `${n}@${r}`).join(', '));
  if (pairs.length === 0) { console.log(tag, 'skip: no player pairs parsed'); return; }

  const hasCyrillic = CYRILLIC_REGEX.test(description);
  console.log(tag, `hasCyrillic: ${hasCyrillic}`);

  if (!hasCyrillic) {
    if (!opts.alwaysPingUserId) { console.log(tag, 'skip: no cyrillic, no alwaysPingUserId'); return; }
    const thread = await createAlertThread(message.channel);
    await thread.send({
      content: `<@${opts.alwaysPingUserId}> No Cyrillic detected.`,
      embeds: [embedFromMessageEmbed(embed)],
    });
    return;
  }

  /** @type {Map<string, string | null>} */
  const guildByPair = new Map();
  await ensureGuildsResolved(pairs, guildByPair);
  console.log(tag, 'guildByPair:', [...guildByPair.entries()].map(([k, v]) => `${k}=${v}`).join(', '));

  const settings = await store.getSettings(guildId);
  const wowGuildName = settings?.wow_guild_name ?? null;
  console.log(tag, `wowGuildName: ${wowGuildName}`);
  const suspectNames = suspectNamesMatchingGuild(wowGuildName, pairs, guildByPair);
  console.log(tag, `suspectNames: ${suspectNames.join(', ') || '(none)'}`);

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
