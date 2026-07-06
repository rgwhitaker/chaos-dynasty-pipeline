export type Id = string;

export type ReadyStatus = "NOT_READY" | "READY";

export interface Team {
  id: Id;
  dynastyId: Id;
  name: string;
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
