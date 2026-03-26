export class GuildStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /** @param {string} discordGuildId */
  async getSettings(discordGuildId) {
    const r = await this.pool.query(
      `select discord_guild_id, wow_guild_name, officer_role_id
       from discord_guild_settings
       where discord_guild_id = $1`,
      [discordGuildId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * @param {string} discordGuildId
   * @param {{ wow_guild_name?: string | null; officer_role_id?: string | null }} patch
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

    const r = await this.pool.query(
      `insert into discord_guild_settings (discord_guild_id, wow_guild_name, officer_role_id, updated_at)
       values ($1, $2, $3, now())
       on conflict (discord_guild_id) do update set
         wow_guild_name = excluded.wow_guild_name,
         officer_role_id = excluded.officer_role_id,
         updated_at = now()
       returning discord_guild_id, wow_guild_name, officer_role_id`,
      [discordGuildId, wow_guild_name, officer_role_id],
    );
    const row = r.rows[0];
    if (!row) throw new Error('upsertSettings returned no row');
    return row;
  }

  /** @param {string} discordGuildId @param {string} playerName */
  async incrementStrike(discordGuildId, playerName) {
    const r = await this.pool.query(
      `insert into player_strikes (discord_guild_id, player_name, strikes)
       values ($1, $2, 1)
       on conflict (discord_guild_id, player_name)
       do update set
         strikes = player_strikes.strikes + 1,
         updated_at = now()
       returning strikes`,
      [discordGuildId, playerName],
    );
    const row = r.rows[0];
    if (!row) throw new Error('incrementStrike returned no row');
    return row.strikes;
  }
}
