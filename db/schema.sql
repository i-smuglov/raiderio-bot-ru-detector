-- Apply once on Railway Postgres (Query tab, or `psql $DATABASE_URL -f db/schema.sql`)

create table if not exists discord_guild_settings (
  discord_guild_id text primary key,
  wow_guild_name text,
  officer_role_id text,
  updated_at timestamptz not null default now()
);


create table if not exists player_strikes (
  discord_guild_id text not null,
  player_name text not null,
  strikes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, player_name)
);
