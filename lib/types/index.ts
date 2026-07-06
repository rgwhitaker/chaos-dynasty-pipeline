export type Id = string;

export type ReadyStatus = "NOT_READY" | "READY";

export interface Team {
  id: Id;
  dynastyId: Id;
  name: string;
  /** Short display abbreviation (e.g. "CHA"). */
  abbreviation?: string;
  /** Optional emoji shown next to the team name in Discord messages. */
  emoji?: string;
  mascot?: string;
  conference?: string;
  userId?: Id;
  readyStatus: ReadyStatus;
  updatedAt: string;
}

export interface Game {
  id: Id;
  dynastyId: Id;
  weekNumber: number;
  homeTeamId: Id;
  awayTeamId: Id;
  homeScore?: number;
  awayScore?: number;
  playedAt?: string;
}

export type WeekPhase = "DATA_COLLECTION" | "READY_CHECK" | "ADVANCING" | "COMPLETE";

export interface WeekState {
  id: Id;
  dynastyId: Id;
  weekNumber: number;
  phase: WeekPhase;
  advanceRequestedAt?: string;
  advancedAt?: string;
}

export interface TeamReadyState {
  teamId: Id;
  weekNumber: number;
  status: ReadyStatus;
  updatedByDiscordUserId?: string;
  updatedAt: string;
}

/**
 * Runtime configuration for the league / ready-to-advance flow.
 * These values are read from the environment on startup (see `bot/config.ts`)
 * but are grouped here so the shape is reusable once we move state to Supabase.
 */
export interface LeagueConfig {
  /** Dynasty this bot instance coordinates. */
  dynastyId: Id;
  /** Week the league starts on when state is first initialized. */
  startWeek: number;
  /**
   * Minimum number of teams that must be READY before `/advance` succeeds.
   * When `null`, every team must be ready.
   */
  advanceThreshold: number | null;
  /** Optional Discord role id that is allowed to run `/advance`. */
  commissionerRoleId?: string;
}

/** A single team's readiness for the current week, joined with its team record. */
export interface ReadySummaryEntry {
  team: Team;
  status: ReadyStatus;
  updatedAt?: string;
  updatedByDiscordUserId?: string;
}

/**
 * Aggregated snapshot of the current week's readiness, used to render the
 * Discord status message and to decide whether the week can advance.
 */
export interface ReadySummary {
  dynastyId: Id;
  weekNumber: number;
  phase: WeekPhase;
  entries: ReadySummaryEntry[];
  readyCount: number;
  totalCount: number;
  /** Number of ready teams required to advance (resolved from config). */
  requiredCount: number;
  canAdvance: boolean;
}

/** Result of an advance attempt returned by the ready store. */
export interface AdvanceResult {
  advanced: boolean;
  previousWeek: number;
  currentWeek: number;
  summary: ReadySummary;
}

export interface ScreenshotAsset {
  id: Id;
  dynastyId: Id;
  weekNumber: number;
  uploadedBy?: string;
  storagePath: string;
  source: "MANUAL_UPLOAD" | "STORAGE_POLL";
  status: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED";
  createdAt: string;
}

export interface GeneratedNewspaper {
  id: Id;
  dynastyId: Id;
  weekNumber: number;
  headline: string;
  bodyMarkdown: string;
  model: string;
  sourceGameIds: Id[];
  generatedAt: string;
}
