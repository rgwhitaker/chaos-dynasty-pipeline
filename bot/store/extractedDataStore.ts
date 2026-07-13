import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeagueConfig } from "@/bot/config";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";
import type {
  ExtractedDataRecord,
  LeagueConfig,
  ScreenshotDataType,
} from "@/lib/types";

/** Fields needed to persist a freshly extracted screenshot payload. */
export interface SaveExtractedDataInput {
  dataType: ScreenshotDataType;
  /** Week the data belongs to (0-based schedule index), when inferable. */
  weekNumber?: number;
  /** The structured JSON Grok Vision returned. */
  data: Record<string, unknown>;
  /** Grok vision model used to extract the data. */
  model: string;
  /** Original source path (OneDrive path or upload filename) for traceability. */
  sourcePath: string;
  /** Original file name, for display. */
  sourceName?: string;
}

/**
 * Storage contract for structured data extracted from screenshots. Mirrors the
 * {@link import("./boxScoreStore").BoxScoreStore} design: every method is async
 * so the in-memory implementation can be swapped for the Supabase-backed one
 * without touching caller code.
 */
export interface ExtractedDataStore {
  /** Persist an extracted-data record and return the stored row. */
  saveExtractedData(input: SaveExtractedDataInput): Promise<ExtractedDataRecord>;
  /**
   * Whether a screenshot with the given source path has already been processed.
   * Used by the OneDrive monitor to skip files it has already handled.
   */
  hasProcessedPath(sourcePath: string): Promise<boolean>;
}

const TABLE = "extracted_data";

/** Row shape for the `extracted_data` table. */
interface ExtractedDataRow {
  id: string;
  dynasty_id: string;
  data_type: string;
  week: number | null;
  data: Record<string, unknown>;
  model: string | null;
  source_path: string;
  source_name: string | null;
  processed_at: string;
  created_at: string;
}

const EXTRACTED_DATA_COLUMNS =
  "id, dynasty_id, data_type, week, data, model, source_path, source_name, processed_at, created_at";

function extractedDataId(dynastyId: string): string {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `data-${dynastyId}-${unique}`;
}

function mapExtractedData(row: ExtractedDataRow): ExtractedDataRecord {
  return {
    id: row.id,
    dynastyId: row.dynasty_id,
    dataType: row.data_type as ScreenshotDataType,
    weekNumber: row.week ?? undefined,
    data: row.data,
    model: row.model ?? "unknown",
    sourcePath: row.source_path,
    sourceName: row.source_name ?? undefined,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

/**
 * In-memory extracted-data store used when Supabase credentials are absent.
 * State lives for the lifetime of the process only.
 */
export class InMemoryExtractedDataStore implements ExtractedDataStore {
  private readonly config: LeagueConfig;
  private readonly records: ExtractedDataRecord[] = [];

  constructor(config: LeagueConfig) {
    this.config = config;
  }

  async saveExtractedData(
    input: SaveExtractedDataInput,
  ): Promise<ExtractedDataRecord> {
    const now = new Date().toISOString();
    const record: ExtractedDataRecord = {
      id: extractedDataId(this.config.dynastyId),
      dynastyId: this.config.dynastyId,
      dataType: input.dataType,
      weekNumber: input.weekNumber,
      data: input.data,
      model: input.model,
      sourcePath: input.sourcePath,
      sourceName: input.sourceName,
      processedAt: now,
      createdAt: now,
    };
    // Replace any earlier record for the same path so re-imports overwrite
    // rather than duplicate, matching the Supabase unique constraint behavior.
    const existingIndex = this.records.findIndex(
      (existing) => existing.sourcePath === input.sourcePath,
    );
    if (existingIndex >= 0) {
      this.records[existingIndex] = record;
    } else {
      this.records.push(record);
    }
    return { ...record };
  }

  async hasProcessedPath(sourcePath: string): Promise<boolean> {
    return this.records.some((record) => record.sourcePath === sourcePath);
  }
}

/** Supabase-backed store persisting to the `extracted_data` table. */
export class SupabaseExtractedDataStore implements ExtractedDataStore {
  private readonly config: LeagueConfig;
  private readonly client: SupabaseClient;

  constructor(config: LeagueConfig, client: SupabaseClient) {
    this.config = config;
    this.client = client;
  }

  async saveExtractedData(
    input: SaveExtractedDataInput,
  ): Promise<ExtractedDataRecord> {
    const now = new Date().toISOString();
    const row: ExtractedDataRow = {
      id: extractedDataId(this.config.dynastyId),
      dynasty_id: this.config.dynastyId,
      data_type: input.dataType,
      week: input.weekNumber ?? null,
      data: input.data,
      model: input.model,
      source_path: input.sourcePath,
      source_name: input.sourceName ?? null,
      processed_at: now,
      created_at: now,
    };

    // Upsert on the (dynasty_id, source_path) unique index so re-processing the
    // same file overwrites the previous extraction instead of failing/duplicating.
    const { data, error } = await this.client
      .from(TABLE)
      .upsert(row, { onConflict: "dynasty_id,source_path" })
      .select(EXTRACTED_DATA_COLUMNS)
      .single<ExtractedDataRow>();

    if (error) {
      throw new Error(`Failed to save extracted data: ${error.message}`);
    }

    return mapExtractedData(data);
  }

  async hasProcessedPath(sourcePath: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("id")
      .eq("dynasty_id", this.config.dynastyId)
      .eq("source_path", sourcePath)
      .maybeSingle<{ id: string }>();

    if (error) {
      throw new Error(`Failed to check extracted data: ${error.message}`);
    }

    return Boolean(data);
  }
}

const globalForStore = globalThis as typeof globalThis & {
  extractedDataStore?: ExtractedDataStore;
};

/**
 * Singleton accessor for the extracted-data store. Uses the Supabase-backed
 * store when service credentials are present; otherwise falls back to the
 * in-memory store so local development works without external dependencies.
 */
export function getExtractedDataStore(): ExtractedDataStore {
  if (!globalForStore.extractedDataStore) {
    const config = getLeagueConfig();

    if (hasSupabaseServiceCredentials()) {
      globalForStore.extractedDataStore = new SupabaseExtractedDataStore(
        config,
        getSupabaseServiceClient(),
      );
    } else {
      console.warn(
        "[extracted-data-store] Supabase credentials not found; using in-memory store. " +
          "Extracted screenshot data will not persist across restarts.",
      );
      globalForStore.extractedDataStore = new InMemoryExtractedDataStore(config);
    }
  }

  return globalForStore.extractedDataStore;
}
