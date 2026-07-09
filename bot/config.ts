import type { LeagueConfig } from "@/lib/types";

/**
 * Default dynasty id used when `LEAGUE_DYNASTY_ID` is not set. This scopes the
 * Supabase rows (teams, week_states, team_ready_states) the bot coordinates.
 */
export const DEFAULT_DYNASTY_ID = "default";

/**
 * Parse the configured start week. The value is interpreted as a 0-based index
 * into the dynasty schedule (see `lib/weekSchedule.ts`), so `0` is the first week
 * (Preseason). Non-numeric/negative input falls back to the schedule start.
 */
function parseWeek(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolve the advance threshold. Accepts:
 *  - "ALL" (case-insensitive) or empty -> null (every team must be ready)
 *  - a positive integer -> that many ready teams are required
 */
function parseThreshold(value: string | undefined): number | null {
  if (!value || value.trim().toUpperCase() === "ALL") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Build the league configuration from environment variables. Kept in a single
 * place so the ready store and slash commands share one source of truth.
 */
export function getLeagueConfig(): LeagueConfig {
  return {
    dynastyId: process.env.LEAGUE_DYNASTY_ID?.trim() || DEFAULT_DYNASTY_ID,
    startWeek: parseWeek(process.env.LEAGUE_START_WEEK, 0),
    advanceThreshold: parseThreshold(process.env.LEAGUE_ADVANCE_THRESHOLD),
    commissionerRoleId: process.env.DISCORD_COMMISSIONER_ROLE_ID?.trim() || undefined,
  };
}

/** The guild the bot registers its commands against (guild-scoped for now). */
export function getGuildId(): string | undefined {
  return process.env.DISCORD_GUILD_ID?.trim() || undefined;
}

/** The Discord application id, required to register slash commands. */
export function getApplicationId(): string | undefined {
  return process.env.DISCORD_APPLICATION_ID?.trim() || undefined;
}

/** The Discord bot token used to log in to the gateway. */
export function getBotToken(): string | undefined {
  return process.env.DISCORD_BOT_TOKEN?.trim() || undefined;
}

/**
 * The Discord channel id where the Weekly Newspaper is posted. When unset, the
 * newspaper is generated and stored but not posted to a channel (a warning is
 * logged). Set `NEWSPAPER_CHANNEL_ID` to enable posting.
 */
export function getNewspaperChannelId(): string | undefined {
  return process.env.NEWSPAPER_CHANNEL_ID?.trim() || undefined;
}

/**
 * The Discord channel id that hosts the persistent status dashboard and receives
 * the recurring "not ready" reminders. When unset, the dashboard is not
 * maintained and reminders are skipped (a warning is logged). Set
 * `STATUS_CHANNEL_ID` to enable both.
 */
export function getStatusChannelId(): string | undefined {
  return process.env.STATUS_CHANNEL_ID?.trim() || undefined;
}

/**
 * Whether the bot should attempt to start/log in. Defaults to disabled so the
 * Next.js app can run (build, preview, tests) without Discord credentials.
 */
export function isBotEnabled(): boolean {
  return process.env.DISCORD_BOT_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Resolved, validated bot configuration.
 *
 * `errors` lists any missing *required* values that prevent login; `warnings`
 * lists missing *optional* values that only degrade functionality (for example
 * a missing application/guild id means commands can't be registered, but the
 * bot can still log in). Callers should refuse to start when `errors` is
 * non-empty and surface `warnings` for visibility.
 */
export interface BotConfig {
  enabled: boolean;
  token?: string;
  applicationId?: string;
  guildId?: string;
  errors: string[];
  warnings: string[];
}

/**
 * Read and validate the Discord bot configuration from the environment in one
 * place, so startup logic doesn't have to re-check individual variables.
 */
export function getBotConfig(): BotConfig {
  const enabled = isBotEnabled();
  const token = getBotToken();
  const applicationId = getApplicationId();
  const guildId = getGuildId();

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!token) {
    errors.push("DISCORD_BOT_TOKEN is required to log in.");
  }

  // Command registration is guild-scoped for now and needs both ids. Missing
  // ids are non-fatal: the bot can still log in and respond to existing
  // (already-registered) commands.
  if (!applicationId) {
    warnings.push(
      "DISCORD_APPLICATION_ID is missing; slash commands will not be registered.",
    );
  }
  if (!guildId) {
    warnings.push(
      "DISCORD_GUILD_ID is missing; guild-scoped slash commands will not be registered.",
    );
  }

  return { enabled, token, applicationId, guildId, errors, warnings };
}
