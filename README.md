# Chaos Dynasty Pipeline

Chaos Dynasty Pipeline is a **Next.js 15 + TypeScript** application for managing College Football online dynasty leagues.

It combines:
- a web dashboard for commissioners and league members,
- a Discord bot (running inside the same app runtime),
- a screenshot-driven data pipeline,
- Grok (xAI) integrations for OCR/vision and narrative generation.

## Tech stack

- Next.js 15 (App Router) + TypeScript
- discord.js v14
- Supabase (Postgres + Storage)
- Tailwind CSS + shadcn/ui foundations
- xAI Grok API

## Project structure

- `app/` – App Router UI and pages
- `bot/` – Discord bot client and interaction handlers
- `bot/start.ts` – bot startup entry point (config validation, login, graceful shutdown)
- `bot/client.ts` – Discord client factory, command registration, gateway lifecycle logging
- `bot/config.ts` / `bot/logger.ts` – env configuration/validation and structured logging
- `bot/commands/` – slash command modules (`/ready`, `/status`, `/advance`, `/set-week`, `/newspaper`, `/register`, `/set-ready`, `/set-emoji`, `/edit-team`, `/unlink`, `/delete-team`, `/ping`, `/process-video`)
- `bot/store/` – ready-to-advance state store + weekly newspaper store + box score store + bot-state store (Supabase-backed, with an in-memory fallback)
- `bot/newspaper.ts` – Weekly Newspaper orchestration (generate → store → post)
- `bot/boxScore.ts` – `/process-video` orchestration (download → frame extract → vision → store)
- `bot/scheduler.ts` / `bot/reminders.ts` / `bot/statusDashboard.ts` – recurring 12h reminders and the persistent status dashboard (`STATUS_CHANNEL_ID`)
- `bot/ui/` – Discord message/embed + button builders
- `lib/types/` – Core domain types
- `lib/supabase/` – Supabase SSR/browser clients + service-role client (`service.ts`)
- `lib/grok/` – Grok API client scaffolding + Weekly Newspaper generation (`newspaper.ts`) + Box Score vision extraction (`boxScore.ts`)
- `lib/video/` – ffmpeg-based video frame extraction (`frames.ts`)
- `components/ui/` – shadcn-style reusable UI components
- `supabase/` – SQL schema (`schema.sql`) and seed data (`seed.sql`)

## Environment setup

1. Copy the example env file:

```bash
cp .env.example .env.local
```

2. Fill in Supabase, Discord, and xAI values.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Discord bot startup behavior

- The bot is initialized from `instrumentation.ts`, which delegates to
  `bot/start.ts` (the single startup entry point). `bot/start.ts` validates
  configuration, logs the client in, registers commands, and wires up graceful
  shutdown handlers (SIGINT/SIGTERM) so the bot disconnects cleanly on deploys.
- Set `DISCORD_BOT_ENABLED=true` and provide `DISCORD_BOT_TOKEN` to enable login.
  Startup is a safe no-op (with a log line) when disabled or misconfigured, so it
  never crashes the Next.js host process.
- On startup the bot registers its slash commands **guild-scoped** using
  `DISCORD_APPLICATION_ID` + `DISCORD_GUILD_ID` (guild commands update instantly,
  which is ideal for local testing). See `registerGuildCommands` in
  `bot/client.ts` for how to switch to global commands later.
- Gateway lifecycle events (errors, warnings, disconnects, reconnects, resumes)
  and REST rate limits are logged with clear `[Bot]` / `[Warn]` / `[Error]`
  prefixes (see `bot/logger.ts`).
- Because all startup logic lives in `bot/start.ts`, the bot can later be run as
  a **separate process/service** on Railway (its own start command calling
  `startBot()`), independent of the Next.js server.

## Ready-to-Advance system

The core weekly coordination flow lives in `bot/`:

