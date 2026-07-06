import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateTeamInput, ReadyStore } from "@/bot/store/readyStore";
import {
  generateAbbreviation,
  normalizeAbbreviation,
  normalizeTeamName,
  slugifyTeamName,
} from "@/bot/store/teamNaming";
import type {
  AdvanceResult,
  LeagueConfig,
  ReadyStatus,
  ReadySummary,
  ReadySummaryEntry,
  Team,
  TeamReadyState,
  WeekPhase,
  WeekState,
} from "@/lib/types";

/** Table names used by the ready-to-advance system. */
const TABLES = {
  teams: "teams",
  weekStates: "week_states",
  teamReadyStates: "team_ready_states",
} as const;

/** Row shape for the `teams` table. */
interface TeamRow {
  id: string;
  dynasty_id: string;
  name: string;
  abbreviation: string | null;
  discord_user_id: string | null;
}

/** Row shape for the `week_states` table. */
interface WeekStateRow {
  dynasty_id: string;
  week: number;
  status: WeekPhase;
}

/** Row shape for the `team_ready_states` table. */
interface TeamReadyStateRow {
  week: number;
  team_id: string;
  is_ready: boolean;
  updated_at: string;
  updated_by_discord_user_id: string | null;
}

function mapTeam(row: TeamRow, status: ReadyStatus, updatedAt: string): Team {
  return {
    id: row.id,
    dynastyId: row.dynasty_id,
    name: row.name,
    abbreviation: row.abbreviation ?? undefined,
    userId: row.discord_user_id ?? undefined,
    readyStatus: status,
    updatedAt,
  };
}

/**
 * Escape characters that are special inside a PostgREST `ilike` pattern so
 * user-supplied text is matched literally. `%` and `_` are LIKE wildcards, and
 * `,`/`(`/`)` would otherwise break out of the `or(...)` filter expression.
 */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_,()]/g, (char) => `\\${char}`);
}

/**
 * Supabase-backed implementation of {@link ReadyStore}. Persists week state and
 * per-team readiness across restarts. Readiness is keyed by `(week, team_id)` so
 * advancing to a new week naturally starts every team as NOT_READY again.
 */
export class SupabaseReadyStore implements ReadyStore {
  private readonly config: LeagueConfig;
  private readonly client: SupabaseClient;

  constructor(config: LeagueConfig, client: SupabaseClient) {
    this.config = config;
    this.client = client;
  }

  async getWeekState(): Promise<WeekState> {
  const { data, error } = await this.client
    .from(TABLES.weekStates)
    .select("dynasty_id, week, status")
    .eq("dynasty_id", this.config.dynastyId)
    .order("week", { ascending: false })
    .limit(1)
    .maybeSingle<WeekStateRow>();

  if (error) {
    throw new Error(`Failed to load week state: ${error.message}`);
  }

  if (!data) {
    // No week has been initialized yet — create the starting week.
    return this.upsertWeekState(this.config.startWeek, "READY_CHECK");
  }

  return this.mapWeekState(data);
}

  async setCurrentWeek(weekNumber: number): Promise<WeekState> {
    return this.upsertWeekState(weekNumber, "READY_CHECK");
  }

  async listTeams(): Promise<Team[]> {
    const weekState = await this.getWeekState();
    const teams = await this.fetchTeamRows();
    const readyMap = await this.fetchReadyMap(weekState.weekNumber);

    return teams.map((row) => {
      const ready = readyMap.get(row.id);
      return mapTeam(
        row,
        ready?.is_ready ? "READY" : "NOT_READY",
        ready?.updated_at ?? weekState.advancedAt ?? new Date().toISOString(),
      );
    });
  }

  async getTeamById(teamId: string): Promise<Team | undefined> {
    const { data, error } = await this.client
      .from(TABLES.teams)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .eq("dynasty_id", this.config.dynastyId)
      .eq("id", teamId)
      .maybeSingle<TeamRow>();

    if (error) {
      throw new Error(`Failed to load team ${teamId}: ${error.message}`);
    }

    return data ? this.hydrateTeam(data) : undefined;
  }

  async getTeamByDiscordUserId(discordUserId: string): Promise<Team | undefined> {
    const { data, error } = await this.client
      .from(TABLES.teams)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .eq("dynasty_id", this.config.dynastyId)
      .eq("discord_user_id", discordUserId)
      .maybeSingle<TeamRow>();

    if (error) {
      throw new Error(`Failed to load team for user ${discordUserId}: ${error.message}`);
    }

    return data ? this.hydrateTeam(data) : undefined;
  }

