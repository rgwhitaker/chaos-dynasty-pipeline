import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";

/** How many not-ready reminders a team has been pinged in. */
export interface ReminderStat {
  teamId: string;
  reminderCount: number;
  lastRemindedAt?: string;
}

/** A captured Discord message used as roast material. */
export interface LoggedDiscordMessage {
  id: string;
  guildId?: string;
  channelId: string;
  authorId: string;
  authorName?: string;
  content: string;
  mentionedUserIds: string[];
  createdAt: string;
}

/** Filter for {@link RoastStore.listRecentMessages}. */
export interface RecentMessagesQuery {
  /** Only messages authored by, or mentioning, one of these users. */
  userIds: string[];
  /** Only messages created at or after this ISO timestamp. */
  since: string;
  limit: number;
}

/**
 * Storage for the not-ready reminder roasts: per-team reminder counts and a
 * rolling log of recent Discord chat. Mirrors the other bot stores — async
 * methods so the in-memory fallback and Supabase implementation are swappable.
 */
export interface RoastStore {
  /** Reminder counts for every team that has ever been reminded. */
  listReminderStats(): Promise<ReminderStat[]>;
  /** Add one reminder to each team and return the updated stats for them. */
  incrementReminderCounts(teamIds: string[]): Promise<ReminderStat[]>;
  /** Persist a captured message (idempotent on message id). */
  saveMessage(message: LoggedDiscordMessage): Promise<void>;
  /** Recent messages authored by or mentioning the given users, newest first. */
  listRecentMessages(query: RecentMessagesQuery): Promise<LoggedDiscordMessage[]>;
  /** Delete messages older than `before` (ISO timestamp). */
  pruneMessagesBefore(before: string): Promise<void>;
}

const STATS_TABLE = "reminder_stats";
const MESSAGES_TABLE = "discord_messages";

interface ReminderStatRow {
  team_id: string;
  reminder_count: number;
  last_reminded_at: string | null;
}

interface DiscordMessageRow {
  id: string;
  guild_id: string | null;
  channel_id: string;
  author_id: string;
  author_name: string | null;
  content: string;
  mentioned_user_ids: string[] | null;
  created_at: string;
}

function mapStat(row: ReminderStatRow): ReminderStat {
  return {
    teamId: row.team_id,
    reminderCount: row.reminder_count,
    lastRemindedAt: row.last_reminded_at ?? undefined,
  };
}

function mapMessage(row: DiscordMessageRow): LoggedDiscordMessage {
  return {
    id: row.id,
    guildId: row.guild_id ?? undefined,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorName: row.author_name ?? undefined,
    content: row.content,
    mentionedUserIds: row.mentioned_user_ids ?? [],
    createdAt: row.created_at,
  };
}

/** In-memory fallback used when Supabase credentials are absent. */
export class InMemoryRoastStore implements RoastStore {
  private readonly stats = new Map<string, ReminderStat>();
  private messages: LoggedDiscordMessage[] = [];

  async listReminderStats(): Promise<ReminderStat[]> {
    return [...this.stats.values()].map((stat) => ({ ...stat }));
  }

  async incrementReminderCounts(teamIds: string[]): Promise<ReminderStat[]> {
    const now = new Date().toISOString();
    return [...new Set(teamIds)].map((teamId) => {
      const next: ReminderStat = {
        teamId,
        reminderCount: (this.stats.get(teamId)?.reminderCount ?? 0) + 1,
        lastRemindedAt: now,
      };
      this.stats.set(teamId, next);
      return { ...next };
    });
  }

  async saveMessage(message: LoggedDiscordMessage): Promise<void> {
    this.messages = this.messages.filter((existing) => existing.id !== message.id);
    this.messages.push({ ...message });
  }

  async listRecentMessages(query: RecentMessagesQuery): Promise<LoggedDiscordMessage[]> {
    const users = new Set(query.userIds);
    return this.messages
      .filter(
        (message) =>
          message.createdAt >= query.since &&
          (users.has(message.authorId) ||
            message.mentionedUserIds.some((id) => users.has(id))),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit)
      .map((message) => ({ ...message }));
  }

  async pruneMessagesBefore(before: string): Promise<void> {
    this.messages = this.messages.filter((message) => message.createdAt >= before);
  }
}

