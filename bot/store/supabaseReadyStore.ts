import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdvanceOptions,
  CreateTeamInput,
  ReadyStore,
  UpdateTeamInput,
  WeekDeadlineOptions,
} from "@/bot/store/readyStore";
import {
  generateAbbreviation,
  normalizeAbbreviation,
  normalizeEmoji,
  normalizeTeamName,
  slugifyTeamName,
} from "@/bot/store/teamNaming";
import {
  calculateDeadline,
  clampWeekIndex,
  getWeekByIndex,
  getWeekName,
  isLastWeekIndex,
  isValidWeekIndex,
} from "@/lib/weekSchedule";
import type {
  AdvanceResult,
  LeagueConfig,
  ReadyStatus,
  ReadySummary,
  ReadySummaryEntry,
  Team,
  TeamReadyState,
  WeekState,
} from "@/lib/types";

/** Table names used by the ready-to-advance system. */
const TABLES = {
  teams: "teams",
  dynastyState: "dynasty_state",
  teamReadyStates: "team_ready_states",
} as const;

/** Columns selected for a team row. Kept in one place so every query agrees. */
const TEAM_COLUMNS = "id, dynasty_id, name, abbreviation, emoji, discord_user_id";

/** Row shape for the `teams` table. */
interface TeamRow {
  id: string;
  dynasty_id: string;
  name: string;
  abbreviation: string | null;
  emoji: string | null;
  discord_user_id: string | null;
}

/** Row shape for the `dynasty_state` table (one row per dynasty). */
interface DynastyStateRow {
  dynasty_id: string;
  current_week: number;
  deadline: string | null;
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
    emoji: row.emoji ?? undefined,
    userId: row.discord_user_id ?? undefined,
    readyStatus: status,
    updatedAt,
  };
}

