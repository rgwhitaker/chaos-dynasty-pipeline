import type { Client, MessageCreateOptions } from "discord.js";
import { fetchSendableTextChannel } from "@/bot/channels";
import { getAnnounceChannelId, getLeagueConfig, getStatusChannelId } from "@/bot/config";
import { logError } from "@/bot/logger";
import { getBotStateStore } from "@/bot/store/botStateStore";
import { getReadyStore } from "@/bot/store/readyStore";

/**
 * Resolve the channel the "everyone is ready" commissioner ping should be posted
 * to: the configured announce channel first, otherwise the status-dashboard
 * channel. Returns `undefined` when neither is configured or reachable.
 */
async function resolveNotifyChannel(client: Client) {
  const channelId = getAnnounceChannelId() ?? getStatusChannelId();
  if (!channelId) {
    return undefined;
  }
  return fetchSendableTextChannel(client, channelId);
}

/**
 * Notify the commissioners, in the announce channel, the moment **every** team
 * is marked ready for the current week — so they know to jump into the video
 * game and advance the week even though no one has run `/advance` yet.
 *
 * Call this after any readiness change (`/ready`, the ready buttons, or
 * `/set-ready`). It is:
 *  - **Deduplicated**: the ping fires only once per week. The week it last
 *    pinged for is persisted in `bot_state.all_ready_notified_week`. If a team
 *    later un-readies (so not everyone is ready anymore), that marker is cleared
 *    so a fresh all-ready state pings again.
 *  - **Gated**: it needs a commissioner role to tag (`DISCORD_COMMISSIONER_ROLE_ID`)
 *    and a channel to post to (`ANNOUNCE_CHANNEL_ID`, falling back to
 *    `STATUS_CHANNEL_ID`). When either is missing it quietly does nothing.
 *  - **Best-effort**: it logs and swallows all errors so a failed ping never
 *    breaks the readiness command that triggered it.
 */
export async function notifyCommissionersIfEveryoneReady(client: Client): Promise<void> {
  try {
    const config = getLeagueConfig();
    // Without a role to tag there is nobody to ping.
    if (!config.commissionerRoleId) {
      return;
    }

    const store = getReadyStore();
    const summary = await store.getReadySummary();
    const everyoneReady =
      summary.totalCount > 0 && summary.readyCount === summary.totalCount;

    const botState = getBotStateStore();
    const notifiedWeek = await botState.getAllReadyNotifiedWeek();

    if (!everyoneReady) {
      // Reset the marker so that re-reaching an all-ready state pings again.
      if (notifiedWeek === summary.weekNumber) {
        await botState.setAllReadyNotifiedWeek(null);
      }
      return;
    }

    // Everyone is ready. Ping once per week only.
    if (notifiedWeek === summary.weekNumber) {
      return;
    }

    const channel = await resolveNotifyChannel(client);
    if (!channel) {
      logError(
        "All-ready commissioner ping skipped: no announce/status channel is configured.",
      );
      return;
    }

    await channel.send({
      content:
        `<@&${config.commissionerRoleId}> ✅ Every team is marked ready for ` +
        `**${summary.weekName}** — time to advance the week in-game.`,
      allowedMentions: { roles: [config.commissionerRoleId] },
    } as MessageCreateOptions);

    // Remember we pinged for this week so we don't spam on further changes.
    await botState.setAllReadyNotifiedWeek(summary.weekNumber);
  } catch (error) {
    logError("Failed to notify commissioners that every team is ready", error);
  }
}
