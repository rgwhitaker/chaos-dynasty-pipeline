import type { Client } from "discord.js";
import { fetchSendableTextChannel } from "@/bot/channels";
import { getStatusChannelId } from "@/bot/config";
import { logBot, logError, logWarn } from "@/bot/logger";
import { getBotStateStore } from "@/bot/store/botStateStore";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildStatusDashboardMessage } from "@/bot/ui/statusDashboard";

/**
 * Create or update the single persistent status-dashboard message in the
 * configured `STATUS_CHANNEL_ID` channel.
 *
 * The message id is persisted (see {@link getBotStateStore}) so the same message
 * is edited across restarts instead of posting a new one each time. This is
 * best-effort and never throws: a missing/misconfigured channel or a deleted
 * message is logged and (when possible) recovered by posting a fresh message.
 * Callers can safely fire-and-forget it after mutating readiness/week state.
 */
export async function updateStatusDashboard(client: Client): Promise<void> {
  const channelId = getStatusChannelId();
  if (!channelId) {
    // No dashboard configured — nothing to do. Callers can always invoke this.
    return;
  }

  try {
    const readyStore = getReadyStore();
    const stateStore = getBotStateStore();

    const summary = await readyStore.getReadySummary();
    const message = await buildStatusDashboardMessage(summary);

    const channel = await fetchSendableTextChannel(client, channelId);
    if (!channel) {
      logWarn(
        `STATUS_CHANNEL_ID (${channelId}) is not a text channel the bot can post to.`,
      );
      return;
    }

    // Try to edit the existing dashboard message in place.
    const existingRef = await stateStore.getStatusMessageRef();
    if (existingRef && existingRef.channelId === channelId) {
      try {
        const existing = await channel.messages.fetch(existingRef.messageId);
        await existing.edit(message);
        return;
      } catch (error) {
        // The stored message was likely deleted — fall through and repost.
        logWarn(
          `Persistent status message ${existingRef.messageId} could not be edited; reposting.`,
        );
        logError("Status dashboard edit failed", error);
        await stateStore.clearStatusMessageRef();
      }
    }

    // No usable existing message — post a new one and remember its id.
    const sent = await channel.send(message);
    await stateStore.setStatusMessageRef({ channelId, messageId: sent.id });
    logBot(`Posted persistent status dashboard message ${sent.id} to channel ${channelId}.`);
  } catch (error) {
    logError(`Failed to update the status dashboard in channel ${channelId}`, error);
  }
}
