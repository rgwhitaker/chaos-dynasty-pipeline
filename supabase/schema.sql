-- Chaos Dynasty Pipeline — Ready-to-Advance schema
--
-- Run this in the Supabase SQL editor (or via the Supabase CLI) to create the
-- tables backing the `/ready`, `/status`, and `/advance` Discord commands.
--
-- Design notes:
--  * `teams`             — one row per team in a dynasty.
--  * `dynasty_state`     — one row per dynasty holding the *current* week (a
--                          0-based index into the schedule in `lib/weekSchedule.ts`)
--                          and its deadline. This is the single source of truth for
--                          "what week is it now?", so `/set-week` can jump backwards
--                          or forwards freely.
--  * `week_states`       — legacy per-(dynasty, week) status history. Retained for
--                          backwards compatibility; the current week now lives in
--                          `dynasty_state`.
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
-- Legacy per-(dynasty, week) status history. The *current* week now lives in
-- `dynasty_state` (below); this table is retained for backwards compatibility.
create table if not exists public.week_states (
  dynasty_id text not null default 'default',
  week       integer not null,
  status     text not null default 'READY_CHECK'
    check (status in ('DATA_COLLECTION', 'READY_CHECK', 'ADVANCING', 'COMPLETE')),
  updated_at timestamptz not null default now(),
  primary key (dynasty_id, week)
);

-- Dynasty state ---------------------------------------------------------------
-- One row per dynasty pointing at the current week (a 0-based index into the
-- schedule in `lib/weekSchedule.ts`) and its deadline. Using an explicit pointer
-- (instead of "max week") lets `/set-week` jump to any week, forwards or back.
create table if not exists public.dynasty_state (
  dynasty_id   text primary key default 'default',
  current_week integer not null default 0,
  deadline     timestamptz,
  updated_at   timestamptz not null default now()
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

-- Weekly newspapers -----------------------------------------------------------
-- One row per generated "Weekly Newspaper". `content` holds the structured
-- newspaper (headline, summary, highlights, power poll) as JSON so the shape can
-- evolve without migrations. A dynasty/week can have multiple rows (e.g. a
-- manual regeneration via `/newspaper`); the most recent `generated_at` wins.
create table if not exists public.newspapers (
  id           text primary key,
  dynasty_id   text not null default 'default',
  week         integer not null,
  headline     text not null,
  content      jsonb not null,
  model        text,
  generated_at timestamptz not null default now()
);

create index if not exists newspapers_dynasty_week_idx
  on public.newspapers (dynasty_id, week, generated_at desc);

-- Box scores (from videos) --------------------------------------------------
-- One row per Box Score extracted from an uploaded game video by
-- `/process-video`. The full structured result (team names, scores, quarter
-- scores, stats) is stored in `data` (JSONB) so the shape can evolve without
-- migrations; a few common fields are also promoted to columns for easy
-- querying/joins. `week` is nullable because the uploader may not tag a week.
create table if not exists public.box_scores (
  id           text primary key,
  dynasty_id   text not null default 'default',
  week         integer,
  home_team    text,
  home_score   integer,
  away_team    text,
  away_score   integer,
  data         jsonb not null,
  model        text,
  source_video text,
  created_at   timestamptz not null default now()
);

create index if not exists box_scores_dynasty_week_idx
  on public.box_scores (dynasty_id, week, created_at desc);

-- Bot runtime state ----------------------------------------------------------
-- One row per dynasty holding small pieces of state the Discord bot needs to
-- survive restarts:
--   * `status_channel_id` / `status_message_id` — the single persistent status
--     dashboard message (edited in place instead of reposting each update).
--   * `last_advance_at` — when the week was last advanced, which anchors the
--     recurring reminder window (reminders fire 12h after the last advance).
--   * `last_reminder_at` — when the recurring "not ready" reminder last ran, so
--     the 12h cadence keeps recurring and is preserved across restarts.
create table if not exists public.bot_state (
  dynasty_id             text primary key default 'default',
  status_channel_id      text,
  status_message_id      text,
  last_advance_at        timestamptz,
  last_reminder_at       timestamptz,
  all_ready_notified_week integer,
  updated_at             timestamptz not null default now()
);

-- Backfill for existing databases created before `last_advance_at` was added.
alter table public.bot_state
  add column if not exists last_advance_at timestamptz;

-- Backfill for existing databases created before `all_ready_notified_week` was
-- added. Tracks the week for which commissioners were already pinged that every
-- team is ready, so the ping fires only once per week.
alter table public.bot_state
  add column if not exists all_ready_notified_week integer;

-- Row level security ----------------------------------------------------------
-- The Discord bot talks to Supabase with the service role key, which bypasses
-- RLS. Enabling RLS with no public policies keeps these tables private from the
-- anon/authenticated clients used by the web app.
alter table public.teams enable row level security;
alter table public.week_states enable row level security;
alter table public.dynasty_state enable row level security;
alter table public.team_ready_states enable row level security;
alter table public.newspapers enable row level security;
alter table public.box_scores enable row level security;
alter table public.bot_state enable row level security;
