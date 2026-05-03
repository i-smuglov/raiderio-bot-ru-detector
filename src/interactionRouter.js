import {
  REST,
  Routes,
  ChannelType,
  InteractionType,
  MessageFlags,
  InteractionResponseType,
} from 'discord.js';
import { catchupPreviewRest, catchupExecuteRest } from './catchupRest.js';

const DB_ECONN_HINT =
  'Database connection refused: check DATABASE_URL (correct host, not localhost from a wrong copy), firewall, and that Postgres allows SSL if required (Neon: use the pooled connection string from the dashboard).';

/**
 * @param {unknown} e
 */
function errorOneLine(e) {
  if (!(e instanceof Error)) return formatInteractionError(e);
  const err = /** @type {Error & { code?: string; syscall?: string; detail?: string }} */ (e);
  const bits = [];
  if (err.message?.trim()) bits.push(err.message.trim());
  if (err.code) bits.push(`[${err.code}]`);
  if (err.syscall) bits.push(err.syscall);
  if (err.detail) bits.push(err.detail);
  return bits.length ? bits.join(' ') : err.name || 'Error';
}

/**
 * @param {unknown} e
 */
function formatInteractionError(e) {
  if (e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0) {
    const parts = e.errors.map((sub) => errorOneLine(sub));
    const uniq = [...new Set(parts.filter(Boolean))];
    let text = uniq.join('; ') || e.message || 'AggregateError';
    if (e.code === 'ECONNREFUSED') text += ` ${DB_ECONN_HINT}`;
    return text;
  }

  if (e instanceof Error) {
    let text = errorOneLine(e);
    const err = /** @type {Error & { code?: string }} */ (e);
    if (err.code === 'ECONNREFUSED') text += ` ${DB_ECONN_HINT}`;
    return text;
  }

  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'code' in e) {
    const o = /** @type {{ code?: string; message?: string }} */ (e);
    return [o.message, o.code && `[${o.code}]`].filter(Boolean).join(' ') || 'Unknown error';
  }
  try {
    return JSON.stringify(e);
  } catch {
    return e === undefined || e === null ? 'Unknown error — check host logs' : String(e);
  }
}

/**
 * @param {import('discord.js').APIApplicationCommandInteractionData} data
 * @param {string} name
 */
function optString(data, name) {
  const o = data.options?.find((x) => x.name === name);
  if (!o || o.type !== 3) return null;
  return typeof o.value === 'string' ? o.value : null;
}

/**
 * @param {import('discord.js').APIApplicationCommandInteractionData} data
 * @param {string} name
 */
function optBool(data, name) {
  const o = data.options?.find((x) => x.name === name);
  if (!o || o.type !== 5) return null;
  return Boolean(o.value);
}

/**
 * @param {import('discord.js').APIApplicationCommandInteractionData} data
 * @param {string} name
 */
function optInt(data, name) {
  const o = data.options?.find((x) => x.name === name);
  if (!o || o.type !== 4) return null;
  return typeof o.value === 'number' ? o.value : null;
}

/**
 * @param {import('discord.js').APIApplicationCommandInteractionData} data
 * @param {string} name
 */
function optChannelId(data, name) {
  const o = data.options?.find((x) => x.name === name);
  if (!o || o.type !== 7) return null;
  return typeof o.value === 'string' ? o.value : null;
}

/**
 * @param {REST} rest
 * @param {string} applicationId
 * @param {string} interactionToken
 * @param {{ content: string; components?: import('discord.js').APIActionRowComponent[] }} body
 */
async function editOriginalInteraction(rest, applicationId, interactionToken, body) {
  await rest.patch(Routes.webhookMessage(applicationId, interactionToken, '@original'), {
    body,
  });
}

/**
 * @param {REST} rest
 * @param {import('discord.js').APIInteraction} interaction
 * @param {import('./guildStore.js').GuildStore} store
 * @returns {Promise<{ json: import('discord.js').APIInteractionResponse } | { deferEphemeral: true; then: () => Promise<void> }>}
 */
