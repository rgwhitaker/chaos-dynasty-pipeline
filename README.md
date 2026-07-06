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
- `bot/commands/` – slash command modules (`/ready`, `/status`, `/advance`, `/register`, `/set-ready`, `/ping`)
- `bot/store/` – ready-to-advance state store (Supabase-backed, with an in-memory fallback)
- `bot/ui/` – Discord message/embed + button builders
- `lib/types/` – Core domain types
- `lib/supabase/` – Supabase SSR/browser clients + service-role client (`service.ts`)
- `lib/grok/` – Grok API client scaffolding
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
  - `/advance` – advance to the next week when enough teams are ready. Restricted to commissioners (configured role or Manage Server permission).
  - `/register <user> <team>` – link a Discord user to a team, creating the team if it doesn't exist yet. Restricted to commissioners (same permission rule as `/advance`). The `team` option has autocomplete that searches existing teams by name or abbreviation.
  - `/set-ready <user> <ready>` – set another user's team ready status for the current week, even if they never marked ready themselves. Restricted to commissioners (same permission rule as `/advance`). Returns a clear error if the target user isn't linked to a team, and shows an updated ready summary.
  - `/ping` – simple liveness check.
- `bot/store/readyStore.ts` – the `ReadyStore` interface plus the in-memory implementation (`InMemoryReadyStore`) used as a local-dev fallback. `getReadyStore()` selects the Supabase-backed store when credentials are present.
- `bot/store/supabaseReadyStore.ts` – `SupabaseReadyStore`, the persistent implementation of `ReadyStore` backed by Supabase (`teams`, `week_states`, `team_ready_states`).
- `lib/supabase/service.ts` – service-role Supabase client used by the bot (server-side only).
- `bot/ui/readyMessage.ts` – builds the status embed and the **Mark Ready / Mark Not Ready / Refresh** buttons.
- `bot/config.ts` – reads league configuration from the environment.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (enables persistence) | none |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key used by the bot (server-side only) | none |
| `LEAGUE_START_WEEK` | Week the league starts on | `1` |
| `LEAGUE_ADVANCE_THRESHOLD` | Ready teams required to advance, or `ALL` | `ALL` |
| `LEAGUE_DYNASTY_ID` | Dynasty id the bot coordinates | `default` |
| `DISCORD_COMMISSIONER_ROLE_ID` | Role allowed to run `/advance` | Manage Server permission |
| `DISCORD_TEAM_LINKS` | JSON linking Discord users to seeded teams (**in-memory fallback only**) | none |

When `NEXT_PUBLIC_SUPABASE_URL` **and** `SUPABASE_SERVICE_ROLE_KEY` are set,
`getReadyStore()` uses the persistent `SupabaseReadyStore`. Otherwise it falls
back to the in-memory store (state resets on restart) so local development works
with no external dependencies.

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
   creates `teams`, `week_states`, and `team_ready_states` (with RLS enabled).

3. Seed initial teams by running [`supabase/seed.sql`](supabase/seed.sql) the
   same way. It inserts four starter teams and opens Week 1. To link a Discord
   account to a team, set that team's `discord_user_id` (enable Developer Mode →
   right-click a user → **Copy User ID**), e.g.:

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
   - `/status` – see Week 1 with all teams NOT ready.
   - `/ready` – mark your team ready; the status message updates. Or click the **Mark Ready** button.
   - `/advance` – as a commissioner, advance the week once the threshold is met. Ready statuses reset for the new week.

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

## Near-term roadmap

1. ✅ Interactive ready-status command flow (in-memory)
2. ✅ Move ready/week state persistence to Supabase
3. Screenshot ingestion + OCR extraction pipeline
4. AI dynasty newspaper generation and publishing
