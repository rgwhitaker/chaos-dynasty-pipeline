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
- Bot currently includes placeholders for slash command and button interaction flows.

## Near-term roadmap

1. Interactive ready-status command flow and persistence
2. Screenshot ingestion + OCR extraction pipeline
3. Week advancement orchestration
4. AI dynasty newspaper generation and publishing
