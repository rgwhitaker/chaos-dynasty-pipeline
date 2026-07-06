import { getLeagueConfig } from "@/bot/config";
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
  /** Override the current week (used by `/advance` and admin tooling). */
  setCurrentWeek(weekNumber: number): Promise<WeekState>;

  /** All teams in the dynasty. */
  listTeams(): Promise<Team[]>;
  getTeamById(teamId: string): Promise<Team | undefined>;
  /** Find the team a Discord user is linked to, if any. */
  getTeamByDiscordUserId(discordUserId: string): Promise<Team | undefined>;

  /** Persist a team's readiness for the current week. */
  setReadyStatus(
    teamId: string,
    status: ReadyStatus,
    discordUserId?: string,
  ): Promise<TeamReadyState>;

  /** Aggregated readiness snapshot for the current week. */
  getReadySummary(): Promise<ReadySummary>;

  /**
   * Advance to the next week when enough teams are ready. Resets readiness for
   * the new week. Returns whether the advance actually happened.
   */
  advanceWeek(): Promise<AdvanceResult>;
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
  private weekState: WeekState;
  /** Keyed by `${weekNumber}:${teamId}`. */
  private readonly readyStates = new Map<string, TeamReadyState>();

  constructor(config: LeagueConfig) {
    this.config = config;
    this.teams = seedTeams(config.dynastyId);
    applyTeamLinks(this.teams);
    this.weekState = {
      id: `${config.dynastyId}:week`,
      dynastyId: config.dynastyId,
      weekNumber: config.startWeek,
      phase: "READY_CHECK",
    };
  }

  async getWeekState(): Promise<WeekState> {
    return { ...this.weekState };
  }

  async setCurrentWeek(weekNumber: number): Promise<WeekState> {
    this.weekState = { ...this.weekState, weekNumber, phase: "READY_CHECK" };
    return { ...this.weekState };
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
      weekNumber: this.weekState.weekNumber,
      status,
      updatedByDiscordUserId: discordUserId,
      updatedAt: now,
    };

    this.readyStates.set(this.readyKey(this.weekState.weekNumber, teamId), readyState);
    return { ...readyState };
  }

  async getReadySummary(): Promise<ReadySummary> {
    const weekNumber = this.weekState.weekNumber;

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
      dynastyId: this.weekState.dynastyId,
      weekNumber,
      phase: this.weekState.phase,
      entries,
      readyCount,
      totalCount,
      requiredCount,
      canAdvance: totalCount > 0 && readyCount >= requiredCount,
    };
  }

  async advanceWeek(): Promise<AdvanceResult> {
    const summary = await this.getReadySummary();
    const previousWeek = this.weekState.weekNumber;

    if (!summary.canAdvance) {
      return { advanced: false, previousWeek, currentWeek: previousWeek, summary };
    }

    // Move to the next week and reset readiness so the new week starts clean.
    const nextWeek = previousWeek + 1;
    for (const team of this.teams) {
      team.readyStatus = "NOT_READY";
      team.updatedAt = new Date().toISOString();
    }
    this.weekState = { ...this.weekState, weekNumber: nextWeek, phase: "READY_CHECK" };

    const nextSummary = await this.getReadySummary();
    return {
      advanced: true,
      previousWeek,
      currentWeek: nextWeek,
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
 */
export function getReadyStore(): ReadyStore {
  if (!globalForStore.readyStore) {
    globalForStore.readyStore = new InMemoryReadyStore(getLeagueConfig());
  }

  return globalForStore.readyStore;
}
