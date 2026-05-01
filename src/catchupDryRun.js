import { ChannelType } from 'discord.js';

const CYRILLIC_REGEX = /[а-яА-Я]/;

/**
 * @param {import('discord.js').Message} message
 * @param {{ detect_guild_cyrillic?: boolean | null } | null} settings
 * @returns {{ flagged: boolean; reason: string }}
 */
export function dryRunWouldFlag(message, settings) {
  const detectGuildCyrillic = Boolean(settings?.detect_guild_cyrillic);
  const embed = message.embeds?.[0];
  const description = embed?.description ?? '';

  if (!description) return { flagged: false, reason: 'skip: no embed description' };

  if (detectGuildCyrillic) {
    // In guild-mode we need roster + guild names, which requires Raider.IO API.
    // This iteration is API-free.
    return { flagged: false, reason: 'skip: guild-mode requires Raider.IO API' };
  }

  const hasCyrillicInMessage = CYRILLIC_REGEX.test(description);
  if (!hasCyrillicInMessage) return { flagged: false, reason: 'ok: no Cyrillic in embed text' };
  return { flagged: true, reason: 'flag: Cyrillic detected in embed text (guild-mode off)' };
}

/**
 * Scan a channel newest → older until the first message that already has a thread.
 * Only logs what would be flagged (dry-run). No external API calls.
 *
 * @param {import('discord.js').TextChannel | import('discord.js').NewsChannel} channel
 * @param {{ detect_guild_cyrillic?: boolean | null } | null} settings
 * @param {{ maxMessages?: number }} [opts]
 */
export async function catchupDryRunChannel(channel, settings, opts = {}) {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    throw new Error('catchupDryRunChannel: unsupported channel type');
  }

  const maxMessages = Math.max(1, Math.min(20_000, Number(opts.maxMessages ?? 2000)));

  /** @type {{ url: string; id: string; createdAt: string; reason: string }[]} */
  const flagged = [];
  let scanned = 0;
  let stopReason = 'hit max_messages';

  /** @type {string | undefined} */
  let before;

  while (scanned < maxMessages) {
    const remaining = maxMessages - scanned;
    const limit = Math.max(1, Math.min(100, remaining));
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
    if (batch.size === 0) { stopReason = 'reached channel start'; break; }

    // Discord returns newest → older for fetch({ before }).
    for (const msg of batch.values()) {
      scanned += 1;
      before = msg.id;

      if (msg.hasThread) { stopReason = 'found message with existing thread'; return { scanned, stopReason, flagged }; }

      if (!msg.author?.bot) continue;
      if (msg.author.username !== 'Raider.IO') continue;

      const r = dryRunWouldFlag(msg, settings);
      if (r.flagged) {
        flagged.push({
          url: msg.url,
          id: msg.id,
          createdAt: msg.createdAt.toISOString(),
          reason: r.reason,
        });
      }

      if (scanned >= maxMessages) break;
    }
  }

  return { scanned, stopReason, flagged };
}

