import type pg from 'pg';

export type GuildSettings = {
  discord_guild_id: string;
  wow_guild_name: string | null;
  officer_role_id: string | null;
};

export class GuildStore {
  constructor(private readonly pool: pg.Pool) {}

  async getSettings(discordGuildId: string): Promise<GuildSettings | null> {
    const r = await this.pool.query<GuildSettings>(
      `select discord_guild_id, wow_guild_name, officer_role_id
       from discord_guild_settings
       where discord_guild_id = $1`,
      [discordGuildId],
    );
    return r.rows[0] ?? null;
  }

  async upsertSettings(
    discordGuildId: string,
    patch: { wow_guild_name?: string | null; officer_role_id?: string | null },
  ): Promise<GuildSettings> {
    const current = await this.getSettings(discordGuildId);
    const wow_guild_name =
      patch.wow_guild_name !== undefined
        ? patch.wow_guild_name
        : (current?.wow_guild_name ?? null);
    const officer_role_id =
      patch.officer_role_id !== undefined
        ? patch.officer_role_id
        : (current?.officer_role_id ?? null);

    const r = await this.pool.query<GuildSettings>(
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

  async listWhitelistedGuildNames(discordGuildId: string): Promise<string[]> {
    const r = await this.pool.query<{ wow_guild_name: string }>(
      `select wow_guild_name from wow_guild_whitelist where discord_guild_id = $1 order by wow_guild_name`,
      [discordGuildId],
    );
    return r.rows.map((x) => x.wow_guild_name);
  }

  async addWhitelistedGuild(discordGuildId: string, wowGuildName: string): Promise<string[]> {
    await this.pool.query(
      `insert into wow_guild_whitelist (discord_guild_id, wow_guild_name)
       values ($1, $2)
       on conflict (discord_guild_id, wow_guild_name) do nothing`,
      [discordGuildId, wowGuildName],
    );
    return this.listWhitelistedGuildNames(discordGuildId);
  }

  async removeWhitelistedGuild(discordGuildId: string, wowGuildName: string): Promise<string[]> {
    await this.pool.query(
      `delete from wow_guild_whitelist where discord_guild_id = $1 and wow_guild_name = $2`,
      [discordGuildId, wowGuildName],
    );
    return this.listWhitelistedGuildNames(discordGuildId);
  }

  async listWhitelistedPlayers(discordGuildId: string): Promise<string[]> {
    const r = await this.pool.query<{ player_name: string }>(
      `select player_name from player_whitelist where discord_guild_id = $1 order by player_name`,
      [discordGuildId],
    );
    return r.rows.map((x) => x.player_name);
  }

  async addWhitelistedPlayer(discordGuildId: string, playerName: string): Promise<string[]> {
    await this.pool.query(
      `insert into player_whitelist (discord_guild_id, player_name)
       values ($1, $2)
       on conflict (discord_guild_id, player_name) do nothing`,
      [discordGuildId, playerName],
    );
    return this.listWhitelistedPlayers(discordGuildId);
  }

  async removeWhitelistedPlayer(discordGuildId: string, playerName: string): Promise<string[]> {
    await this.pool.query(
      `delete from player_whitelist where discord_guild_id = $1 and player_name = $2`,
      [discordGuildId, playerName],
    );
    return this.listWhitelistedPlayers(discordGuildId);
  }

  async incrementStrike(discordGuildId: string, playerName: string): Promise<number> {
    const r = await this.pool.query<{ strikes: number }>(
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
