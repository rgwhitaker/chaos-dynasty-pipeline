import type { Client } from "discord.js";
import { getLeagueConfig, getNewspaperChannelId } from "@/bot/config";
import { logBot, logError, logWarn } from "@/bot/logger";
import { getNewspaperStore } from "@/bot/store/newspaperStore";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildNewspaperEmbed } from "@/bot/ui/newspaperMessage";
import { generateNewspaper } from "@/lib/grok/newspaper";
import type { Newspaper } from "@/lib/types";

/** Outcome of a newspaper run: the stored record plus whether it was posted. */
export interface NewspaperRunResult {
  newspaper: Newspaper;
  /** True when the embed was posted to the configured Discord channel. */
  posted: boolean;
  /** The channel id it was (or would have been) posted to, when configured. */
  channelId?: string;
}

/**
 * Generate a Weekly Newspaper for `weekNumber`, persist it, and post it to the
 * configured Discord channel.
 *
 * Generation and storage always happen (even without a channel configured) so
 * the newspaper is never lost. Posting is best-effort: a missing/invalid channel
 * is logged as a warning rather than throwing, so callers like `/advance` keep
 * working even if the newspaper can't be delivered.
 */
export async function generateAndPostNewspaper(
  client: Client,
  weekNumber: number,
): Promise<NewspaperRunResult> {
  const config = getLeagueConfig();
  const readyStore = getReadyStore();
  const newspaperStore = getNewspaperStore();

  const teams = await readyStore.listTeams();

  logBot(`Generating Weekly Newspaper for Week ${weekNumber}...`);
  const generated = await generateNewspaper({
    dynastyId: config.dynastyId,
    weekNumber,
    teams: teams.map((team) => ({
      name: team.name,
      abbreviation: team.abbreviation,
    })),
  });

  const newspaper = await newspaperStore.saveNewspaper({
    weekNumber,
    content: generated.content,
    model: generated.model,
  });

  const posted = await postNewspaperToChannel(client, newspaper);
  return { newspaper, posted, channelId: getNewspaperChannelId() };
}

/**
 * Post an already-generated newspaper embed to the configured channel. Returns
 * whether the post succeeded. Never throws.
 */
async function postNewspaperToChannel(
  client: Client,
  newspaper: Newspaper,
): Promise<boolean> {
  const channelId = getNewspaperChannelId();
  if (!channelId) {
    logWarn(
      "NEWSPAPER_CHANNEL_ID is not set; the newspaper was generated and stored " +
        "but not posted to a channel.",
    );
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      logWarn(
        `NEWSPAPER_CHANNEL_ID (${channelId}) is not a text channel the bot can post to.`,
      );
      return false;
    }

    const embed = await buildNewspaperEmbed(newspaper);
    await channel.send({ embeds: [embed] });
    logBot(`Posted Week ${newspaper.weekNumber} newspaper to channel ${channelId}.`);
    return true;
  } catch (error) {
    logError(`Failed to post newspaper to channel ${channelId}`, error);
    return false;
  }
}
