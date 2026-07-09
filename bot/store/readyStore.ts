import { getLeagueConfig } from "@/bot/config";
import { SupabaseReadyStore } from "@/bot/store/supabaseReadyStore";
import {
  generateAbbreviation,
  normalizeAbbreviation,
  normalizeEmoji,
  normalizeTeamName,
  slugifyTeamName,
} from "@/bot/store/teamNaming";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";
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

/** Input used to create a new team via the store. */
export interface CreateTeamInput {
  /** Human-readable team name (already validated for length by the caller). */
  name: string;
  /** Optional short abbreviation; generated from the name when omitted. */
  abbreviation?: string;
  /** Optional emoji shown next to the team name in Discord messages. */
  emoji?: string;
}

/**
 * Fields that may be changed on an existing team. Only provided keys are
 * updated. `emoji` accepts `null` to explicitly clear a previously-set emoji.
 */
export interface UpdateTeamInput {
  name?: string;
  abbreviation?: string;
  emoji?: string | null;
}

/** Options controlling how a week's deadline is (re)calculated. */
export interface WeekDeadlineOptions {
  /**
   * Override the default deadline window (in hours) for the target week. When
   * omitted, the week's `defaultDurationHours` from the schedule is used (48h for
   * game weeks, 24h otherwise).
   */
  deadlineOverrideHours?: number;
}

/** Options controlling an advance attempt. */
export interface AdvanceOptions extends WeekDeadlineOptions {
  /**
   * Force the advance even when fewer teams than required are marked ready.
   * Used by commissioners when teams are ready in-game but not in the bot, or
   * when the deadline has been reached. Does not bypass the last-week guard.
   */
  force?: boolean;
}

/**
 * Storage contract for the ready-to-advance system.
 *
 * Every method is async so that the in-memory implementation below can later be
 * swapped for a Supabase-backed one without touching any command code. Commands
 * should only ever depend on this interface via `getReadyStore()`.
 */
export interface ReadyStore {
  /** Current week + phase for the dynasty. */
  getWeekState(): Promise<WeekState>;
  /**
   * Jump to a specific week by its schedule index (used by `/set-week` and admin
   * tooling). Recalculates the deadline from the target week's default duration
   * unless an override is supplied. Throws for an invalid index.
   */
  setCurrentWeek(weekNumber: number, options?: WeekDeadlineOptions): Promise<WeekState>;

  /** All teams in the dynasty. */
  listTeams(): Promise<Team[]>;
  getTeamById(teamId: string): Promise<Team | undefined>;
  /** Find the team a Discord user is linked to, if any. */
  getTeamByDiscordUserId(discordUserId: string): Promise<Team | undefined>;

  /**
   * Find a team whose name or abbreviation matches `query` (case-insensitive,
   * exact match). Used by `/register` to detect existing teams.
   */
  findTeamByNameOrAbbreviation(query: string): Promise<Team | undefined>;

  /**
   * Search teams by name or abbreviation for autocomplete. Matches are
   * case-insensitive substring matches; results are capped at `limit` (default
   * 25, Discord's autocomplete maximum).
   */
  searchTeams(query: string, limit?: number): Promise<Team[]>;

  /** Create a new team record and return it. */
  createTeam(input: CreateTeamInput): Promise<Team>;

  /**
   * Update an existing team's name, abbreviation, and/or emoji. Only the
   * provided fields are changed. Throws when the team does not exist.
   */
  updateTeam(teamId: string, updates: UpdateTeamInput): Promise<Team>;

  /** Delete a team and its readiness history. Throws when it does not exist. */
  deleteTeam(teamId: string): Promise<void>;

  /**
   * Link a Discord user to a team by setting `discord_user_id`. If the user is
   * already linked to a different team, they are removed from it first so a user
   * is only ever linked to one team.
   */
  linkTeamToDiscordUser(teamId: string, discordUserId: string): Promise<Team>;

  /**
   * Remove a Discord user's link to whatever team they are currently on.
   * Returns the team they were unlinked from, or `undefined` when the user was
   * not linked to any team.
   */
  unlinkDiscordUser(discordUserId: string): Promise<Team | undefined>;

