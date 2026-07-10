import type { Client } from "discord.js";
import { logBot, logError } from "@/bot/logger";
import { sendNotReadyReminder } from "@/bot/reminders";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getBotStateStore } from "@/bot/store/botStateStore";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/bot/time";

/** How often not-ready users are reminded. */
export const REMINDER_INTERVAL_MS = 12 * MS_PER_HOUR; // 12 hours

/**
 * How often the scheduler wakes up to check whether a reminder is due. A short
 * tick (relative to the 12h cadence) keeps the reminder roughly on-time even
 * when the bot restarts, without busy-looping.
 */
export const SCHEDULER_TICK_MS = 30 * MS_PER_MINUTE; // 30 minutes

const globalForScheduler = globalThis as typeof globalThis & {
  reminderSchedulerStarted?: boolean;
  reminderSchedulerTimer?: ReturnType<typeof setInterval>;
};

/**
 * Decide whether a reminder is due and, if so, send it.
 *
 * The 12h window is anchored on the **last advance** (persisted as
 * `last_advance_at`): the first reminder for a week fires 12h after that week
 * was advanced to, and subsequent recurring reminders fire every 12h after the
 * previous reminder. We therefore anchor on the most recent of `last_advance_at`
 * and `last_reminder_at`.
 *
 * Resilience across restarts comes from persisting both timestamps in Supabase,
 * so a redeploy mid-window resumes the schedule instead of resetting it. Before
 * any advance or reminder has been recorded we only set a baseline (so a fresh
 * deploy doesn't immediately ping everyone).
 */
async function runReminderTick(client: Client): Promise<void> {
  const stateStore = getBotStateStore();
  const [lastAdvanceAt, lastReminderAt] = await Promise.all([
    stateStore.getLastAdvanceAt(),
    stateStore.getLastReminderAt(),
  ]);
  const now = Date.now();

  // Anchor on whichever happened most recently: advancing resets the window so
  // the first reminder is 12h after the advance, while a sent reminder moves the
  // window forward so reminders keep recurring every 12h.
  const anchor = mostRecentTimestamp(lastAdvanceAt, lastReminderAt);

  if (anchor === undefined) {
    // No advance or reminder recorded yet: set a baseline so the 12h window
    // starts now instead of pinging immediately on a fresh deploy.
    await stateStore.setLastReminderAt(new Date(now).toISOString());
    return;
  }

  const elapsed = now - anchor;
  if (elapsed < REMINDER_INTERVAL_MS) {
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
 * Return the most recent (largest) of the given ISO timestamps in epoch ms,
 * ignoring any that are missing or unparseable. Returns `undefined` when none
 * are usable.
 */
function mostRecentTimestamp(...isoTimes: (string | undefined)[]): number | undefined {
  const parsed = isoTimes
    .filter((iso): iso is string => Boolean(iso))
    .map((iso) => Date.parse(iso))
    .filter((ms) => !Number.isNaN(ms));

  return parsed.length > 0 ? Math.max(...parsed) : undefined;
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
    `Starting reminder scheduler (every ${REMINDER_INTERVAL_MS / MS_PER_HOUR}h, ` +
      `checked every ${SCHEDULER_TICK_MS / MS_PER_MINUTE}m).`,
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
