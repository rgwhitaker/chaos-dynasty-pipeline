import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeagueConfig } from "@/bot/config";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";
import type { BoxScore, BoxScoreRecord, LeagueConfig } from "@/lib/types";

/** Fields needed to persist a freshly extracted box score. */
export interface SaveBoxScoreInput {
  boxScore: BoxScore;
  model: string;
  /** Optional week the game belongs to. */
  weekNumber?: number;
  /** Original video filename, for reference. */
  sourceVideo?: string;
}

/**
 * Storage contract for box scores extracted from uploaded videos. Mirrors the
 * {@link NewspaperStore} design: every method is async so the in-memory
 * implementation can be swapped for the Supabase-backed one without touching
 * command code.
 */
export interface BoxScoreStore {
  /** Persist a box score and return the stored record. */
  saveBoxScore(input: SaveBoxScoreInput): Promise<BoxScoreRecord>;
}

const TABLE = "box_scores";

/** Row shape for the `box_scores` table. */
interface BoxScoreRow {
  id: string;
  dynasty_id: string;
  week: number | null;
  home_team: string | null;
  home_score: number | null;
  away_team: string | null;
  away_score: number | null;
  data: BoxScore;
  model: string | null;
  source_video: string | null;
  created_at: string;
}

function boxScoreId(dynastyId: string): string {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `box-${dynastyId}-${unique}`;
}

function mapBoxScore(row: BoxScoreRow): BoxScoreRecord {
  return {
    id: row.id,
    dynastyId: row.dynasty_id,
    weekNumber: row.week ?? undefined,
    boxScore: row.data,
    model: row.model ?? "unknown",
    sourceVideo: row.source_video ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * In-memory box score store used when Supabase credentials are absent. State
 * lives for the lifetime of the process only.
 */
export class InMemoryBoxScoreStore implements BoxScoreStore {
  private readonly config: LeagueConfig;
  private readonly records: BoxScoreRecord[] = [];

  constructor(config: LeagueConfig) {
    this.config = config;
  }

  async saveBoxScore(input: SaveBoxScoreInput): Promise<BoxScoreRecord> {
    const record: BoxScoreRecord = {
      id: boxScoreId(this.config.dynastyId),
      dynastyId: this.config.dynastyId,
      weekNumber: input.weekNumber,
      boxScore: input.boxScore,
      model: input.model,
      sourceVideo: input.sourceVideo,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    return { ...record };
  }
}

/** Supabase-backed box score store persisting to the `box_scores` table. */
export class SupabaseBoxScoreStore implements BoxScoreStore {
  private readonly config: LeagueConfig;
  private readonly client: SupabaseClient;

  constructor(config: LeagueConfig, client: SupabaseClient) {
    this.config = config;
    this.client = client;
  }

  async saveBoxScore(input: SaveBoxScoreInput): Promise<BoxScoreRecord> {
    const row: BoxScoreRow = {
      id: boxScoreId(this.config.dynastyId),
      dynasty_id: this.config.dynastyId,
      week: input.weekNumber ?? null,
      home_team: input.boxScore.home.name ?? null,
      home_score: input.boxScore.home.score ?? null,
      away_team: input.boxScore.away.name ?? null,
      away_score: input.boxScore.away.score ?? null,
      data: input.boxScore,
      model: input.model,
      source_video: input.sourceVideo ?? null,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await this.client
      .from(TABLE)
      .insert(row)
      .select(
        "id, dynasty_id, week, home_team, home_score, away_team, away_score, data, model, source_video, created_at",
      )
      .single<BoxScoreRow>();

    if (error) {
      throw new Error(`Failed to save box score: ${error.message}`);
    }

    return mapBoxScore(data);
  }
}

const globalForStore = globalThis as typeof globalThis & {
  boxScoreStore?: BoxScoreStore;
};

/**
 * Singleton accessor for the box score store. Uses the Supabase-backed store
 * when service credentials are present; otherwise falls back to the in-memory
 * store so local development works without external dependencies.
 */
export function getBoxScoreStore(): BoxScoreStore {
  if (!globalForStore.boxScoreStore) {
    const config = getLeagueConfig();

    if (hasSupabaseServiceCredentials()) {
      globalForStore.boxScoreStore = new SupabaseBoxScoreStore(
        config,
        getSupabaseServiceClient(),
      );
    } else {
      console.warn(
        "[box-score-store] Supabase credentials not found; using in-memory store. " +
          "Extracted box scores will not persist across restarts.",
      );
      globalForStore.boxScoreStore = new InMemoryBoxScoreStore(config);
    }
  }

  return globalForStore.boxScoreStore;
}
