-- Apply once on Railway Postgres (Query tab, or `psql $DATABASE_URL -f db/schema.sql`)

create table if not exists discord_guild_settings (
  discord_guild_id text primary key,
  wow_guild_name text,
  officer_role_id text,
  detect_guild_cyrillic boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Migration: add detect_guild_cyrillic to existing installs.
alter table discord_guild_settings
  add column if not exists detect_guild_cyrillic boolean not null default false;

-- HTTP / cron polling: which channel to scan and last processed message id (snowflake).
alter table discord_guild_settings
  add column if not exists feed_channel_id text;
alter table discord_guild_settings
  add column if not exists last_polled_message_id text;


create table if not exists player_strikes (
  player_name text not null,
  strikes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (player_name)
);

-- Migration: legacy `player_strikes` used (discord_guild_id, player_name) as PK.
-- We aggregate strikes across guilds and then make strikes global per player_name.
do $$
begin
  if to_regclass('public.player_strikes') is null then
    return;
  end if;

  -- Snapshot current data (works for both legacy and already-migrated shapes).
  create temp table _player_strikes_agg as
    select
      player_name,
      sum(strikes)::integer as strikes,
      max(updated_at) as updated_at
    from player_strikes
    group by player_name;

  -- Rebuild table shape and PK.
  alter table player_strikes drop constraint if exists player_strikes_pkey;
  alter table player_strikes drop column if exists discord_guild_id;
  truncate table player_strikes;

  insert into player_strikes (player_name, strikes, updated_at)
  select player_name, strikes, updated_at
  from _player_strikes_agg;

  alter table player_strikes add constraint player_strikes_pkey primary key (player_name);
end $$;
