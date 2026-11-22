import type { Client } from "discord.js";
import { fetchSendableTextChannel } from "@/bot/channels";
import { getReminderChannelId } from "@/bot/config";
import { logBot, logError, logWarn } from "@/bot/logger";
import { getReadyStore } from "@/bot/store/readyStore";
import { getRoastStore } from "@/bot/store/roastStore";
import { formatDeadline } from "@/bot/ui/readyMessage";
import { generateRoasts, type RoastChatMessage, type RoastTarget } from "@/lib/grok/roasts";
import type { ReadySummaryEntry } from "@/lib/types";

/** Discord's hard limit on message content length. */
const DISCORD_MESSAGE_LIMIT = 2000;
/** Give up on Grok after this long so a slow API never stalls the reminder. */
const ROAST_TIMEOUT_MS = 30_000;
/** How far back to look for chat messages to feed into the roasts. */
const ROAST_CHAT_LOOKBACK_DAYS = 14;
const ROAST_CHAT_LIMIT = 25;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Bump the reminder count for every not-ready team, then rank each one against
 * the whole league (`entries` = every team in the dynasty).
 */
async function buildRoastTargets(
  notReady: ReadySummaryEntry[],
  entries: ReadySummaryEntry[],
): Promise<RoastTarget[]> {
  const store = getRoastStore();
  await store.incrementReminderCounts(notReady.map((entry) => entry.team.id));
  const stats = await store.listReminderStats();

  const counts = new Map(stats.map((stat) => [stat.teamId, stat.reminderCount]));
  const leagueCounts = entries.map((entry) => counts.get(entry.team.id) ?? 0);
  const totalReminders = leagueCounts.reduce((sum, count) => sum + count, 0);
  const others = Math.max(entries.length - 1, 1);

  return notReady.map((entry) => {
    const reminderCount = counts.get(entry.team.id) ?? 0;
    const remindedLess = leagueCounts.filter((count) => count < reminderCount).length;
    return {
      userId: entry.team.userId!,
      teamName: entry.team.name,
      abbreviation: entry.team.abbreviation,
      reminderCount,
      relativeRank: (remindedLess / others) * 100,
      totalReminders,
    };
  });
}

/** Recent chat authored by or mentioning the targets. Best-effort. */
async function loadRoastChat(userIds: string[]): Promise<RoastChatMessage[]> {
  try {
    const since = new Date(
      Date.now() - ROAST_CHAT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const messages = await getRoastStore().listRecentMessages({
      userIds,
      since,
      limit: ROAST_CHAT_LIMIT,
    });
    return messages.reverse();
  } catch (error) {
    logWarn(`Could not load recent chat for reminder roasts: ${String(error)}`);
    return [];
  }
}

/**
 * Generate roasts for the not-ready owners. Returns an empty map on any failure
 * so the caller falls back to the plain reminder.
 */
async function generateReminderRoasts(
  notReady: ReadySummaryEntry[],
  entries: ReadySummaryEntry[],
): Promise<Map<string, string>> {
  try {
    const targets = await buildRoastTargets(notReady, entries);
    const recentMessages = await loadRoastChat(targets.map((target) => target.userId));
    const roasts = await withTimeout(
      generateRoasts(targets, { leagueSize: entries.length, recentMessages }),
      ROAST_TIMEOUT_MS,
      "Roast generation",
    );

    if (roasts.size === 0) {
      logWarn("Grok returned no usable reminder roasts; posting the plain reminder.");
    } else {
      logBot(`Generated ${roasts.size}/${targets.length} reminder roast(s).`);
    }
    return roasts;
  } catch (error) {
    logError("Failed to generate reminder roasts; posting the plain reminder", error);
    return new Map();
  }
}

/**
 * Append roast lines under the plain reminder, dropping any that would push the
 * message past Discord's length limit.
 */
function appendRoasts(
  content: string,
  notReady: ReadySummaryEntry[],
  roasts: Map<string, string>,
): string {
  let result = `${content}\n\n🔥 **Roast corner**`;
  let added = 0;

  for (const entry of notReady) {
    const roast = roasts.get(entry.team.userId!);
    if (!roast) {
      continue;
    }
    const line = `\n• <@${entry.team.userId}> — ${roast}`;
    if (result.length + line.length > DISCORD_MESSAGE_LIMIT) {
      break;
    }
    result += line;
    added += 1;
  }

  return added > 0 ? result : content;
}

/**
 * Post a single reminder to the configured reminder channel mentioning every
 * team that is still **not ready** for the current week, along with the week
 * name and deadline. When Grok is available, each not-ready owner also gets a
 * unique NSFW roast (seeded with how often they've been reminded relative to the
 * league); any roast failure falls back to the plain reminder.
 *
 * Only not-ready teams that are linked to a Discord user are mentioned, and the
 * reminder is skipped entirely when everyone is ready — so it never spams a
 * channel with an empty or all-clear ping. Best-effort: it never throws and
 * returns the number of teams that were reminded (0 when skipped).
 */
export async function sendNotReadyReminder(client: Client): Promise<number> {
  const channelId = getReminderChannelId();
  if (!channelId) {
    logWarn(
      "REMINDER_CHANNEL_ID, ANNOUNCE_CHANNEL_ID, and STATUS_CHANNEL_ID are all unset; skipping the recurring not-ready reminder.",
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

    const channel = await fetchSendableTextChannel(client, channelId);
    if (!channel) {
      logWarn(
        `Reminder channel (${channelId}) is not a text channel the bot can post to.`,
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

    // Only ping the not-ready owners we explicitly listed.
    const allowedMentions = { users: notReady.map((entry) => entry.team.userId!) };

    const roasts = await generateReminderRoasts(notReady, summary.entries);
    const roastedContent = appendRoasts(content, notReady, roasts);

    try {
      await channel.send({ content: roastedContent, allowedMentions });
    } catch (error) {
      if (roastedContent === content) {
        throw error;
      }
      logError("Failed to send roasted reminder; retrying with the plain reminder", error);
      await channel.send({ content, allowedMentions });
    }

    logBot(`Sent recurring reminder to ${notReady.length} not-ready team(s).`);
    return notReady.length;
  } catch (error) {
    logError("Failed to send the recurring not-ready reminder", error);
    return 0;
  }
}
