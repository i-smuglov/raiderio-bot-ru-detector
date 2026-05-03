import { REST, Routes, ChannelType, MessageFlags } from 'discord.js';
import { handleRaiderIoApiMessage } from './raiderHandler.js';

/**
 * @param {unknown[]} batch
 */
function messagesNewestFirst(batch) {
  return [...batch].sort((a, b) => {
    const ida = /** @type {{ id?: string }} */ (a).id ?? '';
    const idb = /** @type {{ id?: string }} */ (b).id ?? '';
    if (ida === idb) return 0;
    return ida < idb ? 1 : -1;
  });
}

/**
 * @param {REST} rest
 * @param {string} channelId
 * @param {{ limit: number; before?: string }} q
 */
async function fetchMessageBatch(rest, channelId, q) {
  const params = new URLSearchParams({ limit: String(q.limit) });
  if (q.before) params.set('before', q.before);
  /** @type {unknown[]} */
  const data = /** @type {unknown} */ (
    await rest.get(Routes.channelMessages(channelId), { query: params })
  );
  return Array.isArray(data) ? data : [];
}

/**
 * @param {REST} rest
 * @param {string} channelId
 * @param {string} guildId
 * @param {{ days: number; maxMessages?: number; alwaysPingUserId?: string }} opts
 */
export async function catchupPreviewRest(rest, channelId, guildId, opts) {
  /** @type {{ type?: number; guild_id?: string }} */
  const channel = /** @type {unknown} */ (await rest.get(Routes.channel(channelId)));
  const channelType = Number(channel.type);
  if (channelType !== ChannelType.GuildText && channelType !== ChannelType.GuildAnnouncement) {
    throw new Error('catchupPreviewRest: unsupported channel type');
  }
  if (channel.guild_id && channel.guild_id !== guildId) {
    throw new Error('catchupPreviewRest: channel does not belong to this guild');
  }

  const maxMessages = Math.max(1, Math.min(50_000, Number(opts.maxMessages ?? 20_000)));
  const days = Math.max(1, Math.min(365, Number(opts.days || 0)));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const startedAt = Date.now();
  const maxRuntimeMs = 5 * 60 * 1000;

  let scanned = 0;
  let inRange = 0;
  let alreadyThreaded = 0;
  let candidates = 0;
  let stopReason = 'hit max_messages';

  /** @type {string | undefined} */
  let before;

  while (scanned < maxMessages) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      stopReason = `hit runtime cap (${Math.round(maxRuntimeMs / 1000)}s)`;
      break;
    }
    const remaining = maxMessages - scanned;
    const limit = Math.max(1, Math.min(100, remaining));
    const batch = await fetchMessageBatch(rest, channelId, { limit, ...(before ? { before } : {}) });
    if (batch.length === 0) {
      stopReason = 'reached channel start';
      break;
    }

    const msgs = messagesNewestFirst(batch);
    before = /** @type {{ id: string }} */ (msgs[msgs.length - 1]).id;

    for (const msg of msgs) {
      scanned += 1;
      const m = /** @type {{ id: string; timestamp?: string; flags?: number; author?: { bot?: boolean; username?: string }; embeds?: { description?: string }[] }} */ (msg);
      const createdAt = m.timestamp ? new Date(m.timestamp) : new Date(Number((BigInt(m.id) >> 22n) + 1420070400000n));
      if (createdAt < cutoff) {
        stopReason = `reached cutoff (${cutoff.toISOString()})`;
        return { scanned, inRange, alreadyThreaded, candidates, stopReason, cutoff };
      }
      inRange += 1;

      if ((Number(m.flags ?? 0) & MessageFlags.HasThread) === MessageFlags.HasThread) {
        alreadyThreaded += 1;
        continue;
      }
      if (!m.author?.bot) continue;
      if (m.author.username !== 'Raider.IO') continue;
      const description = m.embeds?.[0]?.description ?? '';
      if (!description) continue;
      candidates += 1;
    }
  }

  return { scanned, inRange, alreadyThreaded, candidates, stopReason, cutoff };
}

