import { REST, Routes, ChannelType, MessageFlags } from 'discord.js';
import { handleRaiderIoApiMessage } from './raiderHandler.js';

/**
 * @param {string} a
 * @param {string} b
 */
function snowflakeMax(a, b) {
  return BigInt(a) > BigInt(b) ? a : b;
}

/**
 * Poll configured feed channels (REST). Safe to run on a cron; advances `last_polled_message_id`.
 *
 * @param {REST} rest
 * @param {import('./guildStore.js').GuildStore} store
 * @param {{ maxPagesPerGuild?: number }} [opts]
 */
export async function pollFeedChannels(rest, store, opts = {}) {
  const maxPages = Math.max(1, Math.min(50, Number(opts.maxPagesPerGuild ?? 10)));
  const rows = await store.listGuildsWithFeedChannel();
  if (rows.length === 0) {
    console.log('[poll] no guilds with feed_channel_id configured; skip');
    return { guilds: 0, messagesProcessed: 0 };
  }

  let messagesProcessed = 0;

  for (const row of rows) {
    const guildId = row.discord_guild_id;
    const channelId = row.feed_channel_id;
    let watermark = row.last_polled_message_id;

    try {
      /** @type {{ type?: number; guild_id?: string }} */
      const channel = /** @type {unknown} */ (await rest.get(Routes.channel(channelId)));
      const channelType = Number(channel.type);
      if (channelType !== ChannelType.GuildText && channelType !== ChannelType.GuildAnnouncement) {
        console.warn(`[poll] guild ${guildId} feed ${channelId}: unsupported channel type ${channelType}`);
        continue;
      }

      if (!watermark) {
        const params = new URLSearchParams({ limit: '1' });
        /** @type {unknown[]} */
        const newest = /** @type {unknown} */ (
          await rest.get(Routes.channelMessages(channelId), { query: params })
        );
        const first = Array.isArray(newest) && newest[0] ? /** @type {{ id: string }} */ (newest[0]) : null;
        if (first?.id) {
          await store.setLastPolledMessageId(guildId, first.id);
          console.log(`[poll] guild ${guildId}: initialized watermark to ${first.id} (no backlog scan)`);
        }
        continue;
      }

      for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({ limit: '100', after: watermark });
        /** @type {unknown[]} */
        const batch = /** @type {unknown} */ (
          await rest.get(Routes.channelMessages(channelId), { query: params })
        );
        if (!Array.isArray(batch) || batch.length === 0) break;

        const sorted = [...batch].sort((x, y) => {
          const idx = /** @type {{ id: string }} */ (x).id;
          const idy = /** @type {{ id: string }} */ (y).id;
          return idx < idy ? -1 : idx > idy ? 1 : 0;
        });

        let maxId = watermark;
        for (const raw of sorted) {
          const msg = /** @type {{
            id: string;
            flags?: number;
            author?: { bot?: boolean; username?: string } | null;
            embeds?: unknown[];
            channel_id?: string;
            guild_id?: string | null;
          }} */ (raw);
          maxId = snowflakeMax(maxId, msg.id);

          if ((Number(msg.flags ?? 0) & MessageFlags.HasThread) === MessageFlags.HasThread) continue;
          if (!msg.author?.bot || msg.author.username !== 'Raider.IO') continue;
          if (!msg.embeds?.length) continue;

          try {
            await handleRaiderIoApiMessage(
              rest,
              { ...msg, channel_id: channelId, guild_id: msg.guild_id ?? guildId },
              channelType,
              store,
              { alwaysPingUserId: process.env.BOT_DEBUG_USER_ID?.trim() || undefined },
              guildId,
            );
            messagesProcessed += 1;
          } catch (e) {
            console.error(`[poll] handler error guild=${guildId} msg=${msg.id}:`, e);
          }
        }

        watermark = maxId;
        await store.setLastPolledMessageId(guildId, watermark);

        if (batch.length < 100) break;
      }
    } catch (e) {
      console.error(`[poll] guild ${guildId} channel ${channelId}:`, e);
    }
  }

  return { guilds: rows.length, messagesProcessed };
}