  async findTeamByNameOrAbbreviation(query: string): Promise<Team | undefined> {
    const needle = query.trim();
    if (!needle) {
      return undefined;
    }

    // Case-insensitive exact match on either name or abbreviation. `ilike`
    // without wildcards behaves as a case-insensitive equality check; the
    // escaping below neutralizes any `%`/`_` the user may have typed.
    const escaped = escapeIlike(needle);
    const { data, error } = await this.client
      .from(TABLES.teams)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .eq("dynasty_id", this.config.dynastyId)
      .or(`name.ilike.${escaped},abbreviation.ilike.${escaped}`)
      .limit(1)
      .maybeSingle<TeamRow>();

    if (error) {
      throw new Error(`Failed to find team "${needle}": ${error.message}`);
    }

    return data ? this.hydrateTeam(data) : undefined;
  }

  async searchTeams(query: string, limit = 25): Promise<Team[]> {
    const needle = query.trim();

    let request = this.client
      .from(TABLES.teams)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .eq("dynasty_id", this.config.dynastyId)
      .order("name", { ascending: true })
      .limit(limit);

    if (needle) {
      const pattern = `%${escapeIlike(needle)}%`;
      request = request.or(`name.ilike.${pattern},abbreviation.ilike.${pattern}`);
    }

    const { data, error } = await request;

    if (error) {
      throw new Error(`Failed to search teams: ${error.message}`);
    }

    const now = new Date().toISOString();
    return ((data as TeamRow[] | null) ?? []).map((row) =>
      mapTeam(row, "NOT_READY", now),
    );
  }

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const name = normalizeTeamName(input.name);
    const abbreviation = input.abbreviation
      ? normalizeAbbreviation(input.abbreviation)
      : generateAbbreviation(name);

    const id = await this.generateTeamId(name);
    const row: Pick<
      TeamRow,
      "id" | "dynasty_id" | "name" | "abbreviation" | "discord_user_id"
    > = {
      id,
      dynasty_id: this.config.dynastyId,
      name,
      abbreviation: abbreviation || null,
      discord_user_id: null,
    };

    const { data, error } = await this.client
      .from(TABLES.teams)
      .insert(row)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .single<TeamRow>();

    if (error) {
      throw new Error(`Failed to create team "${name}": ${error.message}`);
    }

