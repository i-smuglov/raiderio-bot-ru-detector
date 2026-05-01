import { ChannelType } from 'discord.js';
import { handleRaiderIoMessage } from './raiderHandler.js';

/**
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {number} days
 * @returns {Date}
 */
function cutoffDate(days) {
  const d = Math.max(1, Math.min(365, Number(days || 0)));
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

/**
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ days: number; maxMessages?: number; alwaysPingUserId?: string }} opts
 */
export async function catchupPreview(channel, store, opts) {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    throw new Error('catchupPreview: unsupported channel type');
  }

  const maxMessages = Math.max(1, Math.min(50_000, Number(opts.maxMessages ?? 20_000)));
  const cutoff = cutoffDate(opts.days);

  let scanned = 0;
  let inRange = 0;
  let alreadyThreaded = 0;
  let candidates = 0;
  let stopReason = 'hit max_messages';

  /** @type {string | undefined} */
  let before;

  while (scanned < maxMessages) {
    const remaining = maxMessages - scanned;
    const limit = Math.max(1, Math.min(100, remaining));
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
    if (batch.size === 0) { stopReason = 'reached channel start'; break; }

    for (const msg of batch.values()) {
      scanned += 1;
      before = msg.id;

      if (msg.createdAt < cutoff) { stopReason = `reached cutoff (${cutoff.toISOString()})`; return { scanned, inRange, alreadyThreaded, candidates, stopReason, cutoff }; }
      inRange += 1;

      if (msg.hasThread) { alreadyThreaded += 1; continue; }
      if (!msg.author?.bot) continue;
      if (msg.author.username !== 'Raider.IO') continue;
      const embed = msg.embeds?.[0];
      const description = embed?.description ?? '';
      if (!description) continue;

      // "Candidate" here means "looks like a Raider.IO run post with content".
      candidates += 1;
    }
  }

  return { scanned, inRange, alreadyThreaded, candidates, stopReason, cutoff };
}

/**
 * Scan newest → older within last N days and run the normal handler for each
 * detected imposter run that does not yet have a thread. If a thread exists, skip and continue.
 *
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ days: number; maxMessages?: number; alwaysPingUserId?: string }} opts
 */
export async function catchupExecute(channel, store, opts) {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    throw new Error('catchupExecute: unsupported channel type');
  }

  const maxMessages = Math.max(1, Math.min(50_000, Number(opts.maxMessages ?? 20_000)));
  const cutoff = cutoffDate(opts.days);

  let scanned = 0;
  let inRange = 0;
  let alreadyThreaded = 0;
  let attempted = 0;
  let stopReason = 'hit max_messages';

  /** @type {string | undefined} */
  let before;

  while (scanned < maxMessages) {
    const remaining = maxMessages - scanned;
    const limit = Math.max(1, Math.min(100, remaining));
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
    if (batch.size === 0) { stopReason = 'reached channel start'; break; }

    for (const msg of batch.values()) {
      scanned += 1;
      before = msg.id;

      if (msg.createdAt < cutoff) { stopReason = `reached cutoff (${cutoff.toISOString()})`; return { scanned, inRange, alreadyThreaded, attempted, stopReason, cutoff }; }
      inRange += 1;

      if (msg.hasThread) { alreadyThreaded += 1; continue; }
      if (!msg.author?.bot) continue;
      if (msg.author.username !== 'Raider.IO') continue;

      attempted += 1;
      await handleRaiderIoMessage(msg, store, { alwaysPingUserId: opts.alwaysPingUserId });
    }
  }

  return { scanned, inRange, alreadyThreaded, attempted, stopReason, cutoff };
}