  /** Persist a team's readiness for the current week. */
  setReadyStatus(
    teamId: string,
    status: ReadyStatus,
    discordUserId?: string,
  ): Promise<TeamReadyState>;

  /** Aggregated readiness snapshot for the current week. */
  getReadySummary(): Promise<ReadySummary>;

  /**
   * Advance to the next week in the schedule when enough teams are ready. Resets
   * readiness for the new week and calculates its deadline (overridable via
   * `options.deadlineOverrideHours`). Returns whether the advance actually
   * happened; refuses to advance past the last week of the schedule. Pass
   * `options.force` to advance even when not enough teams are ready.
   */
  advanceWeek(options?: AdvanceOptions): Promise<AdvanceResult>;
}

/** Seed teams used while everything is in memory (pre-Supabase). */
function seedTeams(dynastyId: string): Team[] {
  const now = new Date().toISOString();
  const base: Array<Pick<Team, "id" | "name" | "mascot" | "conference">> = [
    { id: "team-thunder", name: "Chaos Thunder", mascot: "Bolts", conference: "East" },
    { id: "team-reign", name: "Midnight Reign", mascot: "Wolves", conference: "East" },
    { id: "team-blitz", name: "Prairie Blitz", mascot: "Bison", conference: "West" },
    { id: "team-surge", name: "Coastal Surge", mascot: "Krakens", conference: "West" },
  ];

  return base.map((team) => ({
    ...team,
    dynastyId,
    readyStatus: "NOT_READY",
    updatedAt: now,
  }));
}

/**
 * Apply optional Discord user <-> team links from the environment so testers can
 * map their own Discord id to a seeded team. Format (JSON):
 *   DISCORD_TEAM_LINKS=[{"discordUserId":"123","teamId":"team-thunder"}]
 * `teamName` may be used instead of `teamId` for convenience.
 */
function applyTeamLinks(teams: Team[]): void {
  const raw = process.env.DISCORD_TEAM_LINKS?.trim();
  if (!raw) {
    return;
  }

  let links: Array<{ discordUserId?: string; teamId?: string; teamName?: string }>;
  try {
    links = JSON.parse(raw);
  } catch {
    console.warn("[ready-store] DISCORD_TEAM_LINKS is not valid JSON; ignoring.");
    return;
  }

  if (!Array.isArray(links)) {
    return;
  }

  for (const link of links) {
    if (!link?.discordUserId) {
      continue;
    }

    const team = teams.find(
      (candidate) =>
        candidate.id === link.teamId ||
        candidate.name.toLowerCase() === link.teamName?.toLowerCase(),
    );

    if (team) {
      team.userId = link.discordUserId;
    }
  }
}

/**
 * In-memory ready store. State lives for the lifetime of the process only; it is
 * intentionally simple and mirrors the eventual Supabase tables (teams,
 * week_state, team_ready_state) so the swap is mechanical.
 */
export class InMemoryReadyStore implements ReadyStore {
  private readonly config: LeagueConfig;
  private readonly teams: Team[];
  /** Current week as a schedule index (see `lib/weekSchedule.ts`). */
  private currentWeekIndex: number;
  /** ISO deadline for the current week, if set. */
  private deadline?: string;
  /** Keyed by `${weekNumber}:${teamId}`. */
  private readonly readyStates = new Map<string, TeamReadyState>();

  constructor(config: LeagueConfig) {
    this.config = config;
    this.teams = seedTeams(config.dynastyId);
    applyTeamLinks(this.teams);
    this.currentWeekIndex = clampWeekIndex(config.startWeek);
    const startWeek = getWeekByIndex(this.currentWeekIndex);
    this.deadline = startWeek ? calculateDeadline(startWeek) : undefined;
  }

  /** Build a full {@link WeekState} from the current index + deadline. */
  private buildWeekState(): WeekState {
    const week = getWeekByIndex(this.currentWeekIndex);
    return {
      id: `${this.config.dynastyId}:week`,
      dynastyId: this.config.dynastyId,
      weekNumber: this.currentWeekIndex,
      weekName: getWeekName(this.currentWeekIndex),
      isGameWeek: week?.isGameWeek ?? false,
      deadline: this.deadline,
      phase: "READY_CHECK",
    };
  }