/** Supabase-backed store using the `reminder_stats` and `discord_messages` tables. */
export class SupabaseRoastStore implements RoastStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async listReminderStats(): Promise<ReminderStat[]> {
    const { data, error } = await this.client
      .from(STATS_TABLE)
      .select("team_id, reminder_count, last_reminded_at")
      .returns<ReminderStatRow[]>();

    if (error) {
      throw new Error(`Failed to load reminder stats: ${error.message}`);
    }

    return (data ?? []).map(mapStat);
  }

  async incrementReminderCounts(teamIds: string[]): Promise<ReminderStat[]> {
    const ids = [...new Set(teamIds)];
    if (ids.length === 0) {
      return [];
    }

    const { data: existing, error: loadError } = await this.client
      .from(STATS_TABLE)
      .select("team_id, reminder_count, last_reminded_at")
      .in("team_id", ids)
      .returns<ReminderStatRow[]>();

    if (loadError) {
      throw new Error(`Failed to load reminder stats: ${loadError.message}`);
    }

    // Read-then-upsert is fine here: reminders are posted by a single bot
    // process on a 12h cadence, so there are no concurrent writers.
    const counts = new Map((existing ?? []).map((row) => [row.team_id, row.reminder_count]));
    const now = new Date().toISOString();
    const rows = ids.map((teamId) => ({
      team_id: teamId,
      reminder_count: (counts.get(teamId) ?? 0) + 1,
      last_reminded_at: now,
      updated_at: now,
    }));

    const { data, error } = await this.client
      .from(STATS_TABLE)
      .upsert(rows, { onConflict: "team_id" })
      .select("team_id, reminder_count, last_reminded_at")
      .returns<ReminderStatRow[]>();

    if (error) {
      throw new Error(`Failed to increment reminder stats: ${error.message}`);
    }

    return (data ?? []).map(mapStat);
  }

  async saveMessage(message: LoggedDiscordMessage): Promise<void> {
    const row: DiscordMessageRow = {
      id: message.id,
      guild_id: message.guildId ?? null,
      channel_id: message.channelId,
      author_id: message.authorId,
      author_name: message.authorName ?? null,
      content: message.content,
      mentioned_user_ids: message.mentionedUserIds,
      created_at: message.createdAt,
    };

    const { error } = await this.client
      .from(MESSAGES_TABLE)
      .upsert(row, { onConflict: "id" });

    if (error) {
      throw new Error(`Failed to save Discord message ${message.id}: ${error.message}`);
    }
  }

  async listRecentMessages(query: RecentMessagesQuery): Promise<LoggedDiscordMessage[]> {
    const userIds = query.userIds.filter((id) => /^\d+$/.test(id));
    if (userIds.length === 0) {
      return [];
    }

    const idList = userIds.join(",");
    const { data, error } = await this.client
      .from(MESSAGES_TABLE)
      .select(
        "id, guild_id, channel_id, author_id, author_name, content, mentioned_user_ids, created_at",
      )
      .gte("created_at", query.since)
      .or(`author_id.in.(${idList}),mentioned_user_ids.ov.{${idList}}`)
      .order("created_at", { ascending: false })
      .limit(query.limit)
      .returns<DiscordMessageRow[]>();

    if (error) {
      throw new Error(`Failed to load recent Discord messages: ${error.message}`);
    }

    return (data ?? []).map(mapMessage);
  }

  async pruneMessagesBefore(before: string): Promise<void> {
    const { error } = await this.client
      .from(MESSAGES_TABLE)
      .delete()
      .lt("created_at", before);

    if (error) {
      throw new Error(`Failed to prune Discord messages: ${error.message}`);
    }
  }
}

const globalForStore = globalThis as typeof globalThis & {
  roastStore?: RoastStore;
};

/**
 * Singleton accessor for the roast store. Uses Supabase when service
 * credentials are present; otherwise an in-memory store (resets on restart).
 */
export function getRoastStore(): RoastStore {
  if (!globalForStore.roastStore) {
    if (hasSupabaseServiceCredentials()) {
      globalForStore.roastStore = new SupabaseRoastStore(getSupabaseServiceClient());
    } else {
      console.warn(
        "[roast-store] Supabase credentials not found; using in-memory store. " +
          "Reminder counts and logged messages will not persist across restarts.",
      );
      globalForStore.roastStore = new InMemoryRoastStore();
    }
  }

  return globalForStore.roastStore;
}
