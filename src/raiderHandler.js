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

// ---------------------------------------------------------------------------
// Per-guild gap tracker (in-memory, resets on restart — intentional).
//
// When a message can't be definitively evaluated (transient API failure), its
// ID is recorded as a "gap". Subsequent messages in the same guild are still
// processed normally, but the cursor is NOT advanced past the gap. On the next
// restart, catchup re-scans from the old cursor position and retries every
// message from the gap onward. Messages that were already actioned (threads
// created, clean runs confirmed) are handled via the normal dedup path.
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<bigint>>} guildId → set of unsettled message IDs */
const pendingGaps = new Map();

/** @param {string} guildId @param {string} messageId */
function recordGap(guildId, messageId) {
  let s = pendingGaps.get(guildId);
  if (!s) { s = new Set(); pendingGaps.set(guildId, s); }
  s.add(BigInt(messageId));
}

/** @param {string} guildId @param {string} messageId */
function resolveGap(guildId, messageId) {
  pendingGaps.get(guildId)?.delete(BigInt(messageId));
}

/**
 * Returns true when at least one recorded gap for this guild has a lower
 * snowflake than messageId — meaning the cursor must not advance past it yet.
 *
 * @param {string} guildId
 * @param {string} messageId
 */
function hasEarlierGap(guildId, messageId) {
  const s = pendingGaps.get(guildId);
  if (!s || s.size === 0) return false;
  const id = BigInt(messageId);
  for (const gap of s) {
    if (gap < id) return true;
  }
  return false;
}

/**
 * Deterministic thread name for a given source message ID.
 * Encoding the source message ID here is what makes Discord the authoritative
 * dedup store: we can always ask "does a thread named alert-{id} exist?" without
 * touching the DB. Threads remain private — only the name changes.
 *
 * @param {string} sourceMessageId
 */
export function alertThreadName(sourceMessageId) {
  return `alert-${sourceMessageId}`;
}

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
 * Check active threads in the channel for one named alert-{sourceMessageId}.
 * Returns the thread if found, null otherwise.
 * Only active threads are checked — archived threads require expensive pagination.
 * This is acceptable because the primary dedup path is the DB cursor (catchupFromCursor
 * only ever sees messages newer than the last processed one). This check is the
 * last-resort safety net for the case where the cursor write failed and a previously
 * flagged thread is still active (within its auto-archive window).
 *
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {string} sourceMessageId
 */
async function findActiveAlertThread(channel, sourceMessageId) {
  try {
    const fetched = await channel.threads.fetchActive();
    return fetched.threads.find((t) => t.name === alertThreadName(sourceMessageId)) ?? null;
  } catch (e) {
    // Non-fatal: if we can't fetch threads, allow the alert to proceed.
    // Worst case: a duplicate thread is created, which is recoverable.
    console.warn('[findActiveAlertThread] fetch failed, assuming no thread:', e?.message ?? e);
    return null;
  }
}

/**
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {string} sourceMessageId
 */
async function createAlertThread(channel, sourceMessageId) {
  const name = alertThreadName(sourceMessageId);
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
  const canAlert = Boolean(settings?.officer_role_id);
  const detectGuildCyrillic = Boolean(settings?.detect_guild_cyrillic);

  if (!canAlert) {
    logDebug(tag, 'skip: alert would ping nobody (no officer_role_id)');
    return;
  }

  if (!wowGuildName) {
    logDebug(tag, 'skip: wow_guild_name not configured (run /setup)');
    return;
  }

  // Advance the cursor only on definitive outcomes (clean or flagged).
  // Resolves this message's gap entry (if any) then writes the cursor only when
  // no earlier gap exists — ensuring the cursor never skips over a pending retry.
  const markChecked = () => {
    resolveGap(guildId, message.id);
    if (hasEarlierGap(guildId, message.id)) {
      logDebug(tag, `cursor hold: earlier gap present, not advancing past ${message.id}`);
      return;
    }
    store.saveCheckedMessage(guildId, { channelId: message.channelId, messageId: message.id })
      .catch((e) => console.error(tag, 'saveCheckedMessage failed:', e));
  };

  const run = parseRunFromDescription(description);
  if (!run) {
    logDebug(tag, 'skip: no run link found in embed description');
    markChecked(); // definitive: not a run post
    return;
  }

  const body = await fetchRunDetails(run.season, run.id);
  if (!body) {
    // Transient failure — record the gap so the cursor cannot advance past this
    // message until it is retried. The next restart's catchup will re-scan from
    // the last committed cursor position and re-evaluate this message.
    recordGap(guildId, message.id);
    console.warn(tag, `raider.io API unavailable for season=${run.season} id=${run.id} — gap recorded, will retry on next restart`);
    return;
  }

  const roster = rosterFromRunDetails(body);
  if (roster.length === 0) {
    logDebug(tag, `skip: run-details returned empty roster season=${run.season} id=${run.id}`);
    markChecked(); // definitive: API responded, no roster to evaluate
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
    markChecked(); // definitive: clean run
    return;
  }

  const suspectNames = trackedMembersInRoster(wowGuildName, roster);
  logDebug(tag, `suspectNames: ${suspectNames.join(', ') || '(none)'}`);

  if (suspectNames.length === 0) {
    logDebug(tag, 'skip: no tracked guild members found in this run roster');
    markChecked(); // definitive: cyrillic present but none from our guild
    return;
  }

  // Discord-native dedup: check whether an alert thread for this exact source message
  // already exists before creating a new one. This is the safety net that prevents
  // duplicate alerts when the DB cursor write failed and the bot reprocesses the same
  // message on a subsequent catchup run.
  const existingThread = await findActiveAlertThread(message.channel, message.id);
  if (existingThread) {
    logDebug(tag, `skip: alert thread already exists (${existingThread.id}) for message ${message.id}`);
    markChecked(); // definitive: already handled in a previous run
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

  // createAlertThread throws on Discord error — if it does, markChecked is never
  // called and the cursor stays behind this message so catchup can retry.
  const thread = await createAlertThread(message.channel, message.id);
  const threadMessage = await thread.send({
    content: `${mention}Imposter detected.\n${parts.join('\n')}.\nReason: ${reason}`,
    embeds: [embedFromMessageEmbed(embed)],
  });

  // Advance cursor only after the thread is confirmed created.
  markChecked();

  // Fire-and-forget: thread creation is already the authoritative record.
  // A DB failure here is recoverable — the thread exists, officers are notified.
  store.saveFlaggedAlert(guildId, {
    sourceChannelId: message.channelId,
    sourceMessageId: message.id,
    threadChannelId: thread.id,
    threadMessageId: threadMessage.id,
  }).catch((e) => console.error(tag, 'saveFlaggedAlert failed:', e));
}
