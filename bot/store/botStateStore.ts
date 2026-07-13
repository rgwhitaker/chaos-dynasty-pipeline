import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeagueConfig } from "@/bot/config";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";
import type { LeagueConfig } from "@/lib/types";

/**
 * Reference to the single persistent status-dashboard message so it can be
 * edited across restarts instead of posting a new message every time.
 */
export interface StatusMessageRef {
  channelId: string;
  messageId: string;
}

/**
 * Storage contract for small pieces of bot runtime state that must survive
 * restarts: the id of the persistent status message and the last time the
 * recurring reminder ran. Mirrors the {@link import("./readyStore").ReadyStore}
 * design so the Supabase-backed implementation can be swapped for the in-memory
 * one without touching callers.
 */
export interface BotStateStore {
  /** The persistent status-dashboard message reference, if one has been posted. */
  getStatusMessageRef(): Promise<StatusMessageRef | undefined>;
  /** Record the persistent status-dashboard message reference. */
  setStatusMessageRef(ref: StatusMessageRef): Promise<void>;
  /** Forget the persistent status-dashboard message (e.g. it was deleted). */
  clearStatusMessageRef(): Promise<void>;

  /** ISO timestamp of the last week advance, if one has happened. */
  getLastAdvanceAt(): Promise<string | undefined>;
  /** Record when the week was last advanced (anchors the reminder window). */
  setLastAdvanceAt(iso: string): Promise<void>;

  /** ISO timestamp of the last recurring reminder, if one has run. */
  getLastReminderAt(): Promise<string | undefined>;
  /** Record when the recurring reminder last ran. */
  setLastReminderAt(iso: string): Promise<void>;

  /**
   * The week number (0-based schedule index) for which the commissioners were
   * last pinged that every team is ready, if any. Used to fire that ping only
   * once per week.
   */
  getAllReadyNotifiedWeek(): Promise<number | undefined>;
  /**
   * Record the week for which the "everyone is ready" commissioner ping was
   * sent. Pass `null` to clear it (e.g. when a team un-readies again).
   */
  setAllReadyNotifiedWeek(weekNumber: number | null): Promise<void>;

  /**
   * The persisted Microsoft Graph delta link for the OneDrive monitor, if the
   * folder has been polled at least once. Resuming from this link means the
   * poller only fetches changes since the last run.
   */
  getOnedriveDeltaLink(): Promise<string | undefined>;
  /**
   * Record the latest Microsoft Graph delta link. Pass `null` to clear it (e.g.
   * to force a full re-scan on the next poll).
   */
  setOnedriveDeltaLink(deltaLink: string | null): Promise<void>;
}

const TABLE = "bot_state";

/** Row shape for the `bot_state` table (one row per dynasty). */
interface BotStateRow {
  dynasty_id: string;
  status_channel_id: string | null;
  status_message_id: string | null;
  last_advance_at: string | null;
  last_reminder_at: string | null;
  all_ready_notified_week: number | null;
  onedrive_delta_link: string | null;
}

const BOT_STATE_COLUMNS =
  "dynasty_id, status_channel_id, status_message_id, last_advance_at, last_reminder_at, all_ready_notified_week, onedrive_delta_link";

/**
 * In-memory bot-state store used when Supabase credentials are absent. State
 * lives for the lifetime of the process only, so the persistent dashboard and
 * reminder cadence reset on restart (Supabase is required for true resilience).
 */
export class InMemoryBotStateStore implements BotStateStore {
  private statusMessageRef?: StatusMessageRef;
  private lastAdvanceAt?: string;
  private lastReminderAt?: string;
  private allReadyNotifiedWeek?: number;
  private onedriveDeltaLink?: string;

  async getStatusMessageRef(): Promise<StatusMessageRef | undefined> {
    return this.statusMessageRef ? { ...this.statusMessageRef } : undefined;
  }

  async setStatusMessageRef(ref: StatusMessageRef): Promise<void> {
    this.statusMessageRef = { ...ref };
  }

  async clearStatusMessageRef(): Promise<void> {
    this.statusMessageRef = undefined;
  }

  async getLastAdvanceAt(): Promise<string | undefined> {
    return this.lastAdvanceAt;
  }

  async setLastAdvanceAt(iso: string): Promise<void> {
    this.lastAdvanceAt = iso;
  }

  async getLastReminderAt(): Promise<string | undefined> {
    return this.lastReminderAt;
  }

