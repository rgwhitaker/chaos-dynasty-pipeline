import type { Message } from "discord.js";
import { getGuildId } from "@/bot/config";
import { logError } from "@/bot/logger";
import { getRoastStore } from "@/bot/store/roastStore";

/**
 * Rolling log of recent guild chat, used as extra material for the not-ready
 * reminder roasts. Only messages seen live by the `messageCreate` listener are
 * captured — there is intentionally no historical backfill (Discord rate limits
 * and channel permissions make a bulk scrape impractical). Bot messages and
 * DMs are skipped, and rows older than {@link MESSAGE_RETENTION_DAYS} are
 * pruned automatically.
 */

export const MESSAGE_RETENTION_DAYS = 30;
const MAX_STORED_CONTENT_LENGTH = 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const globalForMessageLog = globalThis as typeof globalThis & {
  messageLogLastPruneAt?: number;
};

/** ISO timestamp marking the start of the retention window. */
export function messageRetentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function pruneIfDue(): Promise<void> {
  const now = Date.now();
  const last = globalForMessageLog.messageLogLastPruneAt ?? 0;
  if (now - last < PRUNE_INTERVAL_MS) {
    return;
  }
  globalForMessageLog.messageLogLastPruneAt = now;
  await getRoastStore().pruneMessagesBefore(messageRetentionCutoff());
}

/** `messageCreate` handler. Never throws. */
export async function logDiscordMessage(message: Message): Promise<void> {
  if (message.author.bot || message.system || !message.inGuild()) {
    return;
  }

  const guildId = getGuildId();
  if (guildId && message.guildId !== guildId) {
    return;
  }

  const content = message.content.trim();
  if (!content) {
    return;
  }

  try {
    await getRoastStore().saveMessage({
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.username,
      content: content.slice(0, MAX_STORED_CONTENT_LENGTH),
      mentionedUserIds: [...message.mentions.users.keys()],
      createdAt: message.createdAt.toISOString(),
    });
    await pruneIfDue();
  } catch (error) {
    logError(`Failed to log Discord message ${message.id}`, error);
  }
}