    return mapTeam(data, "NOT_READY", new Date().toISOString());
  }

  async linkTeamToDiscordUser(teamId: string, discordUserId: string): Promise<Team> {
    // Remove the user from any team they were previously linked to. The
    // `discord_user_id` column is UNIQUE, so leaving a stale link would make the
    // update below fail.
    const { error: clearError } = await this.client
      .from(TABLES.teams)
      .update({ discord_user_id: null })
      .eq("dynasty_id", this.config.dynastyId)
      .eq("discord_user_id", discordUserId)
      .neq("id", teamId);

    if (clearError) {
      throw new Error(
        `Failed to unlink user ${discordUserId} from previous team: ${clearError.message}`,
      );
    }

    const { data, error } = await this.client
      .from(TABLES.teams)
      .update({ discord_user_id: discordUserId })
      .eq("dynasty_id", this.config.dynastyId)
      .eq("id", teamId)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .single<TeamRow>();

    if (error) {
      throw new Error(`Failed to link user to team ${teamId}: ${error.message}`);
    }

    return this.hydrateTeam(data);
  }

  /** Build a team id that is unique within the dynasty. */
  private async generateTeamId(name: string): Promise<string> {
    const base = `team-${slugifyTeamName(name)}`;
    let candidate = base;
    let suffix = 2;

    // Cap the loop so a pathological data set can't spin forever; after a few
    // attempts fall back to a random suffix.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const existing = await this.getTeamById(candidate);
      if (!existing) {
        return candidate;
      }
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }

    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async setReadyStatus(
    teamId: string,
    status: ReadyStatus,
    discordUserId?: string,
  ): Promise<TeamReadyState> {
    const team = await this.getTeamById(teamId);
    if (!team) {
      throw new Error(`Unknown team: ${teamId}`);
    }

    const weekState = await this.getWeekState();
    const now = new Date().toISOString();
    const row: TeamReadyStateRow = {
      week: weekState.weekNumber,
      team_id: teamId,
      is_ready: status === "READY",
      updated_at: now,
      updated_by_discord_user_id: discordUserId ?? null,
    };

    const { error } = await this.client
      .from(TABLES.teamReadyStates)
      .upsert(row, { onConflict: "week,team_id" });

    if (error) {
      throw new Error(`Failed to set ready status for ${teamId}: ${error.message}`);
    }

    return {
      teamId,
      weekNumber: weekState.weekNumber,
      status,
      updatedByDiscordUserId: discordUserId,
      updatedAt: now,
    };
  }

  async getReadySummary(): Promise<ReadySummary> {
    const weekState = await this.getWeekState();
    const teams = await this.fetchTeamRows();
    const readyMap = await this.fetchReadyMap(weekState.weekNumber);

    const entries: ReadySummaryEntry[] = teams.map((row) => {
      const ready = readyMap.get(row.id);
      const status: ReadyStatus = ready?.is_ready ? "READY" : "NOT_READY";
      return {
        team: mapTeam(row, status, ready?.updated_at ?? new Date().toISOString()),
        status,
        updatedAt: ready?.updated_at,
        updatedByDiscordUserId: ready?.updated_by_discord_user_id ?? undefined,
      };
    });

    const readyCount = entries.filter((entry) => entry.status === "READY").length;
    const totalCount = entries.length;
    const requiredCount = this.config.advanceThreshold ?? totalCount;

    return {
      dynastyId: weekState.dynastyId,
      weekNumber: weekState.weekNumber,
      phase: weekState.phase,
      entries,
      readyCount,
      totalCount,
      requiredCount,
      canAdvance: totalCount > 0 && readyCount >= requiredCount,
    };
  }

  async advanceWeek(): Promise<AdvanceResult> {
    const summary = await this.getReadySummary();
    const previousWeek = summary.weekNumber;

    if (!summary.canAdvance) {
      return { advanced: false, previousWeek, currentWeek: previousWeek, summary };
    }

    const nextWeek = previousWeek + 1;

    // Close out the current week and open the next one. Readiness for the new
    // week starts empty (no rows) so every team is implicitly NOT_READY.
    await this.upsertWeekState(previousWeek, "COMPLETE");
    await this.upsertWeekState(nextWeek, "READY_CHECK");

    const nextSummary = await this.getReadySummary();
    return {
      advanced: true,
      previousWeek,
      currentWeek: nextWeek,
      summary: nextSummary,
    };
  }

  /** Resolve a team's readiness for the current week when only the row is known. */
  private async hydrateTeam(row: TeamRow): Promise<Team> {
    const weekState = await this.getWeekState();
    const readyMap = await this.fetchReadyMap(weekState.weekNumber, [row.id]);
    const ready = readyMap.get(row.id);
    return mapTeam(
      row,
      ready?.is_ready ? "READY" : "NOT_READY",
      ready?.updated_at ?? new Date().toISOString(),
    );
  }

  private async fetchTeamRows(): Promise<TeamRow[]> {
    const { data, error } = await this.client
      .from(TABLES.teams)
      .select("id, dynasty_id, name, abbreviation, discord_user_id")
      .eq("dynasty_id", this.config.dynastyId)
      .order("name", { ascending: true });

    if (error) {
      throw new Error(`Failed to list teams: ${error.message}`);
    }

    return (data as TeamRow[] | null) ?? [];
  }

  private async fetchReadyMap(
    weekNumber: number,
    teamIds?: string[],
  ): Promise<Map<string, TeamReadyStateRow>> {
    let query = this.client
      .from(TABLES.teamReadyStates)
      .select("week, team_id, is_ready, updated_at, updated_by_discord_user_id")
      .eq("week", weekNumber);

    if (teamIds && teamIds.length > 0) {
      query = query.in("team_id", teamIds);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to load ready states: ${error.message}`);
    }

    const map = new Map<string, TeamReadyStateRow>();
    for (const row of (data as TeamReadyStateRow[] | null) ?? []) {
      map.set(row.team_id, row);
    }
    return map;
  }

  private async upsertWeekState(
    weekNumber: number,
    status: WeekPhase,
  ): Promise<WeekState> {
    const row: WeekStateRow = {
      dynasty_id: this.config.dynastyId,
      week: weekNumber,
      status,
    };

    const { data, error } = await this.client
      .from(TABLES.weekStates)
      .upsert(row, { onConflict: "dynasty_id,week" })
      .select("dynasty_id, week, status")
      .single<WeekStateRow>();

    if (error) {
      throw new Error(`Failed to save week state: ${error.message}`);
    }

    return this.mapWeekState(data);
  }

  private mapWeekState(row: WeekStateRow): WeekState {
    return {
      id: `${row.dynasty_id}:${row.week}`,
      dynastyId: row.dynasty_id,
      weekNumber: row.week,
      phase: row.status,
    };
  }
}