/**
 * Escape characters that are special inside a PostgREST `ilike` pattern so
 * user-supplied text is matched literally. The backslash is escaped first (it is
 * the escape character itself), `%` and `_` are LIKE wildcards, and
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
      .from(TABLES.dynastyState)
      .select("dynasty_id, current_week, deadline")
      .eq("dynasty_id", this.config.dynastyId)
      .maybeSingle<DynastyStateRow>();

    if (error) {
      throw new Error(`Failed to load week state: ${error.message}`);
    }

    if (!data) {
      // No state yet — initialize the dynasty at its configured start week.
      const startIndex = clampWeekIndex(this.config.startWeek);
      return this.upsertDynastyState(startIndex);
    }

    return this.mapWeekState(data);
  }

  async setCurrentWeek(
    weekNumber: number,
    options?: WeekDeadlineOptions,
  ): Promise<WeekState> {
    if (!isValidWeekIndex(weekNumber)) {
      throw new Error(`Invalid week: ${weekNumber}`);
    }
    return this.upsertDynastyState(weekNumber, options?.deadlineOverrideHours);
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
      .select(TEAM_COLUMNS)
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
      .select(TEAM_COLUMNS)
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
      .select(TEAM_COLUMNS)
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
      .select(TEAM_COLUMNS)
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
    const emoji = input.emoji ? normalizeEmoji(input.emoji) : undefined;

    const id = await this.generateTeamId(name);
    const row: Pick<
      TeamRow,
      "id" | "dynasty_id" | "name" | "abbreviation" | "emoji" | "discord_user_id"
    > = {
      id,
      dynasty_id: this.config.dynastyId,
      name,
      abbreviation: abbreviation || null,
      emoji: emoji ?? null,
      discord_user_id: null,
    };

    const { data, error } = await this.client
      .from(TABLES.teams)
      .insert(row)
      .select(TEAM_COLUMNS)
      .single<TeamRow>();

    if (error) {
      throw new Error(`Failed to create team "${name}": ${error.message}`);
    }

    return mapTeam(data, "NOT_READY", new Date().toISOString());
  }

  async updateTeam(teamId: string, updates: UpdateTeamInput): Promise<Team> {
    const patch: Partial<Pick<TeamRow, "name" | "abbreviation" | "emoji">> = {};

    if (updates.name !== undefined) {
      patch.name = normalizeTeamName(updates.name);
    }
    if (updates.abbreviation !== undefined) {
      patch.abbreviation = normalizeAbbreviation(updates.abbreviation) || null;
    }
    if (updates.emoji !== undefined) {
      patch.emoji = updates.emoji === null ? null : (normalizeEmoji(updates.emoji) ?? null);
    }

    // Nothing to change — return the current team so callers get a fresh copy.
    if (Object.keys(patch).length === 0) {
      const existing = await this.getTeamById(teamId);
      if (!existing) {
        throw new Error(`Unknown team: ${teamId}`);
      }
      return existing;
    }

    const { data, error } = await this.client
      .from(TABLES.teams)
      .update(patch)
      .eq("dynasty_id", this.config.dynastyId)
      .eq("id", teamId)
      .select(TEAM_COLUMNS)
      .maybeSingle<TeamRow>();

    if (error) {
      throw new Error(`Failed to update team ${teamId}: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown team: ${teamId}`);
    }

    return this.hydrateTeam(data);
  }

  async deleteTeam(teamId: string): Promise<void> {
    // `team_ready_states` rows cascade on delete (see schema), so removing the
    // team row is enough to clean up its readiness history.
    const { data, error } = await this.client
      .from(TABLES.teams)
      .delete()
      .eq("dynasty_id", this.config.dynastyId)
      .eq("id", teamId)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error) {
      throw new Error(`Failed to delete team ${teamId}: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown team: ${teamId}`);
    }
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
      .select(TEAM_COLUMNS)
      .single<TeamRow>();

    if (error) {
      throw new Error(`Failed to link user to team ${teamId}: ${error.message}`);
    }

    return this.hydrateTeam(data);
  }

  async unlinkDiscordUser(discordUserId: string): Promise<Team | undefined> {
    const { data, error } = await this.client
      .from(TABLES.teams)
      .update({ discord_user_id: null })
      .eq("dynasty_id", this.config.dynastyId)
      .eq("discord_user_id", discordUserId)
      .select(TEAM_COLUMNS)
      .maybeSingle<TeamRow>();

    if (error) {
      throw new Error(`Failed to unlink user ${discordUserId}: ${error.message}`);
    }

    return data ? this.hydrateTeam(data) : undefined;
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
      weekName: weekState.weekName,
      isGameWeek: weekState.isGameWeek,
      deadline: weekState.deadline,
      phase: weekState.phase,
      entries,
      readyCount,
      totalCount,
      requiredCount,
      canAdvance: totalCount > 0 && readyCount >= requiredCount,
    };
  }

  async advanceWeek(options?: AdvanceOptions): Promise<AdvanceResult> {
    const summary = await this.getReadySummary();
    const previousWeek = summary.weekNumber;
    const previousWeekName = getWeekName(previousWeek);
    const force = options?.force ?? false;

    // Refuse to advance past the last week of the schedule.
    if (isLastWeekIndex(previousWeek)) {
      return {
        advanced: false,
        previousWeek,
        currentWeek: previousWeek,
        previousWeekName,
        currentWeekName: previousWeekName,
        atLastWeek: true,
        summary,
      };
    }

    // Unless forced, require enough teams to be ready.
    if (!force && !summary.canAdvance) {
      return {
        advanced: false,
        previousWeek,
        currentWeek: previousWeek,
        previousWeekName,
        currentWeekName: previousWeekName,
        atLastWeek: false,
        summary,
      };
    }

    // The advance is "forced" when it only happened because of the override.
    const forced = force && !summary.canAdvance;

    const nextWeek = previousWeek + 1;

    // Point the dynasty at the next week and calculate its deadline. Readiness
    // for the new week starts empty (no rows) so every team is implicitly
    // NOT_READY.
    const nextState = await this.setCurrentWeek(nextWeek, options);

    const nextSummary = await this.getReadySummary();
    return {
      advanced: true,
      previousWeek,
      currentWeek: nextWeek,
      previousWeekName,
      currentWeekName: nextState.weekName,
      deadline: nextState.deadline,
      atLastWeek: false,
      forced,
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
      .select(TEAM_COLUMNS)
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

  private async upsertDynastyState(
    weekNumber: number,
    deadlineOverrideHours?: number,
  ): Promise<WeekState> {
    const week = getWeekByIndex(weekNumber);
    const deadline = week
      ? calculateDeadline(week, deadlineOverrideHours)
      : null;

    const row: DynastyStateRow = {
      dynasty_id: this.config.dynastyId,
      current_week: weekNumber,
      deadline,
    };

    const { data, error } = await this.client
      .from(TABLES.dynastyState)
      .upsert(row, { onConflict: "dynasty_id" })
      .select("dynasty_id, current_week, deadline")
      .single<DynastyStateRow>();

    if (error) {
      throw new Error(`Failed to save week state: ${error.message}`);
    }

    return this.mapWeekState(data);
  }

  private mapWeekState(row: DynastyStateRow): WeekState {
    const week = getWeekByIndex(row.current_week);
    return {
      id: `${row.dynasty_id}:week`,
      dynastyId: row.dynasty_id,
      weekNumber: row.current_week,
      weekName: getWeekName(row.current_week),
      isGameWeek: week?.isGameWeek ?? false,
      deadline: row.deadline ?? undefined,
      phase: "READY_CHECK",
    };
  }
}
