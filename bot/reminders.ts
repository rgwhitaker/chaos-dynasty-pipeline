import type { Client } from "discord.js";
import { getStatusChannelId } from "@/bot/config";
import { logBot, logError, logWarn } from "@/bot/logger";
import { getReadyStore } from "@/bot/store/readyStore";
import { formatDeadline } from "@/bot/ui/readyMessage";

/**
 * Post a single reminder to the configured status channel mentioning every team
 * that is still **not ready** for the current week, along with the week name and
 * deadline.
 *
 * Only not-ready teams that are linked to a Discord user are mentioned, and the
 * reminder is skipped entirely when everyone is ready — so it never spams a
 * channel with an empty or all-clear ping. Best-effort: it never throws and
 * returns the number of teams that were reminded (0 when skipped).
 */
export async function sendNotReadyReminder(client: Client): Promise<number> {
  const channelId = getStatusChannelId();
  if (!channelId) {
    logWarn(
      "STATUS_CHANNEL_ID is not set; skipping the recurring not-ready reminder.",
    );
    return 0;
  }

  try {
    const store = getReadyStore();
    const summary = await store.getReadySummary();

    // Only remind teams that are both not ready and linked to a user we can ping.
    const notReady = summary.entries.filter(
      (entry) => entry.status !== "READY" && entry.team.userId,
    );

    if (notReady.length === 0) {
      // Everyone (who can be pinged) is ready — do not spam the channel.
      logBot("Recurring reminder skipped: no not-ready teams to remind.");
      return 0;
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      logWarn(
        `STATUS_CHANNEL_ID (${channelId}) is not a text channel the bot can post to.`,
      );
      return 0;
    }

    const mentions = notReady.map((entry) => `<@${entry.team.userId}>`).join(" ");
    const deadline = formatDeadline(summary.deadline);
    const deadlineLine = deadline
      ? `🗓️ Deadline: ${deadline}`
      : "🗓️ No deadline is currently set.";

    const content =
      `⏰ **Reminder — ${summary.weekName}** is waiting on ${notReady.length} team(s).\n` +
      `${mentions}\n` +
      `${deadlineLine}\n` +
      "Mark ready with `/ready` (or the buttons on `/status`) when you're done.";

    await channel.send({
      content,
      // Only ping the not-ready owners we explicitly listed.
      allowedMentions: { users: notReady.map((entry) => entry.team.userId!) },
    });

    logBot(`Sent recurring reminder to ${notReady.length} not-ready team(s).`);
    return notReady.length;
  } catch (error) {
    logError("Failed to send the recurring not-ready reminder", error);
    return 0;
  }
}
