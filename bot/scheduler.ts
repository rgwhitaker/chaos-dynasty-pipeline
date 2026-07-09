import type { Client } from "discord.js";
import { logBot, logError } from "@/bot/logger";
import { sendNotReadyReminder } from "@/bot/reminders";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getBotStateStore } from "@/bot/store/botStateStore";

/** How often not-ready users are reminded. */
export const REMINDER_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * How often the scheduler wakes up to check whether a reminder is due. A short
 * tick (relative to the 12h cadence) keeps the reminder roughly on-time even
 * when the bot restarts, without busy-looping.
 */
export const SCHEDULER_TICK_MS = 30 * 60 * 1000; // 30 minutes

const globalForScheduler = globalThis as typeof globalThis & {
  reminderSchedulerStarted?: boolean;
  reminderSchedulerTimer?: ReturnType<typeof setInterval>;
};

/**
 * Decide whether a reminder is due and, if so, send it. Resilience across
 * restarts comes from persisting `last_reminder_at`: on the very first run we
 * only record a baseline (so a fresh deploy doesn't immediately ping everyone),
 * and on subsequent ticks we compare against the persisted timestamp — which is
 * unaffected by restarts when Supabase is configured.
 */
async function runReminderTick(client: Client): Promise<void> {
  const stateStore = getBotStateStore();
  const lastReminderAt = await stateStore.getLastReminderAt();
  const now = Date.now();

  if (!lastReminderAt) {
    // First ever run: set a baseline so the 12h window starts now.
    await stateStore.setLastReminderAt(new Date(now).toISOString());
    return;
  }

  const elapsed = now - Date.parse(lastReminderAt);
  if (Number.isNaN(elapsed) || elapsed < REMINDER_INTERVAL_MS) {
    return;
  }

  await sendNotReadyReminder(client);
  // Record the send time even if there was nothing to remind, so the cadence
  // stays on a clean 12h schedule instead of retrying every tick.
  await stateStore.setLastReminderAt(new Date(now).toISOString());
  // Refresh the dashboard so its state matches the reminder that just went out.
  await updateStatusDashboard(client);
}

/**
 * Start the background scheduler that drives the recurring not-ready reminder
 * and keeps the persistent status dashboard alive. Idempotent: guarded by a
 * global flag so it is only started once per process (surviving hot reloads).
 *
 * Called from the Discord client's `ClientReady` handler once the gateway
 * connection is live.
 */
export function startScheduler(client: Client): void {
  if (globalForScheduler.reminderSchedulerStarted) {
    return;
  }
  globalForScheduler.reminderSchedulerStarted = true;

  logBot(
    `Starting reminder scheduler (every ${REMINDER_INTERVAL_MS / 3_600_000}h, ` +
      `checked every ${SCHEDULER_TICK_MS / 60_000}m).`,
  );

  // Ensure the dashboard exists/refreshes on boot (e.g. after a restart), then
  // run one reminder check immediately so an overdue reminder isn't delayed a
  // full tick.
  void updateStatusDashboard(client).catch((error) =>
    logError("Initial status dashboard update failed", error),
  );
  void runReminderTick(client).catch((error) =>
    logError("Initial reminder tick failed", error),
  );

  const timer = setInterval(() => {
    void runReminderTick(client).catch((error) =>
      logError("Reminder tick failed", error),
    );
  }, SCHEDULER_TICK_MS);

  // Don't keep the event loop alive solely for this timer.
  timer.unref?.();
  globalForScheduler.reminderSchedulerTimer = timer;
}