  async getWeekState(): Promise<WeekState> {
    return this.buildWeekState();
  }

  async setCurrentWeek(
    weekNumber: number,
    options?: WeekDeadlineOptions,
  ): Promise<WeekState> {
    if (!isValidWeekIndex(weekNumber)) {
      throw new Error(`Invalid week: ${weekNumber}`);
    }
    const week = getWeekByIndex(weekNumber)!;
    this.currentWeekIndex = weekNumber;
    this.deadline = calculateDeadline(week, options?.deadlineOverrideHours);
    return this.buildWeekState();
  }

  async listTeams(): Promise<Team[]> {
    return this.teams.map((team) => ({ ...team }));
  }

  async getTeamById(teamId: string): Promise<Team | undefined> {
    const team = this.teams.find((candidate) => candidate.id === teamId);
    return team ? { ...team } : undefined;
  }

  async getTeamByDiscordUserId(discordUserId: string): Promise<Team | undefined> {
    const team = this.teams.find((candidate) => candidate.userId === discordUserId);
    return team ? { ...team } : undefined;
  }

  async findTeamByNameOrAbbreviation(query: string): Promise<Team | undefined> {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return undefined;
    }

    const team = this.teams.find(
      (candidate) =>
        candidate.name.toLowerCase() === needle ||
        candidate.abbreviation?.toLowerCase() === needle,
    );
    return team ? { ...team } : undefined;
  }

  async searchTeams(query: string, limit = 25): Promise<Team[]> {
    const needle = query.trim().toLowerCase();

    const matches = this.teams.filter((candidate) => {
      if (!needle) {
        return true;
      }
      return (
        candidate.name.toLowerCase().includes(needle) ||
        (candidate.abbreviation?.toLowerCase().includes(needle) ?? false)
      );
    });

    return matches.slice(0, limit).map((team) => ({ ...team }));
  }

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const name = normalizeTeamName(input.name);
    const abbreviation = input.abbreviation
      ? normalizeAbbreviation(input.abbreviation)
      : generateAbbreviation(name);
    const emoji = input.emoji ? normalizeEmoji(input.emoji) : undefined;

    const now = new Date().toISOString();
    const team: Team = {
      id: this.generateTeamId(name),
      dynastyId: this.config.dynastyId,
      name,
      abbreviation: abbreviation || undefined,
      emoji,
      readyStatus: "NOT_READY",
      updatedAt: now,
    };

    this.teams.push(team);
    return { ...team };
  }

  async updateTeam(teamId: string, updates: UpdateTeamInput): Promise<Team> {
    const team = this.teams.find((candidate) => candidate.id === teamId);
    if (!team) {
      throw new Error(`Unknown team: ${teamId}`);
    }

    if (updates.name !== undefined) {
      team.name = normalizeTeamName(updates.name);
    }
    if (updates.abbreviation !== undefined) {
      team.abbreviation = normalizeAbbreviation(updates.abbreviation) || undefined;
    }
    if (updates.emoji !== undefined) {
      team.emoji = updates.emoji === null ? undefined : normalizeEmoji(updates.emoji);
    }

    team.updatedAt = new Date().toISOString();
    return { ...team };
  }

  async deleteTeam(teamId: string): Promise<void> {
    const index = this.teams.findIndex((candidate) => candidate.id === teamId);
    if (index === -1) {
      throw new Error(`Unknown team: ${teamId}`);
    }

    this.teams.splice(index, 1);

    // Drop any readiness history for the removed team.
    for (const key of [...this.readyStates.keys()]) {
      if (key.endsWith(`:${teamId}`)) {
        this.readyStates.delete(key);
      }
    }
  }

  async linkTeamToDiscordUser(teamId: string, discordUserId: string): Promise<Team> {
    const team = this.teams.find((candidate) => candidate.id === teamId);
    if (!team) {
      throw new Error(`Unknown team: ${teamId}`);
    }

    // Remove the user from any team they were previously linked to so each user
    // is only ever linked to a single team.
    for (const other of this.teams) {
      if (other.id !== teamId && other.userId === discordUserId) {
        other.userId = undefined;
        other.updatedAt = new Date().toISOString();
      }
    }

    team.userId = discordUserId;
    team.updatedAt = new Date().toISOString();
    return { ...team };
  }

  async unlinkDiscordUser(discordUserId: string): Promise<Team | undefined> {
    const team = this.teams.find((candidate) => candidate.userId === discordUserId);
    if (!team) {
      return undefined;
    }

    team.userId = undefined;
    team.updatedAt = new Date().toISOString();
    return { ...team };
  }

  /** Build a unique team id from a name, appending a suffix on collision. */
  private generateTeamId(name: string): string {
    const base = `team-${slugifyTeamName(name)}`;
    let candidate = base;
    let suffix = 2;
    while (this.teams.some((team) => team.id === candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async setReadyStatus(
    teamId: string,
    status: ReadyStatus,
    discordUserId?: string,
  ): Promise<TeamReadyState> {
    const team = this.teams.find((candidate) => candidate.id === teamId);
    if (!team) {
      throw new Error(`Unknown team: ${teamId}`);
    }

    const now = new Date().toISOString();
    team.readyStatus = status;
    team.updatedAt = now;

    const readyState: TeamReadyState = {
      teamId,
      weekNumber: this.currentWeekIndex,
      status,
      updatedByDiscordUserId: discordUserId,
      updatedAt: now,
    };

    this.readyStates.set(this.readyKey(this.currentWeekIndex, teamId), readyState);
    return { ...readyState };
  }

  async getReadySummary(): Promise<ReadySummary> {
    const weekState = this.buildWeekState();
    const weekNumber = weekState.weekNumber;

    const entries: ReadySummaryEntry[] = this.teams.map((team) => {
      const readyState = this.readyStates.get(this.readyKey(weekNumber, team.id));
      return {
        team: { ...team },
        status: readyState?.status ?? "NOT_READY",
        updatedAt: readyState?.updatedAt,
        updatedByDiscordUserId: readyState?.updatedByDiscordUserId,
      };
    });

    const readyCount = entries.filter((entry) => entry.status === "READY").length;
    const totalCount = entries.length;
    const requiredCount = this.config.advanceThreshold ?? totalCount;

    return {
      dynastyId: weekState.dynastyId,
      weekNumber,
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
    const previousWeek = this.currentWeekIndex;
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

    // Move to the next week and reset readiness so the new week starts clean.
    const nextWeek = previousWeek + 1;
    for (const team of this.teams) {
      team.readyStatus = "NOT_READY";
      team.updatedAt = new Date().toISOString();
    }
    // Clear any readiness recorded for the new week (e.g. stale rows left over
    // from a previous visit to this week) so everyone starts NOT_READY.
    for (const key of [...this.readyStates.keys()]) {
      if (key.startsWith(`${nextWeek}:`)) {
        this.readyStates.delete(key);
      }
    }
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

  private readyKey(weekNumber: number, teamId: string): string {
    return `${weekNumber}:${teamId}`;
  }
}

const globalForStore = globalThis as typeof globalThis & {
  readyStore?: ReadyStore;
};

/**
 * Singleton accessor. Uses a global so the store survives Next.js hot reloads in
 * development (same trick used for the Discord client).
 *
 * When Supabase service credentials are configured the persistent
 * {@link SupabaseReadyStore} is used; otherwise it falls back to the in-memory
 * store so local development works without any external dependencies.
 */
export function getReadyStore(): ReadyStore {
  if (!globalForStore.readyStore) {
    const config = getLeagueConfig();

    if (hasSupabaseServiceCredentials()) {
      globalForStore.readyStore = new SupabaseReadyStore(config, getSupabaseServiceClient());
    } else {
      console.warn(
        "[ready-store] Supabase credentials not found; using in-memory store. " +
          "State will not persist across restarts.",
      );
      globalForStore.readyStore = new InMemoryReadyStore(config);
    }
  }

  return globalForStore.readyStore;
}