- `bot/commands/` – slash commands built with `SlashCommandBuilder`:
  - `/ready [ready:true|false]` – mark **your** team ready (or not ready) for the current week. Only users linked to a team may use it.
  - `/status` – show the current week and which teams are ready / not ready.
  - `/advance [deadline_hours]` – advance to the next week in the [season schedule](#season-schedule--deadlines) when enough teams are ready. Restricted to commissioners (configured role or Manage Server permission). Automatically calculates the new week's deadline (48h for game weeks, 24h otherwise); pass `deadline_hours` to override it. Posts a public announcement of the new week, its deadline, and when the next advance will happen (e.g. "advance again in ~48 hours"), and refreshes the [persistent status dashboard](#recurring-reminders--persistent-status-dashboard). The Weekly Newspaper is **not** generated automatically — run `/newspaper` for that.
  - `/set-week <week> [deadline_hours]` – jump the dynasty to any week in the schedule (e.g. skip ahead to `Bowl Week 1` or reset to `Preseason`). Restricted to commissioners. The `week` option has autocomplete over the full schedule; the deadline is recalculated from the target week's default duration unless `deadline_hours` overrides it.
  - `/newspaper [week]` – manually (re)generate and post the Weekly Newspaper. Restricted to commissioners. Defaults to the most recently completed week; pass `week` to target the current or any specific week.
  - `/register <user> <team>` – link a Discord user to a team, creating the team if it doesn't exist yet. Restricted to commissioners (same permission rule as `/advance`). The `team` option has autocomplete that searches existing teams by name or abbreviation.
  - `/set-ready <user> <ready>` – set another user's team ready status for the current week, even if they never marked ready themselves. Restricted to commissioners (same permission rule as `/advance`). Returns a clear error if the target user isn't linked to a team, and shows an updated ready summary.
  - `/set-emoji <team> [emoji]` – set (or clear) the emoji shown next to a team's name in `/status` and other messages. Restricted to commissioners. The `team` option has autocomplete; leave `emoji` empty to remove a team's emoji.
  - `/edit-team <team> [name] [abbreviation]` – rename a team and/or change its abbreviation. Restricted to commissioners. The `team` option has autocomplete; provide at least one of `name`/`abbreviation`.
  - `/unlink <user>` – remove a user's link to their current team (without deleting the team). Restricted to commissioners.
  - `/delete-team <team> [force]` – permanently delete a team. Restricted to commissioners. The `team` option has autocomplete. As a safety check, deletion is refused while a user is still linked unless `force:true` is passed.
  - `/ping` – simple liveness check.
  - `/process-video <video> [week]` – extract structured game data (v1: a **Box Score**) from a recorded game video. See [Video processing](#video-processing-process-video) below.
- `bot/store/readyStore.ts` – the `ReadyStore` interface plus the in-memory implementation (`InMemoryReadyStore`) used as a local-dev fallback. `getReadyStore()` selects the Supabase-backed store when credentials are present.
- `bot/store/supabaseReadyStore.ts` – `SupabaseReadyStore`, the persistent implementation of `ReadyStore` backed by Supabase (`teams`, `dynasty_state`, `team_ready_states`).
- `lib/weekSchedule.ts` – the full ordered [season schedule](#season-schedule--deadlines) (week names + `isGameWeek` / `defaultDurationHours` metadata) plus deadline-calculation helpers shared by the store and commands.
- `lib/supabase/service.ts` – service-role Supabase client used by the bot (server-side only).
- `bot/ui/readyMessage.ts` – builds the status embed and the **Mark Ready / Mark Not Ready / Refresh** buttons.
- `bot/config.ts` – reads league configuration from the environment.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (enables persistence) | none |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key used by the bot (server-side only) | none |
| `LEAGUE_START_WEEK` | Schedule index a fresh dynasty starts on (0 = Preseason) | `0` |
| `LEAGUE_ADVANCE_THRESHOLD` | Ready teams required to advance, or `ALL` | `ALL` |
| `LEAGUE_DYNASTY_ID` | Dynasty id the bot coordinates | `default` |
| `DISCORD_COMMISSIONER_ROLE_ID` | Role allowed to run `/advance` | Manage Server permission |
| `DISCORD_TEAM_LINKS` | JSON linking Discord users to seeded teams (**in-memory fallback only**) | none |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (web app) | none |
| `XAI_API_KEY` | xAI Grok API key (required to generate newspapers) | none |
| `NEWSPAPER_CHANNEL_ID` | Discord channel id the Weekly Newspaper is posted to | none |
| `NEWSPAPER_IMAGE_URL` | Optional image shown as the newspaper embed thumbnail | none |
| `STATUS_CHANNEL_ID` | Channel for the persistent status dashboard + recurring reminders | none |

When `NEXT_PUBLIC_SUPABASE_URL` **and** `SUPABASE_SERVICE_ROLE_KEY` are set,
`getReadyStore()` uses the persistent `SupabaseReadyStore`. Otherwise it falls
back to the in-memory store (state resets on restart) so local development works
with no external dependencies.

### Season schedule & deadlines

The dynasty runs on a fixed, ordered **season schedule** defined in
[`lib/weekSchedule.ts`](lib/weekSchedule.ts). Each week carries metadata used to
drive deadlines:

- `is_game_week` (`isGameWeek` in code) – `true` for weeks where games are played.
- `default_duration_hours` (`defaultDurationHours` in code) – the default deadline
  window: **48h** for game weeks, **24h** for non-game weeks.

The full schedule, in order, is:

| # | Week | Game week? | Default deadline |
| --- | --- | --- | --- |
| 0 | Preseason | no | 24h |
| 1–16 | Week 0 … Week 15 | yes | 48h |
| 17 | Conference Championships | yes | 48h |
| 18–20 | Bowl Week 1 … Bowl Week 3 | yes | 48h |
| 21 | National Championship | yes | 48h |
| 22 | End of Season Recap | no | 24h |
| 23 | Players Leaving | no | 24h |
| 24–27 | Offseason Recruiting Week 1 … 4 | no | 24h |
| 28 | National Signing Day | no | 24h |
| 29 | Training Results | no | 24h |
| 30 | Offseason | no | 24h |

The **current week and its deadline** are stored per dynasty in the
`dynasty_state` table (Supabase) or in memory for local dev. A week's position in
the schedule (its 0-based index above) is the stable identifier used for
readiness, so changing weeks automatically starts every team as NOT ready.

**Deadline calculation & overrides**

- On `/advance`, the bot looks at the **next** week and sets its deadline to
  `now + default_duration_hours` (48h if the next week is a game week, otherwise
  24h). Pass `deadline_hours:<n>` to override — e.g. `/advance deadline_hours:24`
  forces a 24h window even on a game week.
- `/set-week week:<name>` jumps straight to any week and recalculates its deadline
  from that week's default duration; `deadline_hours:<n>` overrides it the same
  way.
- The new week and its deadline are announced publicly in the channel. Deadlines
  render as native Discord timestamps, so every member sees them in their own
  timezone with a relative "in N hours" hint.
- `/status`, `/ready`, and `/set-ready` all show the current week name and its
  deadline in the ready-check embed.

**Validation**

- `/advance` refuses to move past the last week of the schedule (Offseason) and
  explains that there is nowhere left to advance to.
- `/set-week` rejects any week name that isn't in the schedule (use the
  autocomplete suggestions to pick a valid week).

> `LEAGUE_START_WEEK` is interpreted as a 0-based index into this schedule and
> defaults to `0` (Preseason). It only sets the week a **fresh** dynasty starts
> on; after that, the current week is persisted.

### Recurring reminders & persistent status dashboard

When `STATUS_CHANNEL_ID` is set to a channel the bot can post in, two background
features come online (both driven by `bot/scheduler.ts`, which starts once the
gateway connection is ready):

**Recurring reminders (every 12 hours)**

- Every 12 hours the bot posts a single reminder to `STATUS_CHANNEL_ID` that
  `@`-mentions only the teams still **not ready** for the current week, along with
  the week name and deadline.
- It never spams: if every linked team is already ready, the reminder is skipped
  entirely, and only not-ready owners are pinged (via scoped `allowedMentions`).
- The cadence is **resilient across restarts**. The last reminder time is
  persisted in the `bot_state` table, and a lightweight scheduler tick (every 30
  minutes) compares against it — so a redeploy in the middle of the window
  resumes the schedule instead of resetting it. On a brand-new dynasty the first
  run only records a baseline, so a fresh deploy never immediately pings everyone.
  (With the in-memory fallback — no Supabase — the cadence resets on restart.)

**Persistent status dashboard**

- The bot maintains **one fixed message** in `STATUS_CHANNEL_ID` that acts as a
  live dashboard, editing that same message in place instead of reposting.
- It shows the current **week name**, the **time remaining** until the deadline
  (as a native Discord timestamp, so the countdown updates on its own in every
  viewer's client), and the **ready vs. not-ready** teams with ✅ / ⛔ markers.
- The message id is stored in `bot_state` (`status_message_id`), so the same
  message is re-edited across restarts. If it is deleted, the bot notices and
  reposts a fresh one on the next update.
- The dashboard refreshes automatically whenever someone uses `/ready`,
  `/set-ready`, or the ready buttons; when the week advances (`/advance`) or is
  set (`/set-week`); when a reminder runs; and on startup.

When `STATUS_CHANNEL_ID` is **unset**, the dashboard is not maintained and the
recurring reminders are skipped (a warning is logged) — everything else works as
before.

### Supabase setup

1. Create a Supabase project and copy its URL, anon key, and **service role**
   key into `.env.local`:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

   > The service role key bypasses row level security. Keep it server-side only —
   > never expose it to the browser or commit it.

2. Create the tables. In the Supabase dashboard open **SQL Editor**, paste the
   contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This
   creates `teams`, `dynasty_state`, `week_states`, `team_ready_states`,
   `newspapers`, `box_scores`, and `bot_state` (with RLS enabled).

3. Seed initial teams by running [`supabase/seed.sql`](supabase/seed.sql) the
   same way. It inserts starter teams and opens the dynasty on Preseason. To link
   a Discord account to a team, set that team's `discord_user_id` (enable
   Developer Mode → right-click a user → **Copy User ID**), e.g.:

   ```sql
   update public.teams set discord_user_id = 'YOUR_USER_ID' where id = 'team-thunder';
   ```

Both files are idempotent, so they are safe to re-run.

The seed provides four demo teams: `team-thunder`, `team-reign`, `team-blitz`, `team-surge`.

### Test the ready system locally

1. Create a Discord application + bot, invite it to a test server with the `applications.commands` scope.
2. Copy env and fill in Discord values:

   ```bash
   cp .env.example .env.local
   ```

   Set at least `DISCORD_BOT_ENABLED=true`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`.
3. Link your Discord account to a team so you can mark ready:
   - **With Supabase:** set the team's `discord_user_id` (see step 3 of *Supabase setup* above).
   - **Without Supabase (in-memory):** find your user id (enable Developer Mode → right-click your name → Copy User ID) and set:

     ```bash
     DISCORD_TEAM_LINKS=[{"discordUserId":"YOUR_USER_ID","teamId":"team-thunder"}]
     ```

   Optionally lower the bar for a solo test with `LEAGUE_ADVANCE_THRESHOLD=1`.
4. Start the app (this also starts the bot and registers the guild commands):

   ```bash
   npm run dev
   ```

5. In your server, try the flow:
   - `/status` – see the current week (Preseason on a fresh dynasty) with all teams NOT ready.
   - `/ready` – mark your team ready; the status message updates. Or click the **Mark Ready** button.
   - `/advance` – as a commissioner, advance the week once the threshold is met. Ready statuses reset for the new week and its deadline is announced.

> With Supabase configured, state persists across restarts. Without it, the
> in-memory fallback resets when the dev server restarts.

### Registering users to teams

Commissioners link Discord users to teams with `/register` instead of editing
`discord_user_id` by hand. Only users with the commissioner role
(`DISCORD_COMMISSIONER_ROLE_ID`) or the Manage Server permission can run it.

```text
/register user:@Alex team:Oregon State Beavers
```

- **Existing team:** matched case-insensitively by name **or** abbreviation, so
  `/register user:@Alex team:ORST` links to the same "Oregon State Beavers" team.
  Start typing in the `team` field to pick from autocomplete suggestions
  (existing teams matching what you've typed, up to 25 results).
- **New team:** if no team matches, one is created automatically. A short
  abbreviation is generated from the name when an obvious one isn't provided
  (initials for multi-word names, e.g. "Oregon State Beavers" → `OSB`; the first
  few letters for single-word names, e.g. "Liberty" → `LIBE`).
- **Re-assigning a user:** if the user was already linked to a different team,
  they are removed from it first so each user is only ever on one team. The reply
  notes the move, e.g. *"Registered @Alex to **Liberty Flames** (moved from
  **Oregon State Beavers**)."*
- **Edge cases:** a user already on the requested team gets a friendly no-op
  message, and team names longer than 100 characters are rejected.

Replies are ephemeral so registration actions stay out of the public channel.

### Team emojis

Give each team an emoji that shows up next to its name in `/status` and the other
ready-check messages. Commissioners set it with `/set-emoji`:

```text
/set-emoji team:Oregon State Beavers emoji:🦫
```

- **Team selection** uses autocomplete (search existing teams by name or
  abbreviation).
- **Emoji** may be a standard Unicode emoji or a Discord custom emoji. Custom
  emojis only render in embeds when the bot shares a server that has them, so
  prefer Unicode emojis for cross-server reliability.
- **Removing an emoji:** run `/set-emoji` for the team and leave the `emoji`
  option empty.

The `emoji` value is stored on the `teams` table (`emoji` column). Databases
created before this feature are upgraded automatically when you re-run
[`supabase/schema.sql`](supabase/schema.sql) (it adds the column with
`alter table ... add column if not exists`).

### Weekly Newspaper

After a week ends, a commissioner generates a **Weekly Newspaper** for the week
that just ended and posts it to a dedicated Discord channel with `/newspaper`. It
uses the xAI **Grok** API to write an entertaining, chaos-flavored recap.

> The newspaper is **not** generated automatically on `/advance` — it is a
> manual, commissioner-triggered command (`/newspaper`) so a slow or failed Grok
> call never blocks the core advance flow.

Each newspaper includes:

- a catchy **headline** for the week,
- a short **overall summary**,
- **highlights / storylines** from the week, and
- a **Chaos Power Poll** ranking the teams (when team data is available).

The result is rendered as a rich Discord **embed** (title, summary description,
highlight and power-poll fields, footer with the model used) and is also stored
in Supabase for history.

### How it works

- `lib/grok/newspaper.ts` – builds the prompt from the current league/team data,
  calls Grok, and parses the JSON response into structured `NewspaperContent`
  (headline, summary, highlights, power poll). Parsing is defensive: it strips
  stray Markdown code fences, drops malformed power-poll rows, and throws a clear
  error if the headline/summary are missing.
- `bot/store/newspaperStore.ts` – persists newspapers to the `newspapers` table
  (`SupabaseNewspaperStore`) with an in-memory fallback (`InMemoryNewspaperStore`)
  for local development, selected by `getNewspaperStore()`.
- `bot/ui/newspaperMessage.ts` – builds the Discord embed.
- `bot/newspaper.ts` – orchestration: generate → store → post to the channel in
  `NEWSPAPER_CHANNEL_ID`. Posting is best-effort — a missing or invalid channel is
  logged as a warning and never breaks the `/newspaper` flow.

### Configuration

- Set `XAI_API_KEY` so the bot can call Grok (`XAI_MODEL_TEXT` selects the model,
  default `grok-3-latest`).
- Set `NEWSPAPER_CHANNEL_ID` to the channel where newspapers should be posted.
  When unset, the newspaper is still generated and stored, but not posted.
- Optionally set `NEWSPAPER_IMAGE_URL` (e.g. your dynasty logo) to show a
  thumbnail on the embed.

Run [`supabase/schema.sql`](supabase/schema.sql) to create the `newspapers`
table (it is idempotent, so re-running it on an existing database just adds the
new table).

### Manual generation

Commissioners generate and post (or re-post) a newspaper at any time with
`/newspaper`:

```text
/newspaper                 # most recently completed week
/newspaper week:5          # a specific week
```

Each run stores a new row (the latest `generated_at` for a week wins), so it is
safe to regenerate if you tweak prompts or want a fresh take.

## Video processing (`/process-video`)

Turn a recorded game video (e.g. an Xbox clip) into structured game data. v1
focuses on the **Box Score** screen.

```text
/process-video video:<attach an MP4/MOV> week:5
```

- Attach the recording to the `video` option. `week` is optional and just tags
  the stored result.
- The reply is deferred (processing takes a few seconds), then updated with a
  **Box Score** embed summarizing what was extracted.

### What it extracts

For each team (home and away) the pipeline tries to read:

- **Team name** and **final score**
- **Quarter-by-quarter scores** (when visible)
- **Headline team stats** (e.g. total yards, turnovers, passing/rushing yards)
  when clearly legible

Only values that are actually readable in the frames are recorded — anything the
model can't see is simply left out rather than guessed.

### How it works

1. **Download** – the attachment is downloaded to a temp file (rejected if it is
   empty or larger than 100 MB).
2. **Frame extraction** (`lib/video/frames.ts`) – ffmpeg samples evenly spaced
   frames (about one every 3 seconds, capped at 8) so vision usage stays bounded.
3. **Vision** (`lib/grok/boxScore.ts`) – the frames are sent to the Grok vision
   model with a prompt that asks for a strict Box Score JSON object. Parsing is
   defensive (strips code fences, coerces types, drops malformed fields).
4. **Store** (`bot/store/boxScoreStore.ts`) – the result is saved to the
   `box_scores` table (JSONB `data` plus a few promoted columns) with an
   in-memory fallback for local development.
5. **Reply** (`bot/ui/boxScoreMessage.ts`) – a summary embed is posted back.

Orchestration lives in `bot/boxScore.ts`; all temp files are cleaned up even on
failure, and errors (bad video, vision failure, oversized upload) surface as
clear ⚠️ messages.

### Configuration

- Set `XAI_API_KEY` (and optionally `XAI_MODEL_VISION`, default
  `grok-2-vision-latest`) so the bot can call Grok Vision.
- **ffmpeg / ffprobe** are provided by the `ffmpeg-static` / `ffprobe-static`
  packages, so no system install is required. To use a system build instead
  (e.g. on a host that ships its own), set `FFMPEG_PATH` and `FFPROBE_PATH`.
- Run [`supabase/schema.sql`](supabase/schema.sql) to create the `box_scores`
  table (idempotent — re-running just adds the new table).

## Managing teams and links

Commissioners have a few more tools for keeping the roster tidy. All are
restricted to the commissioner role (`DISCORD_COMMISSIONER_ROLE_ID`) or the
Manage Server permission, reply ephemerally, and use autocomplete for team
selection where relevant.

- `/edit-team team:<team> [name:<new name>] [abbreviation:<ABBR>]` – rename a
  team and/or change its abbreviation. Provide at least one field to change.
- `/unlink user:@Alex` – remove a user's link to their current team without
  deleting the team. Returns a friendly no-op message if the user isn't linked.
- `/delete-team team:<team> [force:true]` – permanently delete a team. If a user
  is still linked, the command refuses and suggests running `/unlink` first;
  pass `force:true` to delete anyway. Deleting a team also removes its readiness
  history.

## Near-term roadmap

1. ✅ Interactive ready-status command flow (in-memory)
2. ✅ Move ready/week state persistence to Supabase
3. ✅ Full custom season schedule + commissioner deadline controls (`/advance` overrides, `/set-week`)
4. Screenshot ingestion + OCR extraction pipeline
5. ✅ AI dynasty newspaper generation and publishing (`/newspaper`)
6. ✅ Video → Box Score extraction (`/process-video`, ffmpeg + Grok Vision)
7. ✅ Recurring deadline reminders + a persistent status dashboard (Phase 2, `STATUS_CHANNEL_ID`)
