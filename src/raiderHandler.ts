import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type NewsChannel,
  type ThreadChannel,
} from 'discord.js';
import { GuildStore } from './guildStore.js';
import { embedFromMessageEmbed, russianInGroup, suspects } from './helper.js';

function isRaidEmbedChannel(ch: Message['channel'])
  : ch is TextChannel | NewsChannel {
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement
  );
}

async function createAlertThread(
  channel: TextChannel | NewsChannel,
): Promise<ThreadChannel> {
  const name = `ru-detector-${Date.now()}`.slice(0, 100);
  const base = {
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: 'Raider.IO RU detector alert',
  } as const;
  if (channel.type === ChannelType.GuildText) {
    return channel.threads.create({
      ...base,
      type: ChannelType.PrivateThread,
    });
  }
  return channel.threads.create({
    ...base,
    type: ChannelType.AnnouncementThread,
  });
}

export async function handleRaiderIoMessage(
  message: Message,
  store: GuildStore,
): Promise<void> {
  if (!message.guild || !isRaidEmbedChannel(message.channel)) return;

  const embed = message.embeds[0];
  if (!embed) return;

  const guildId = message.guild.id;
  const whitelistedGuilds = await store.listWhitelistedGuildNames(guildId);
  const description = embed.description;

  if (!(await russianInGroup(whitelistedGuilds, description))) return;

  const settings = await store.getSettings(guildId);
  const wowGuildName = settings?.wow_guild_name ?? null;
  const suspectNames = await suspects(description, wowGuildName);
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

  const roleId = settings?.officer_role_id;
  const mention = roleId ? `<@&${roleId}> ` : '';

  const thread = await createAlertThread(message.channel);

  await thread.send({
    content: `${mention}Imposter detected. ${parts.join(', ')}`,
    embeds: [embedFromMessageEmbed(embed)],
  });
}
