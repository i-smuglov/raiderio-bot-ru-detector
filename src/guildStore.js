export class GuildStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /** @param {string} discordGuildId */
  async getSettings(discordGuildId) {
    const r = await this.pool.query(
      `select discord_guild_id, wow_guild_name, officer_role_id, detect_guild_cyrillic,
              feed_channel_id, last_polled_message_id
       from discord_guild_settings
       where discord_guild_id = $1`,
      [discordGuildId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * @param {string} discordGuildId
   * @param {{
   *   wow_guild_name?: string | null;
   *   officer_role_id?: string | null;
   *   detect_guild_cyrillic?: boolean | null;
   *   feed_channel_id?: string | null;
   * }} patch
   */
  async upsertSettings(discordGuildId, patch) {
    const current = await this.getSettings(discordGuildId);
    const wow_guild_name =
      patch.wow_guild_name !== undefined
        ? patch.wow_guild_name
        : (current?.wow_guild_name ?? null);
    const officer_role_id =
      patch.officer_role_id !== undefined
        ? patch.officer_role_id
        : (current?.officer_role_id ?? null);
    const detect_guild_cyrillic =
      patch.detect_guild_cyrillic !== undefined
        ? (patch.detect_guild_cyrillic ?? false)
        : (current?.detect_guild_cyrillic ?? false);
    const feed_channel_id =
      patch.feed_channel_id !== undefined
        ? patch.feed_channel_id
        : (current?.feed_channel_id ?? null);

    const r = await this.pool.query(
      `insert into discord_guild_settings (discord_guild_id, wow_guild_name, officer_role_id, detect_guild_cyrillic, feed_channel_id, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (discord_guild_id) do update set
         wow_guild_name = excluded.wow_guild_name,
         officer_role_id = excluded.officer_role_id,
         detect_guild_cyrillic = excluded.detect_guild_cyrillic,
         feed_channel_id = excluded.feed_channel_id,
         updated_at = now()
       returning discord_guild_id, wow_guild_name, officer_role_id, detect_guild_cyrillic, feed_channel_id, last_polled_message_id`,
      [discordGuildId, wow_guild_name, officer_role_id, detect_guild_cyrillic, feed_channel_id],
    );
    const row = r.rows[0];
    if (!row) throw new Error('upsertSettings returned no row');
    return row;
  }

  /**
   * Guilds configured for HTTP polling (feed_channel_id set).
   * @returns {Promise<{ discord_guild_id: string; feed_channel_id: string; last_polled_message_id: string | null }[]>}
   */
  async listGuildsWithFeedChannel() {
    const r = await this.pool.query(
      `select discord_guild_id, feed_channel_id, last_polled_message_id
       from discord_guild_settings
       where feed_channel_id is not null and feed_channel_id <> ''`,
    );
    return r.rows;
  }

  /**
   * @param {string} discordGuildId
   * @param {string | null} messageId
   */
  async setLastPolledMessageId(discordGuildId, messageId) {
    await this.pool.query(
      `update discord_guild_settings
       set last_polled_message_id = $2, updated_at = now()
       where discord_guild_id = $1`,
      [discordGuildId, messageId],
    );
  }

  /** @param {string} playerName */
  async incrementStrike(playerName) {
    const r = await this.pool.query(
      `insert into player_strikes (player_name, strikes)
       values ($1, 1)
       on conflict (player_name)
       do update set
         strikes = player_strikes.strikes + 1,
         updated_at = now()
       returning strikes`,
      [playerName],
    );
    const row = r.rows[0];
    if (!row) throw new Error('incrementStrike returned no row');
    return row.strikes;
  }

  /**
   * Increment strikes for multiple players in a single query.
   * Input is expected to be unique per run (no duplicates).
   *
   * @param {string[]} playerNames
   * @returns {Promise<number[]>} strike counts for each input name
   */
  async incrementStrikes(playerNames) {
    if (playerNames.length === 0) return [];

    const r = await this.pool.query(
      `with input as (
         select
           name as player_name,
           ord::int as ord
         from unnest($1::text[]) with ordinality as t(name, ord)
       ),
       upserted as (
         insert into player_strikes (player_name, strikes)
         select player_name, 1
         from input
         on conflict (player_name)
         do update set
           strikes = player_strikes.strikes + 1,
           updated_at = now()
         returning player_name, strikes
       )
       select u.strikes
       from input i
       join upserted u using (player_name)
       order by i.ord`,
      [playerNames],
    );

    return r.rows.map((row) => row?.strikes ?? 0);
  }
}
