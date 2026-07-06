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
- `bot/commands/` – slash command modules (`/ready`, `/status`, `/advance`, `/ping`)
- `bot/store/` – ready-to-advance state store (in-memory today, Supabase-ready)
- `bot/ui/` – Discord message/embed + button builders
- `lib/types/` – Core domain types
- `lib/supabase/` – Supabase SSR/browser clients
- `lib/grok/` – Grok API client scaffolding
- `components/ui/` – shadcn-style reusable UI components

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

- The bot is initialized from `instrumentation.ts`.
- Set `DISCORD_BOT_ENABLED=true` and provide `DISCORD_BOT_TOKEN` to enable login.
- On startup the bot registers its slash commands **guild-scoped** using
  `DISCORD_APPLICATION_ID` + `DISCORD_GUILD_ID` (guild commands update instantly,
  which is ideal for local testing).

## Ready-to-Advance system

The core weekly coordination flow lives in `bot/`:

- `bot/commands/` – slash commands built with `SlashCommandBuilder`:
  - `/ready [ready:true|false]` – mark **your** team ready (or not ready) for the current week. Only users linked to a team may use it.
  - `/status` – show the current week and which teams are ready / not ready.
  - `/advance` – advance to the next week when enough teams are ready. Restricted to commissioners (configured role or Manage Server permission).
  - `/ping` – simple liveness check.
- `bot/store/readyStore.ts` – an in-memory store (`ReadyStore` interface + `InMemoryReadyStore`) for week state and per-team readiness. It is intentionally async and shaped to mirror the eventual Supabase tables so it can be swapped in later without touching command code.
- `bot/ui/readyMessage.ts` – builds the status embed and the **Mark Ready / Mark Not Ready / Refresh** buttons.
- `bot/config.ts` – reads league configuration from the environment.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `LEAGUE_START_WEEK` | Week the league starts on | `1` |
| `LEAGUE_ADVANCE_THRESHOLD` | Ready teams required to advance, or `ALL` | `ALL` |
| `LEAGUE_DYNASTY_ID` | Dynasty id used while state is in memory | `default` |
| `DISCORD_COMMISSIONER_ROLE_ID` | Role allowed to run `/advance` | Manage Server permission |
| `DISCORD_TEAM_LINKS` | JSON linking Discord users to seeded teams | none |

The store seeds four demo teams: `team-thunder`, `team-reign`, `team-blitz`, `team-surge`.

### Test the ready system locally

1. Create a Discord application + bot, invite it to a test server with the `applications.commands` scope.
2. Copy env and fill in Discord values:

   ```bash
   cp .env.example .env.local
   ```

   Set at least `DISCORD_BOT_ENABLED=true`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`.
3. Link your Discord account to a seeded team so you can mark ready. Find your user id (enable Developer Mode → right-click your name → Copy User ID) and set:

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

> State is in memory only, so it resets when the dev server restarts. Supabase persistence is the next step.

## Near-term roadmap

1. ✅ Interactive ready-status command flow (in-memory)
2. Move ready/week state persistence to Supabase
3. Screenshot ingestion + OCR extraction pipeline
4. AI dynasty newspaper generation and publishing
