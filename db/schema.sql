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


create table if not exists player_strikes (
  player_name text not null,
  strikes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (player_name)
);

-- Migration: rename guild_last_flagged_alert → guild_bot_state and add checked columns.
-- Safe to run multiple times; each step guards itself.
do $$
begin
  -- Rename old table if it exists under the old name.
  if to_regclass('public.guild_last_flagged_alert') is not null
     and to_regclass('public.guild_bot_state') is null then
    alter table guild_last_flagged_alert rename to guild_bot_state;
    alter table guild_bot_state rename column source_channel_id  to flagged_source_channel_id;
    alter table guild_bot_state rename column source_message_id  to flagged_source_message_id;
    alter table guild_bot_state rename column thread_channel_id  to flagged_thread_channel_id;
    alter table guild_bot_state rename column thread_message_id  to flagged_thread_message_id;
    alter table guild_bot_state rename column updated_at         to flagged_at;
  end if;
end $$;

-- Fresh-install path: create the table with all columns in one shot.
create table if not exists guild_bot_state (
  discord_guild_id          text primary key references discord_guild_settings(discord_guild_id) on delete cascade,
  -- last Raider.IO message the bot fully evaluated (clean or flagged)
  checked_channel_id        text,
  checked_message_id        text,
  checked_at                timestamptz,
  -- last message that was flagged and got an alert thread
  flagged_source_channel_id text,
  flagged_source_message_id text,
  flagged_thread_channel_id text,
  flagged_thread_message_id text,
  flagged_at                timestamptz,
  updated_at                timestamptz not null default now()
);

-- Migration: add any columns that are missing on the renamed table.
alter table guild_bot_state add column if not exists checked_channel_id        text;
alter table guild_bot_state add column if not exists checked_message_id        text;
alter table guild_bot_state add column if not exists checked_at                timestamptz;
alter table guild_bot_state add column if not exists flagged_source_channel_id text;
alter table guild_bot_state add column if not exists flagged_source_message_id text;
alter table guild_bot_state add column if not exists flagged_thread_channel_id text;
alter table guild_bot_state add column if not exists flagged_thread_message_id text;
alter table guild_bot_state add column if not exists flagged_at                timestamptz;
alter table guild_bot_state add column if not exists updated_at                timestamptz not null default now();

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
