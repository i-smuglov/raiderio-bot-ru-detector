import {
  ChannelType,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import {
  parseRunFromDescription,
  fetchRunDetails,
  rosterFromRunDetails,
  runHasCyrillic,
  trackedMembersInRoster,
  embedFromMessageEmbed,
} from './helper.js';

const CYRILLIC_REGEX = /[а-яА-Я]/;
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const logDebug = (...args) => {
  if (LOG_LEVEL === 'debug') console.log(...args);
};

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

  if (!message.guild) { logDebug(tag, 'skip: no guild'); return; }
  if (!isRaidEmbedChannel(message.channel)) { logDebug(tag, 'skip: channel type', message.channel.type); return; }

  const embed = message.embeds[0];
  if (!embed) { logDebug(tag, 'skip: no embed'); return; }

  const description = embed.description;
  if (!description) { logDebug(tag, 'skip: no description'); return; }

  const guildId = message.guild.id;

  const settings = await store.getSettings(guildId);
  const wowGuildName = settings?.wow_guild_name ?? null;
  const canAlert = Boolean(opts.alwaysPingUserId || settings?.officer_role_id);
  const detectGuildCyrillic = Boolean(settings?.detect_guild_cyrillic);

  if (!canAlert) {
    logDebug(tag, 'skip: alert would ping nobody (no officer_role_id, no alwaysPingUserId)');
    return;
  }

  if (!wowGuildName) {
    logDebug(tag, 'skip: wow_guild_name not configured (run /setup)');
    return;
  }

  // If guild-mode is OFF, we only care about Cyrillic in the message itself (player names).
  // Avoid Raider.IO API calls when the embed text already proves "no Cyrillic".
  const hasCyrillicInMessage = CYRILLIC_REGEX.test(description);
  if (!detectGuildCyrillic && !hasCyrillicInMessage) {
    logDebug(tag, 'skip: guild-mode off and no Cyrillic in embed text (no API call)');
    return;
  }

  const run = parseRunFromDescription(description);
  if (!run) {
    logDebug(tag, 'skip: no run link found in embed description');
    return;
  }

  const body = await fetchRunDetails(run.season, run.id);
  if (!body) {
    logDebug(tag, `skip: failed to fetch run-details season=${run.season} id=${run.id}`);
    return;
  }

  const roster = rosterFromRunDetails(body);
  if (roster.length === 0) {
    logDebug(tag, `skip: run-details returned empty roster season=${run.season} id=${run.id}`);
    return;
  }

  const hasCyrillic = detectGuildCyrillic
    ? runHasCyrillic(CYRILLIC_REGEX, roster)
    : roster.some((p) => CYRILLIC_REGEX.test(p.name));
  logDebug(tag, `hasCyrillic (run-details): ${hasCyrillic}`);
  if (LOG_LEVEL === 'debug') {
    const hits = roster
      .filter((p) =>
        detectGuildCyrillic
          ? (CYRILLIC_REGEX.test(p.name) || (p.guildName && CYRILLIC_REGEX.test(p.guildName)))
          : CYRILLIC_REGEX.test(p.name),
      )
      .map((p) => `${p.name}${p.guildName ? ` [${p.guildName}]` : ''}`);
    if (hits.length) logDebug(tag, `cyrillicHits: ${hits.join(', ')}`);
  }

  if (!hasCyrillic) {
    logDebug(tag, 'skip: no cyrillic (run-details)');
    return;
  }

  const suspectNames = trackedMembersInRoster(wowGuildName, roster);
  logDebug(tag, `suspectNames: ${suspectNames.join(', ') || '(none)'}`);

  if (suspectNames.length === 0) {
    logDebug(tag, 'skip: no tracked guild members found in this run roster');
    return;
  }

  // Once per run per player (avoid double-increment if the same name appears twice).
  const uniqSuspectNames = [...new Set(suspectNames)];
  const strikes = await store.incrementStrikes(uniqSuspectNames);

  const parts = uniqSuspectNames.map((name, i) => {
    const count = strikes[i] ?? 0;
    const label = count === 1 ? 'strike' : 'strikes';
    return `${name} (${count} ${label})`;
  });

  const reasonParts = roster
    .filter((p) =>
      detectGuildCyrillic
        ? (CYRILLIC_REGEX.test(p.name) || (p.guildName && CYRILLIC_REGEX.test(p.guildName)))
        : CYRILLIC_REGEX.test(p.name),
    )
    .map((p) => `${p.name}-[${p.guildName ?? '—'}]`);
  const reason = reasonParts.length ? reasonParts.join(', ') : '—';

  const mentionParts = [
    opts.alwaysPingUserId ? `<@${opts.alwaysPingUserId}>` : '',
    settings?.officer_role_id ? `<@&${settings.officer_role_id}>` : '',
  ].filter(Boolean);
  const mention = mentionParts.length ? `${mentionParts.join(' ')} ` : '';

  const thread = await createAlertThread(message.channel);
  await thread.send({
    content: `${mention}Imposter detected.\n${parts.join('\n')}.\nReason: ${reason}`,
    embeds: [embedFromMessageEmbed(embed)],
  });
}
