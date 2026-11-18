import { getLeagueConfig } from "@/bot/config";
import {
  getSupabaseServiceClient,
  hasSupabaseServiceCredentials,
} from "@/lib/supabase/service";

export interface ReminderMember {
  userId: string;
  username: string;
  name: string;
  team: string;
}

export interface ReminderHistory {
  week: number;
  members: ReminderMember[];
  roast: string;
}

interface ReminderHistoryStore {
  recent(): Promise<ReminderHistory[]>;
  save(reminder: ReminderHistory): Promise<void>;
}

const globalForHistory = globalThis as typeof globalThis & {
  reminderHistoryStore?: ReminderHistoryStore;
};

export function getReminderHistoryStore(): ReminderHistoryStore {
  if (!globalForHistory.reminderHistoryStore) {
    if (hasSupabaseServiceCredentials()) {
      const client = getSupabaseServiceClient();
      const dynastyId = getLeagueConfig().dynastyId;
      globalForHistory.reminderHistoryStore = {
        async recent() {
          const { data, error } = await client
            .from("reminder_history")
            .select("week, members, roast")
            .eq("dynasty_id", dynastyId)
            .order("created_at", { ascending: false })
            .limit(20);
          if (error) throw new Error(`Failed to load reminder history: ${error.message}`);
          return data as ReminderHistory[];
        },
        async save(reminder) {
          const { error } = await client
            .from("reminder_history")
            .insert({ dynasty_id: dynastyId, ...reminder });
          if (error) throw new Error(`Failed to save reminder history: ${error.message}`);
        },
      };
    } else {
      const reminders: ReminderHistory[] = [];
      logMemoryWarning();
      globalForHistory.reminderHistoryStore = {
        async recent() {
          return reminders.slice(-20).reverse();
        },
        async save(reminder) {
          reminders.push(reminder);
        },
      };
    }
  }
  return globalForHistory.reminderHistoryStore;
}

function logMemoryWarning(): void {
  console.warn(
    "[reminder-history] Supabase credentials not found; reminder history will not persist across restarts.",
  );
}
