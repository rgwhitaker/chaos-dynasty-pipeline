import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeagueConfig } from "@/bot/config";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";
import type { LeagueConfig, Newspaper, NewspaperContent } from "@/lib/types";

/** Fields needed to persist a freshly generated newspaper. */
export interface SaveNewspaperInput {
  weekNumber: number;
  content: NewspaperContent;
  model: string;
}

/**
 * Storage contract for generated weekly newspapers. Mirrors the {@link ReadyStore}
 * design: every method is async so the in-memory implementation can be swapped
 * for the Supabase-backed one without touching command code.
 */
export interface NewspaperStore {
  /** Persist a newspaper and return the stored record. */
  saveNewspaper(input: SaveNewspaperInput): Promise<Newspaper>;
  /** Fetch the most recently generated newspaper for a week, if any. */
  getLatestNewspaper(weekNumber: number): Promise<Newspaper | undefined>;
}

const TABLE = "newspapers";

/** Row shape for the `newspapers` table. */
interface NewspaperRow {
  id: string;
  dynasty_id: string;
  week: number;
  headline: string;
  content: NewspaperContent;
  model: string | null;
  generated_at: string;
}

function newspaperId(dynastyId: string, weekNumber: number): string {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `news-${dynastyId}-w${weekNumber}-${unique}`;
}

function mapNewspaper(row: NewspaperRow): Newspaper {
  return {
    id: row.id,
    dynastyId: row.dynasty_id,
    weekNumber: row.week,
    content: row.content,
    model: row.model ?? "unknown",
    generatedAt: row.generated_at,
  };
}

/**
 * In-memory newspaper store used when Supabase credentials are absent. State
 * lives for the lifetime of the process only.
 */
export class InMemoryNewspaperStore implements NewspaperStore {
  private readonly config: LeagueConfig;
  private readonly newspapers: Newspaper[] = [];

  constructor(config: LeagueConfig) {
    this.config = config;
  }

  async saveNewspaper(input: SaveNewspaperInput): Promise<Newspaper> {
    const newspaper: Newspaper = {
      id: newspaperId(this.config.dynastyId, input.weekNumber),
      dynastyId: this.config.dynastyId,
      weekNumber: input.weekNumber,
      content: input.content,
      model: input.model,
      generatedAt: new Date().toISOString(),
    };
    this.newspapers.push(newspaper);
    return { ...newspaper };
  }

  async getLatestNewspaper(weekNumber: number): Promise<Newspaper | undefined> {
    const matches = this.newspapers
      .filter((paper) => paper.weekNumber === weekNumber)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    const latest = matches[0];
    return latest ? { ...latest } : undefined;
  }
}

/** Supabase-backed newspaper store persisting to the `newspapers` table. */
export class SupabaseNewspaperStore implements NewspaperStore {
  private readonly config: LeagueConfig;
  private readonly client: SupabaseClient;

  constructor(config: LeagueConfig, client: SupabaseClient) {
    this.config = config;
    this.client = client;
  }

  async saveNewspaper(input: SaveNewspaperInput): Promise<Newspaper> {
    const row: NewspaperRow = {
      id: newspaperId(this.config.dynastyId, input.weekNumber),
      dynasty_id: this.config.dynastyId,
      week: input.weekNumber,
      headline: input.content.headline,
      content: input.content,
      model: input.model,
      generated_at: new Date().toISOString(),
    };

    const { data, error } = await this.client
      .from(TABLE)
      .insert(row)
      .select("id, dynasty_id, week, headline, content, model, generated_at")
      .single<NewspaperRow>();

    if (error) {
      throw new Error(
        `Failed to save newspaper for week ${input.weekNumber}: ${error.message}`,
      );
    }

    return mapNewspaper(data);
  }

  async getLatestNewspaper(weekNumber: number): Promise<Newspaper | undefined> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("id, dynasty_id, week, headline, content, model, generated_at")
      .eq("dynasty_id", this.config.dynastyId)
      .eq("week", weekNumber)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle<NewspaperRow>();

    if (error) {
      throw new Error(
        `Failed to load newspaper for week ${weekNumber}: ${error.message}`,
      );
    }

    return data ? mapNewspaper(data) : undefined;
  }
}

const globalForStore = globalThis as typeof globalThis & {
  newspaperStore?: NewspaperStore;
};

/**
 * Singleton accessor for the newspaper store. Uses the Supabase-backed store
 * when service credentials are present; otherwise falls back to the in-memory
 * store so local development works without external dependencies.
 */
export function getNewspaperStore(): NewspaperStore {
  if (!globalForStore.newspaperStore) {
    const config = getLeagueConfig();

    if (hasSupabaseServiceCredentials()) {
      globalForStore.newspaperStore = new SupabaseNewspaperStore(
        config,
        getSupabaseServiceClient(),
      );
    } else {
      console.warn(
        "[newspaper-store] Supabase credentials not found; using in-memory store. " +
          "Generated newspapers will not persist across restarts.",
      );
      globalForStore.newspaperStore = new InMemoryNewspaperStore(config);
    }
  }

  return globalForStore.newspaperStore;
}
