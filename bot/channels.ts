import type { Client } from "discord.js";

/**
 * Fetch a channel by id and narrow it to a text channel the bot can both post
 * to (`send`) and read message history from (`messages`). Returns `undefined`
 * when the channel is missing or isn't a sendable text channel, so callers can
 * decide how to log/skip. Shared by the status dashboard and reminder flows so
 * the channel-type guard lives in one place.
 */
export async function fetchSendableTextChannel(client: Client, channelId: string) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    return undefined;
  }
  return channel;
}
