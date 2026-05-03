import {
  ChannelType,
  ThreadAutoArchiveDuration,
  Routes,
  MessageFlags,
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
 * @param {number | string | undefined | null} flags
 */
function messageHasThread(flags) {
  return (Number(flags ?? 0) & MessageFlags.HasThread) === MessageFlags.HasThread;
}

/**
 * @param {import('discord.js').Embed | import('discord.js').APIEmbed} embed
 * @returns {string | null}
 */
function embedDescription(embed) {
  if (embed && typeof embed === 'object' && 'description' in embed) {
    const d = /** @type {{ description?: string | null }} */ (embed).description;
    return typeof d === 'string' ? d : null;
  }
  return null;
}

/**
 * @param {import('discord.js').REST} rest
 * @param {string} channelId
 * @param {number} channelType
 */
async function createAlertThreadRest(rest, channelId, channelType) {
  const name = `flagged-run-${Date.now()}`.slice(0, 100);
  const threadType =
    channelType === ChannelType.GuildText ? ChannelType.PrivateThread : ChannelType.AnnouncementThread;
  const body = {
    name,
    auto_archive_duration: ThreadAutoArchiveDuration.OneDay,
    type: threadType,
  };
  /** @type {{ id: string }} */
  const thread = /** @type {unknown} */ (
    await rest.post(Routes.threads(channelId), { body })
  );
  if (!thread?.id) throw new Error('createAlertThreadRest: missing thread id');
  return thread.id;
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
 * Core detection: returns alert payload or null if no alert.
 *
 * @param {{
 *   guildId: string;
 *   embed: import('discord.js').Embed | import('discord.js').APIEmbed;
 *   store: import('./guildStore.js').GuildStore;
 *   alwaysPingUserId?: string;
 * }} args
 * @returns {Promise<{ content: string; embed: import('discord.js').APIEmbed } | null>}
 */
export async function buildRaiderIoAlertPayload(args) {
  const { guildId, embed, store, alwaysPingUserId } = args;
  const tag = `[raider-handler][guild:${guildId}]`;

  const description = embedDescription(embed);
  if (!description) {
    logDebug(tag, 'skip: no description');
    return null;
  }

  const settings = await store.getSettings(guildId);
  const wowGuildName = settings?.wow_guild_name ?? null;
  const canAlert = Boolean(alwaysPingUserId || settings?.officer_role_id);
  const detectGuildCyrillic = Boolean(settings?.detect_guild_cyrillic);

  if (!canAlert) {
    logDebug(tag, 'skip: alert would ping nobody (no officer_role_id, no alwaysPingUserId)');
    return null;
  }

  if (!wowGuildName) {
    logDebug(tag, 'skip: wow_guild_name not configured (run /setup)');
    return null;
  }

  const hasCyrillicInMessage = CYRILLIC_REGEX.test(description);
  if (!detectGuildCyrillic && !hasCyrillicInMessage) {
    logDebug(tag, 'skip: guild-mode off and no Cyrillic in embed text (no API call)');
    return null;
  }

  const run = parseRunFromDescription(description);
  if (!run) {
    logDebug(tag, 'skip: no run link found in embed description');
    return null;
  }

  const body = await fetchRunDetails(run.season, run.id);
  if (!body) {
    logDebug(tag, `skip: failed to fetch run-details season=${run.season} id=${run.id}`);
    return null;
  }

  const roster = rosterFromRunDetails(body);
  if (roster.length === 0) {
    logDebug(tag, `skip: run-details returned empty roster season=${run.season} id=${run.id}`);
    return null;
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
    return null;
  }

  const suspectNames = trackedMembersInRoster(wowGuildName, roster);
  logDebug(tag, `suspectNames: ${suspectNames.join(', ') || '(none)'}`);

  if (suspectNames.length === 0) {
    logDebug(tag, 'skip: no tracked guild members found in this run roster');
    return null;
  }

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
    alwaysPingUserId ? `<@${alwaysPingUserId}>` : '',
    settings?.officer_role_id ? `<@&${settings.officer_role_id}>` : '',
  ].filter(Boolean);
  const mention = mentionParts.length ? `${mentionParts.join(' ')} ` : '';

  const embedOut =
    'data' in embed && embed.data
      ? /** @type {import('discord.js').APIEmbed} */ (embed.data)
      : /** @type {import('discord.js').APIEmbed} */ (embed);

  const content = `${mention}Imposter detected.\n${parts.join('\n')}.\nReason: ${reason}`;
  return { content, embed: embedOut };
}

/**
 * @param {import('discord.js').Message} message
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ alwaysPingUserId?: string }} [opts]
 */
export async function handleRaiderIoMessage(message, store, opts = {}) {
  const tag = `[raider-handler][ch:${message.channelId}]`;

  if (!message.guild) {
    logDebug(tag, 'skip: no guild');
    return;
  }
  if (!isRaidEmbedChannel(message.channel)) {
    logDebug(tag, 'skip: channel type', message.channel.type);
    return;
  }

  const embed = message.embeds[0];
  if (!embed) {
    logDebug(tag, 'skip: no embed');
    return;
  }

  const guildId = message.guild.id;
  const payload = await buildRaiderIoAlertPayload({
    guildId,
    embed,
    store,
    alwaysPingUserId: opts.alwaysPingUserId,
  });
  if (!payload) return;

  const thread = await createAlertThread(message.channel);
  await thread.send({
    content: payload.content,
    embeds: [embedFromMessageEmbed(message.embeds[0])],
  });
}

/**
 * Handle a Raider.IO message delivered via REST (cron / catchup).
 *
 * @param {import('discord.js').REST} rest
 * @param {{ channel_id: string; guild_id?: string | null; flags?: number; author?: { bot?: boolean; username?: string } | null; embeds?: import('discord.js').APIEmbed[] }} apiMessage
 * @param {number} channelType
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ alwaysPingUserId?: string }} [opts]
 * @param {string} [guildIdFallback] when `guild_id` is missing on the API message payload
 */
export async function handleRaiderIoApiMessage(rest, apiMessage, channelType, store, opts = {}, guildIdFallback) {
  const tag = `[raider-handler][rest][ch:${apiMessage.channel_id}]`;

  if (channelType !== ChannelType.GuildText && channelType !== ChannelType.GuildAnnouncement) {
    logDebug(tag, 'skip: channel type', channelType);
    return;
  }

  const guildId = apiMessage.guild_id ?? guildIdFallback;
  if (!guildId) {
    logDebug(tag, 'skip: no guild_id on message');
    return;
  }

  if (messageHasThread(apiMessage.flags)) {
    logDebug(tag, 'skip: already has thread');
    return;
  }

  const author = apiMessage.author;
  if (!author?.bot || author.username !== 'Raider.IO') {
    logDebug(tag, 'skip: not Raider.IO bot');
    return;
  }

  const rawEmbed = apiMessage.embeds?.[0];
  if (!rawEmbed) {
    logDebug(tag, 'skip: no embed');
    return;
  }

  const payload = await buildRaiderIoAlertPayload({
    guildId,
    embed: rawEmbed,
    store,
    alwaysPingUserId: opts.alwaysPingUserId,
  });
  if (!payload) return;

  const threadId = await createAlertThreadRest(rest, apiMessage.channel_id, channelType);
  await rest.post(Routes.channelMessages(threadId), {
    body: {
      content: payload.content,
      embeds: [payload.embed],
    },
  });
}
