import { ChannelType } from 'discord.js';
import { handleRaiderIoMessage } from './raiderHandler.js';

/**
 * Ensure deterministic oldest→newest iteration for cursor-based forward scans.
 *
 * @param {import('discord.js').Collection<string, import('discord.js').Message<boolean>>} batch
 */
function messagesOldestFirst(batch) {
  return [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

/**
 * Forward-scan from a known last-processed message ID, processing only messages
 * that arrived after it. Direction: oldest→newest (ascending by ID via `after:`),
 * so the cursor advances monotonically and the last message handled is always the
 * most recent.
 *
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{
 *   afterMessageId: string;
 *   maxMessages?: number;
 *   alwaysPingUserId?: string;
 *   onProgress?: (p: {
 *     scanned: number;
 *     attempted: number;
 *     runningForMs: number;
 *   }) => Promise<void> | void;
 * }} opts
 */
export async function catchupFromCursor(channel, store, opts) {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    throw new Error('catchupFromCursor: unsupported channel type');
  }

  const maxMessages = Math.max(1, Math.min(50_000, Number(opts.maxMessages ?? 20_000)));
  const startedAt = Date.now();
  const maxRuntimeMs = 15 * 60 * 1000;
  const progressEveryMs = 5000;
  let lastProgressAt = 0;

  let scanned = 0;
  let attempted = 0;
  let stopReason = 'hit max_messages';

  let after = opts.afterMessageId;

  while (scanned < maxMessages) {
    if (opts.onProgress && Date.now() - lastProgressAt > progressEveryMs) {
      lastProgressAt = Date.now();
      await opts.onProgress({ scanned, attempted, runningForMs: Date.now() - startedAt });
    }
    if (Date.now() - startedAt > maxRuntimeMs) {
      stopReason = `hit runtime cap (${Math.round(maxRuntimeMs / 1000)}s)`;
      break;
    }

    const remaining = maxMessages - scanned;
    const limit = Math.max(1, Math.min(100, remaining));
    // `after:` returns messages in ascending order (oldest first in each page).
    const batch = await channel.messages.fetch({ limit, after });
    if (batch.size === 0) { stopReason = 'caught up to channel head'; break; }

    const msgs = messagesOldestFirst(batch);
    after = msgs[msgs.length - 1].id;

    for (const msg of msgs) {
      scanned += 1;
      if (!msg.author?.bot) continue;
      if (msg.author.username !== 'Raider.IO') continue;

      attempted += 1;
      await handleRaiderIoMessage(msg, store, { alwaysPingUserId: opts.alwaysPingUserId });
    }
  }

  if (opts.onProgress) {
    await opts.onProgress({ scanned, attempted, runningForMs: Date.now() - startedAt });
  }

  return { scanned, attempted, stopReason };
}
