import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { generateAndPostNewspaper } from "@/bot/newspaper";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage } from "@/bot/ui/readyMessage";

/**
 * `/advance` — advance the league to the next week once enough teams are ready.
 * Restricted to commissioners (configured role or Manage Server permission).
 */
export const advanceCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("advance")
    .setDescription("Advance the league to the next week (commissioners only)."),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    // Permission check: commissioners only.
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can advance the week.",
        ephemeral: true,
      });
      return;
    }

    // Defer the public reply so advancing (which touches the store) stays within
    // Discord's response window.
    await interaction.deferReply();

    try {
      const store = getReadyStore();
      const result = await store.advanceWeek();

      if (!result.advanced) {
        const { summary } = result;
        const message = await buildReadyStatusMessage(summary);
        await interaction.editReply({
          content:
            `Not enough teams are ready to advance Week ${summary.weekNumber} ` +
            `(${summary.readyCount}/${summary.requiredCount}).`,
          ...message,
        });
        return;
      }

      const message = await buildReadyStatusMessage(result.summary);
      await interaction.editReply({
        content:
          `Advanced from Week ${result.previousWeek} to **Week ${result.currentWeek}**! ` +
          "Ready statuses have been reset.",
        ...message,
      });

      // Generate and post the Weekly Newspaper for the week that just ended.
      // This runs after the advance reply so a slow Grok call (or a newspaper
      // failure) never blocks or breaks the core advance flow.
      await publishWeeklyNewspaper(interaction, result.previousWeek);
    } catch (error) {
      console.error("[advance] Failed to advance the week", error);
      await interaction.editReply({
        content: "Sorry, I couldn't advance the week right now. Please try again shortly.",
      });
    }
  },
};

/**
 * Generate + post the Weekly Newspaper for the week that just ended, then send a
 * short ephemeral follow-up letting the commissioner know how it went. All
 * failures are caught here so the (already-successful) advance is never undone.
 */
async function publishWeeklyNewspaper(
  interaction: ChatInputCommandInteraction,
  weekNumber: number,
): Promise<void> {
  try {
    const result = await generateAndPostNewspaper(interaction.client, weekNumber);
    const note = result.posted
      ? `📰 Weekly Newspaper for Week ${weekNumber} posted to <#${result.channelId}>.`
      : `📰 Weekly Newspaper for Week ${weekNumber} generated, but not posted ` +
        "(set `NEWSPAPER_CHANNEL_ID` to enable posting).";
    await interaction.followUp({ content: note, ephemeral: true });
  } catch (error) {
    console.error("[advance] Failed to generate the weekly newspaper", error);
    try {
      await interaction.followUp({
        content:
          `Week ${weekNumber} advanced, but I couldn't generate the Weekly ` +
          "Newspaper. You can retry with `/newspaper`.",
        ephemeral: true,
      });
    } catch (followUpError) {
      console.error("[advance] Failed to send newspaper follow-up", followUpError);
    }
  }
}
