import type { LeagueConfig } from "@/lib/types";

/**
 * Default dynasty id used while everything lives in memory. Once we move state
 * into Supabase this will come from the selected/active dynasty row instead.
 */
export const DEFAULT_DYNASTY_ID = "default";

function parseWeek(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    startWeek: parseWeek(process.env.LEAGUE_START_WEEK, 1),
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
