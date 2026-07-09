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
  /**
   * Stable integer identifier for the current week — its 0-based position in the
   * dynasty schedule (see `lib/weekSchedule.ts`). Kept named `weekNumber` for
   * backwards compatibility with the readiness/newspaper keying.
   */
  weekNumber: number;
  /** Human-readable name of the current week (e.g. "Week 5", "Bowl Week 1"). */
  weekName: string;
  /** Whether the current week is a game week. */
  isGameWeek: boolean;
  /** ISO timestamp for when the current week's deadline elapses, if set. */
  deadline?: string;
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
  /** Human-readable name of the current week (e.g. "Week 5", "Bowl Week 1"). */
  weekName: string;
  /** Whether the current week is a game week. */
  isGameWeek: boolean;
  /** ISO timestamp for the current week's deadline, if set. */
  deadline?: string;
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
  /** Human-readable name of the week that was current before advancing. */
  previousWeekName: string;
  /** Human-readable name of the week that is now current. */
  currentWeekName: string;
  /** ISO deadline set for the new current week (present when advanced). */
  deadline?: string;
  /**
   * True when the advance was refused because the dynasty is already on the last
   * week of the schedule (there is nowhere left to advance to).
   */
  atLastWeek: boolean;
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

/** A single entry in the "Chaos Power Poll" section of a weekly newspaper. */
export interface PowerPollEntry {
  /** 1-based ranking position. */
  rank: number;
  /** Team name (or abbreviation) being ranked. */
  team: string;
  /** Optional one-line justification for the ranking. */
  note?: string;
}

/**
 * Structured content of a generated weekly newspaper. Produced by the Grok
 * client and rendered into Discord embeds. Stored as JSON in the `newspapers`
 * table so the shape can evolve without migrations.
 */
export interface NewspaperContent {
  /** Catchy headline for the week. */
  headline: string;
  /** Short overall summary of the week. */
  summary: string;
  /** Notable highlights or storylines from the week. */
  highlights: string[];
  /** Optional "Chaos Power Poll" ranking (present when data allows). */
  powerPoll?: PowerPollEntry[];
}

/** A persisted weekly newspaper for a dynasty. */
export interface Newspaper {
  id: Id;
  dynastyId: Id;
  /** Week the newspaper covers (the week that just ended). */
  weekNumber: number;
  content: NewspaperContent;
  /** Grok model used to generate the content. */
  model: string;
  generatedAt: string;
}

/**
 * A single team's line in an extracted Box Score. Every field beyond `name`
 * is optional because it depends on what was legible on the screen — the video
 * pipeline records whatever Grok Vision can read and leaves the rest undefined.
 */
export interface BoxScoreTeam {
  /** Team name as read from the box score screen. */
  name: string;
  /** Final score for the team, when legible. */
  score?: number;
  /** Quarter-by-quarter points (index 0 = Q1), when visible. */
  quarterScores?: number[];
  /**
   * Free-form team stats keyed by a normalized label (e.g. `totalYards`,
   * `turnovers`). Values are kept as-is (string or number) so the shape can grow
   * without migrations.
   */
  stats?: Record<string, string | number>;
}

/**
 * Structured game data extracted from an uploaded video. v1 focuses on the
 * Box Score screen (final score, quarter scores, headline team stats).
 */
export interface BoxScore {
  /** Home team line. */
  home: BoxScoreTeam;
  /** Away team line. */
  away: BoxScoreTeam;
  /** Optional notes/caveats from the vision model (e.g. low-confidence reads). */
  notes?: string;
}

/** A persisted Box Score extracted from an uploaded video. */
export interface BoxScoreRecord {
  id: Id;
  dynastyId: Id;
  /** Week the game belongs to, when the user supplies it. */
  weekNumber?: number;
  boxScore: BoxScore;
  /** Grok vision model used to extract the data. */
  model: string;
  /** Original video filename, for reference. */
  sourceVideo?: string;
  createdAt: string;
}
