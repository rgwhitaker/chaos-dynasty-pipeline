import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { generateAndPostNewspaper } from "@/bot/newspaper";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage, formatDeadline } from "@/bot/ui/readyMessage";

/** Bounds for the optional deadline override (in hours). */
const MIN_DEADLINE_HOURS = 1;
const MAX_DEADLINE_HOURS = 720; // 30 days

/**
 * `/advance` — advance the league to the next week once enough teams are ready.
 * Restricted to commissioners (configured role or Manage Server permission).
 *
 * An optional `deadline_hours` overrides the automatically-calculated deadline
 * window for the new week (e.g. force 24h even on a 48h game week).
 */
export const advanceCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("advance")
    .setDescription("Advance the league to the next week (commissioners only).")
    .addIntegerOption((option) =>
      option
        .setName("deadline_hours")
        .setDescription(
          "Override the new week's deadline window, in hours (default: 48 game weeks / 24 otherwise).",
        )
        .setMinValue(MIN_DEADLINE_HOURS)
        .setMaxValue(MAX_DEADLINE_HOURS),
    )
    .addBooleanOption((option) =>
      option
        .setName("force")
        .setDescription(
          "Advance even if not enough teams are marked ready (e.g. ready in-game or past deadline).",
        ),
    ),

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

    const deadlineOverrideHours =
      interaction.options.getInteger("deadline_hours") ?? undefined;
    const force = interaction.options.getBoolean("force") ?? false;

    // Defer the public reply so advancing (which touches the store) stays within
    // Discord's response window.
    await interaction.deferReply();

    try {
      const store = getReadyStore();
      const result = await store.advanceWeek({ deadlineOverrideHours, force });

      if (!result.advanced) {
        // Already at the end of the schedule — there is nowhere left to go.
        if (result.atLastWeek) {
          const message = await buildReadyStatusMessage(result.summary);
          await interaction.editReply({
            content:
              `**${result.previousWeekName}** is the final week of the season — ` +
              "there is nothing left to advance to. Use `/set-week` to jump to " +
              "another week if you need to reset the schedule.",
            ...message,
          });
          return;
        }

        const { summary } = result;
        const message = await buildReadyStatusMessage(summary);
        await interaction.editReply({
          content:
            `Not enough teams are ready to advance ${summary.weekName} ` +
            `(${summary.readyCount}/${summary.requiredCount}). ` +
            "Re-run with `force: true` to advance anyway.",
          ...message,
        });
        return;
      }

      const message = await buildReadyStatusMessage(result.summary);
      const deadline = formatDeadline(result.deadline);
      const deadlineLine = deadline
        ? `\n🗓️ Deadline: ${deadline}`
        : "";
      const forcedLine = result.forced
        ? "\n⚠️ Forced advance — not all teams were marked ready in the bot."
        : "";

      // Public announcement of the new week + deadline for the whole channel.
      await interaction.editReply({
        content:
          `📢 The dynasty has advanced from **${result.previousWeekName}** to ` +
          `**${result.currentWeekName}**! Ready statuses have been reset.${deadlineLine}${forcedLine}`,
        ...message,
      });

      // Generate and post the Weekly Newspaper for the week that just ended.
      // This runs after the advance reply so a slow Grok call (or a newspaper
      // failure) never blocks or breaks the core advance flow.
      await publishWeeklyNewspaper(interaction, result.previousWeek, result.previousWeekName);
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
  weekName: string,
): Promise<void> {
  try {
    const result = await generateAndPostNewspaper(interaction.client, weekNumber);
    const note = result.posted
      ? `📰 Weekly Newspaper for ${weekName} posted to <#${result.channelId}>.`
      : `📰 Weekly Newspaper for ${weekName} generated, but not posted ` +
        "(set `NEWSPAPER_CHANNEL_ID` to enable posting).";
    await interaction.followUp({ content: note, ephemeral: true });
  } catch (error) {
    console.error("[advance] Failed to generate the weekly newspaper", error);
    try {
      await interaction.followUp({
        content:
          `${weekName} advanced, but I couldn't generate the Weekly ` +
          "Newspaper. You can retry with `/newspaper`.",
        ephemeral: true,
      });
    } catch (followUpError) {
      console.error("[advance] Failed to send newspaper follow-up", followUpError);
    }
  }
}