/**
 * @param {REST} rest
 * @param {string} channelId
 * @param {string} guildId
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{
 *  days: number;
 *  maxMessages?: number;
 *  alwaysPingUserId?: string;
 *  onProgress?: (p: {
 *    scanned: number;
 *    inRange: number;
 *    alreadyThreaded: number;
 *    attempted: number;
 *    cutoff: Date;
 *    runningForMs: number;
 *  }) => Promise<void> | void;
 * }} opts
 */
export async function catchupExecuteRest(rest, channelId, guildId, store, opts) {
  /** @type {{ type?: number; guild_id?: string }} */
  const channel = /** @type {unknown} */ (await rest.get(Routes.channel(channelId)));
  const channelType = Number(channel.type);
  if (channelType !== ChannelType.GuildText && channelType !== ChannelType.GuildAnnouncement) {
    throw new Error('catchupExecuteRest: unsupported channel type');
  }
  if (channel.guild_id && channel.guild_id !== guildId) {
    throw new Error('catchupExecuteRest: channel does not belong to this guild');
  }

  const maxMessages = Math.max(1, Math.min(50_000, Number(opts.maxMessages ?? 20_000)));
  const days = Math.max(1, Math.min(365, Number(opts.days || 0)));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const startedAt = Date.now();
  const maxRuntimeMs = 15 * 60 * 1000;
  const progressEveryMs = 5000;
  let lastProgressAt = 0;

  let scanned = 0;
  let inRange = 0;
  let alreadyThreaded = 0;
  let attempted = 0;
  let stopReason = 'hit max_messages';

  /** @type {string | undefined} */
  let before;

  while (scanned < maxMessages) {
    if (opts.onProgress && Date.now() - lastProgressAt > progressEveryMs) {
      lastProgressAt = Date.now();
      await opts.onProgress({
        scanned,
        inRange,
        alreadyThreaded,
        attempted,
        cutoff,
        runningForMs: Date.now() - startedAt,
      });
    }
    if (Date.now() - startedAt > maxRuntimeMs) {
      stopReason = `hit runtime cap (${Math.round(maxRuntimeMs / 1000)}s)`;
      break;
    }
    const remaining = maxMessages - scanned;
    const limit = Math.max(1, Math.min(100, remaining));
    const batch = await fetchMessageBatch(rest, channelId, { limit, ...(before ? { before } : {}) });
    if (batch.length === 0) {
      stopReason = 'reached channel start';
      break;
    }

    const msgs = messagesNewestFirst(batch);
    before = /** @type {{ id: string }} */ (msgs[msgs.length - 1]).id;

    for (const msg of msgs) {
      scanned += 1;
      const m = /** @type {{
        id: string;
        timestamp?: string;
        flags?: number;
        author?: { bot?: boolean; username?: string };
        embeds?: unknown[];
        channel_id?: string;
        guild_id?: string;
      }} */ (msg);
      const createdAt = m.timestamp ? new Date(m.timestamp) : new Date(Number((BigInt(m.id) >> 22n) + 1420070400000n));
      if (createdAt < cutoff) {
        stopReason = `reached cutoff (${cutoff.toISOString()})`;
        return { scanned, inRange, alreadyThreaded, attempted, stopReason, cutoff };
      }
      inRange += 1;

      if ((Number(m.flags ?? 0) & MessageFlags.HasThread) === MessageFlags.HasThread) {
        alreadyThreaded += 1;
        continue;
      }
      if (!m.author?.bot) continue;
      if (m.author.username !== 'Raider.IO') continue;

      attempted += 1;
      await handleRaiderIoApiMessage(
        rest,
        { ...m, channel_id: channelId, guild_id: guildId },
        channelType,
        store,
        { alwaysPingUserId: opts.alwaysPingUserId },
        guildId,
      );
    }
  }

  if (opts.onProgress) {
    await opts.onProgress({
      scanned,
      inRange,
      alreadyThreaded,
      attempted,
      cutoff,
      runningForMs: Date.now() - startedAt,
    });
  }

  return { scanned, inRange, alreadyThreaded, attempted, stopReason, cutoff };
}
