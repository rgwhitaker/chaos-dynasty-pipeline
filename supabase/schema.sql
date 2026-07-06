-- Chaos Dynasty Pipeline — Ready-to-Advance schema
--
-- Run this in the Supabase SQL editor (or via the Supabase CLI) to create the
-- tables backing the `/ready`, `/status`, and `/advance` Discord commands.
--
-- Design notes:
--  * `teams`             — one row per team in a dynasty.
--  * `week_states`       — one row per (dynasty, week); the row with the highest
--                          week for a dynasty is the "current" week.
--  * `team_ready_states` — one row per (week, team); a missing row means the
--                          team is NOT ready, so advancing to a new week starts
--                          everyone as not-ready automatically.

-- Teams -----------------------------------------------------------------------
create table if not exists public.teams (
  id              text primary key,
  dynasty_id      text not null default 'default',
  name            text not null,
  abbreviation    text,
  emoji           text,
  discord_user_id text unique,
  created_at      timestamptz not null default now()
);

-- Backfill the emoji column for databases created before it was introduced.
alter table public.teams add column if not exists emoji text;

create index if not exists teams_dynasty_id_idx on public.teams (dynasty_id);

-- Week state ------------------------------------------------------------------
create table if not exists public.week_states (
  dynasty_id text not null default 'default',
  week       integer not null,
  status     text not null default 'READY_CHECK'
    check (status in ('DATA_COLLECTION', 'READY_CHECK', 'ADVANCING', 'COMPLETE')),
  updated_at timestamptz not null default now(),
  primary key (dynasty_id, week)
);

-- Per-team readiness ----------------------------------------------------------
create table if not exists public.team_ready_states (
  week                       integer not null,
  team_id                    text not null references public.teams (id) on delete cascade,
  is_ready                   boolean not null default false,
  updated_by_discord_user_id text,
  updated_at                 timestamptz not null default now(),
  primary key (week, team_id)
);

create index if not exists team_ready_states_team_id_idx
  on public.team_ready_states (team_id);

-- Row level security ----------------------------------------------------------
-- The Discord bot talks to Supabase with the service role key, which bypasses
-- RLS. Enabling RLS with no public policies keeps these tables private from the
-- anon/authenticated clients used by the web app.
alter table public.teams enable row level security;
alter table public.week_states enable row level security;
alter table public.team_ready_states enable row level security;
