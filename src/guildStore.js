export class GuildStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /** @param {string} discordGuildId */
  async getSettings(discordGuildId) {
    const r = await this.pool.query(
      `select discord_guild_id, wow_guild_name, officer_role_id, detect_guild_cyrillic
       from discord_guild_settings
       where discord_guild_id = $1`,
      [discordGuildId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * @param {string} discordGuildId
   * @param {{ wow_guild_name?: string | null; officer_role_id?: string | null; detect_guild_cyrillic?: boolean | null }} patch
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

    const r = await this.pool.query(
      `insert into discord_guild_settings (discord_guild_id, wow_guild_name, officer_role_id, detect_guild_cyrillic, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (discord_guild_id) do update set
         wow_guild_name = excluded.wow_guild_name,
         officer_role_id = excluded.officer_role_id,
         detect_guild_cyrillic = excluded.detect_guild_cyrillic,
         updated_at = now()
       returning discord_guild_id, wow_guild_name, officer_role_id, detect_guild_cyrillic`,
      [discordGuildId, wow_guild_name, officer_role_id, detect_guild_cyrillic],
    );
    const row = r.rows[0];
    if (!row) throw new Error('upsertSettings returned no row');
    return row;
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