export async function buildInteractionResponse(rest, interaction, store) {
  if (interaction.type === InteractionType.Ping) {
    return { json: { type: InteractionResponseType.Pong } };
  }

  if (interaction.type === InteractionType.MessageComponent) {
    const guildId = interaction.guild_id;
    if (!guildId) {
      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: 'Guild-only.', flags: MessageFlags.Ephemeral },
        },
      };
    }

    const data = interaction.data;
    if (!data || !('custom_id' in data)) {
      return { json: { type: InteractionResponseType.Pong } };
    }
    const customId = String(data.custom_id || '');
    const [kind, daysStr, userId] = customId.split(':');
    if (kind !== 'catchup_confirm') {
      return { json: { type: InteractionResponseType.Pong } };
    }

    const user = interaction.member?.user ?? interaction.user;
    if (userId && user?.id !== userId) {
      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: 'This confirmation button belongs to someone else. Run `/catchup` yourself.',
            flags: MessageFlags.Ephemeral,
          },
        },
      };
    }

    const channelId = interaction.channel_id;
    if (!channelId) {
      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: 'Missing channel.', flags: MessageFlags.Ephemeral },
        },
      };
    }

    /** @type {{ type?: number }} */
    const ch = /** @type {unknown} */ (await rest.get(Routes.channel(channelId)));
    const chType = Number(ch.type);
    if (chType !== ChannelType.GuildText && chType !== ChannelType.GuildAnnouncement) {
      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: 'Run `/catchup` in the Raider.IO feed channel (text/announcement channel).',
            flags: MessageFlags.Ephemeral,
          },
        },
      };
    }

    const days = Math.max(1, Math.min(365, Number(daysStr || 0) || 7));
    const appId = interaction.application_id;
    const token = interaction.token;
    const alwaysPingUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
    let lastEditAt = 0;

    return {
      deferEphemeral: true,
      then: async () => {
        try {
          const res = await catchupExecuteRest(rest, channelId, guildId, store, {
            days,
            alwaysPingUserId,
            onProgress: async (p) => {
              if (Date.now() - lastEditAt < 5000) return;
              lastEditAt = Date.now();
              const seconds = Math.round(p.runningForMs / 1000);
              await editOriginalInteraction(rest, appId, token, {
                content: [
                  `Channel: <#${channelId}>`,
                  `Days: ${days}`,
                  `Cutoff: ${p.cutoff.toISOString()}`,
                  `Running: ${seconds}s`,
                  `Scanned: ${p.scanned} (in range: ${p.inRange})`,
                  `Already threaded (skipped): ${p.alreadyThreaded}`,
                  `Attempted handler calls: ${p.attempted}`,
                  '',
                  '(working...)',
                ]
                  .join('\n')
                  .slice(0, 2000),
              }).catch(() => {});
            },
          });

          await editOriginalInteraction(rest, appId, token, {
            content: [
              `Channel: <#${channelId}>`,
              `Days: ${days}`,
              `Cutoff: ${res.cutoff.toISOString()}`,
              `Scanned: ${res.scanned} (in range: ${res.inRange})`,
              `Already threaded (skipped): ${res.alreadyThreaded}`,
              `Attempted handler calls: ${res.attempted}`,
              `Stop: ${res.stopReason}`,
            ]
              .join('\n')
              .slice(0, 2000),
            components: [],
          });
        } catch (e) {
          console.error(e);
          const msg = formatInteractionError(e);
          await editOriginalInteraction(rest, appId, token, {
            content: `Error: ${msg}`.slice(0, 2000),
            components: [],
          }).catch(() => {});
        }
      },
    };
  }

  if (interaction.type !== InteractionType.ApplicationCommand || !interaction.data) {
    return { json: { type: InteractionResponseType.Pong } };
  }

  const data = interaction.data;
  if (data.type !== 1) {
    return { json: { type: InteractionResponseType.Pong } };
  }

  const guildId = interaction.guild_id;
  if (!guildId) {
    return {
      json: {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: 'Guild-only.', flags: MessageFlags.Ephemeral },
      },
    };
  }

  const commandName = data.name;

  try {
    if (commandName === 'setup') {
      const guildName = optString(data, 'guild_name');
      const officerRoleId = optString(data, 'officer_role_id');
      const detectGuildCyrillic = optBool(data, 'detect_guild_cyrillic');
      const feedChannelId = optChannelId(data, 'feed_channel');
      /** @type {{ wow_guild_name?: string | null; officer_role_id?: string | null; detect_guild_cyrillic?: boolean | null; feed_channel_id?: string | null }} */
      const patch = {};
      if (guildName !== null) patch.wow_guild_name = guildName;
      if (officerRoleId !== null) patch.officer_role_id = officerRoleId;
      if (detectGuildCyrillic !== null) patch.detect_guild_cyrillic = detectGuildCyrillic;
      if (feedChannelId !== null) patch.feed_channel_id = feedChannelId;
      const s = await store.upsertSettings(guildId, patch);
      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: [
              `Guild Name: ${s.wow_guild_name ?? '—'}`,
              `Officer Role ID: ${s.officer_role_id ?? '—'}`,
              `Detect guild Cyrillic: ${s.detect_guild_cyrillic ? 'true' : 'false'}`,
              `Feed channel (cron): ${s.feed_channel_id ? `<#${s.feed_channel_id}>` : '—'}`,
            ].join('\n'),
            flags: MessageFlags.Ephemeral,
          },
        },
      };
    }

    if (commandName === 'info') {
      const s = await store.getSettings(guildId);
      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: [
              `**WoW guild (tracked):** ${s?.wow_guild_name ?? '—'}`,
              `**Officer role ID:** ${s?.officer_role_id ?? '—'}`,
              `**Detect guild Cyrillic:** ${s?.detect_guild_cyrillic ? 'true' : 'false'}`,
              `**Feed channel (cron):** ${s?.feed_channel_id ? `<#${s.feed_channel_id}>` : '—'}`,
            ].join('\n'),
            flags: MessageFlags.Ephemeral,
          },
        },
      };
    }

    if (commandName === 'catchup') {
      const channelId = interaction.channel_id;
      if (!channelId) {
        return {
          json: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Missing channel.', flags: MessageFlags.Ephemeral },
          },
        };
      }

      /** @type {{ type?: number }} */
      const ch = /** @type {unknown} */ (await rest.get(Routes.channel(channelId)));
      const chType = Number(ch.type);
      if (chType !== ChannelType.GuildText && chType !== ChannelType.GuildAnnouncement) {
        return {
          json: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: 'Run `/catchup` in the Raider.IO feed channel (text/announcement channel).',
              flags: MessageFlags.Ephemeral,
            },
          },
        };
      }

      const days = Math.max(1, Math.min(365, optInt(data, 'days') ?? 7));
      const user = interaction.member?.user ?? interaction.user;
      if (!user?.id) {
        return {
          json: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Missing user.', flags: MessageFlags.Ephemeral },
          },
        };
      }

      const alwaysPingUserId = process.env.BOT_DEBUG_USER_ID?.trim() || undefined;
      const preview = await catchupPreviewRest(rest, channelId, guildId, { days, alwaysPingUserId });

      const row = {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: 'Confirm',
            custom_id: `catchup_confirm:${days}:${user.id}`,
          },
        ],
      };

      return {
        json: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: [
              `Channel: <#${channelId}>`,
              `Days: ${days}`,
              `Cutoff: ${preview.cutoff.toISOString()}`,
              `Scanned: ${preview.scanned} (in range: ${preview.inRange})`,
              `Already threaded (will be skipped): ${preview.alreadyThreaded}`,
              `Candidates (unthreaded Raider.IO posts): ${preview.candidates}`,
              `Stop: ${preview.stopReason}`,
              '',
              'Press **Confirm** to create missing alert threads by running the normal detection procedure.',
            ]
              .join('\n')
              .slice(0, 2000),
            flags: MessageFlags.Ephemeral,
            components: [row],
          },
        },
      };
    }
  } catch (e) {
    console.error(e);
    const msg = formatInteractionError(e);
    return {
      json: {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: `Error: ${msg}`.slice(0, 2000), flags: MessageFlags.Ephemeral },
      },
    };
  }

  return { json: { type: InteractionResponseType.Pong } };
}