  async setLastReminderAt(iso: string): Promise<void> {
    this.lastReminderAt = iso;
  }

  async getAllReadyNotifiedWeek(): Promise<number | undefined> {
    return this.allReadyNotifiedWeek;
  }

  async setAllReadyNotifiedWeek(weekNumber: number | null): Promise<void> {
    this.allReadyNotifiedWeek = weekNumber ?? undefined;
  }

  async getOnedriveDeltaLink(): Promise<string | undefined> {
    return this.onedriveDeltaLink;
  }

  async setOnedriveDeltaLink(deltaLink: string | null): Promise<void> {
    this.onedriveDeltaLink = deltaLink ?? undefined;
  }
}

/** Supabase-backed bot-state store persisting to the `bot_state` table. */
export class SupabaseBotStateStore implements BotStateStore {
  private readonly config: LeagueConfig;
  private readonly client: SupabaseClient;

  constructor(config: LeagueConfig, client: SupabaseClient) {
    this.config = config;
    this.client = client;
  }

  private async fetchRow(): Promise<BotStateRow | undefined> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(BOT_STATE_COLUMNS)
      .eq("dynasty_id", this.config.dynastyId)
      .maybeSingle<BotStateRow>();

    if (error) {
      throw new Error(`Failed to load bot state: ${error.message}`);
    }

    return data ?? undefined;
  }

  private async upsert(patch: Partial<Omit<BotStateRow, "dynasty_id">>): Promise<void> {
    const row = { dynasty_id: this.config.dynastyId, ...patch };
    const { error } = await this.client
      .from(TABLE)
      .upsert(row, { onConflict: "dynasty_id" });

    if (error) {
      throw new Error(`Failed to save bot state: ${error.message}`);
    }
  }

  async getStatusMessageRef(): Promise<StatusMessageRef | undefined> {
    const row = await this.fetchRow();
    if (!row?.status_channel_id || !row.status_message_id) {
      return undefined;
    }
    return {
      channelId: row.status_channel_id,
      messageId: row.status_message_id,
    };
  }

  async setStatusMessageRef(ref: StatusMessageRef): Promise<void> {
    await this.upsert({
      status_channel_id: ref.channelId,
      status_message_id: ref.messageId,
    });
  }

  async clearStatusMessageRef(): Promise<void> {
    await this.upsert({ status_channel_id: null, status_message_id: null });
  }

  async getLastAdvanceAt(): Promise<string | undefined> {
    const row = await this.fetchRow();
    return row?.last_advance_at ?? undefined;
  }

  async setLastAdvanceAt(iso: string): Promise<void> {
    await this.upsert({ last_advance_at: iso });
  }

  async getLastReminderAt(): Promise<string | undefined> {
    const row = await this.fetchRow();
    return row?.last_reminder_at ?? undefined;
  }

  async setLastReminderAt(iso: string): Promise<void> {
    await this.upsert({ last_reminder_at: iso });
  }

  async getAllReadyNotifiedWeek(): Promise<number | undefined> {
    const row = await this.fetchRow();
    return row?.all_ready_notified_week ?? undefined;
  }

  async setAllReadyNotifiedWeek(weekNumber: number | null): Promise<void> {
    await this.upsert({ all_ready_notified_week: weekNumber });
  }

  async getOnedriveDeltaLink(): Promise<string | undefined> {
    const row = await this.fetchRow();
    return row?.onedrive_delta_link ?? undefined;
  }

  async setOnedriveDeltaLink(deltaLink: string | null): Promise<void> {
    await this.upsert({ onedrive_delta_link: deltaLink });
  }
}

const globalForStore = globalThis as typeof globalThis & {
  botStateStore?: BotStateStore;
};

/**
 * Singleton accessor for the bot-state store. Uses the Supabase-backed store
 * when service credentials are present; otherwise falls back to the in-memory
 * store so local development works without external dependencies.
 */
export function getBotStateStore(): BotStateStore {
  if (!globalForStore.botStateStore) {
    const config = getLeagueConfig();

    if (hasSupabaseServiceCredentials()) {
      globalForStore.botStateStore = new SupabaseBotStateStore(
        config,
        getSupabaseServiceClient(),
      );
    } else {
      console.warn(
        "[bot-state-store] Supabase credentials not found; using in-memory store. " +
          "The persistent status message and reminder cadence will reset on restart.",
      );
      globalForStore.botStateStore = new InMemoryBotStateStore();
    }
  }

  return globalForStore.botStateStore;
}
