import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { generateAndPostNewspaper } from "@/bot/newspaper";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";

/**
 * `/newspaper` — manually (re)generate and post the Weekly Newspaper.
 *
 * Restricted to commissioners (same rule as `/advance`). Defaults to the most
 * recently completed week (the current week minus one) so it matches what
 * `/advance` posts; pass `week` to target the current or any specific week.
 */
export const newspaperCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("newspaper")
    .setDescription("Regenerate and post the Weekly Newspaper (commissioners only).")
    .addIntegerOption((option) =>
      option
        .setName("week")
        .setDescription(
          "Week to generate for (defaults to the most recently completed week).",
        )
        .setMinValue(1)
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    // Permission check: commissioners only (same rule as `/advance`).
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can generate the Weekly Newspaper.",
        ephemeral: true,
      });
      return;
    }

    // Generating hits the Grok API, so defer to stay within Discord's window.
    // Ephemeral so the command chatter stays out of the channel — the newspaper
    // itself is posted to the dedicated newspaper channel.
    await interaction.deferReply({ ephemeral: true });

    try {
      const store = getReadyStore();
      const weekState = await store.getWeekState();

      const requestedWeek = interaction.options.getInteger("week");
      // Default to the most recently completed week (current - 1), floored at
      // the current week so a brand-new league still generates something.
      const weekNumber =
        requestedWeek ?? Math.max(weekState.weekNumber - 1, config.startWeek);

      const result = await generateAndPostNewspaper(interaction.client, weekNumber);

      const note = result.posted
        ? `📰 Weekly Newspaper for **Week ${weekNumber}** posted to <#${result.channelId}>.`
        : `📰 Weekly Newspaper for **Week ${weekNumber}** generated and stored, ` +
          "but not posted (set `NEWSPAPER_CHANNEL_ID` to enable posting).";
      await interaction.editReply({ content: note });
    } catch (error) {
      console.error("[newspaper] Failed to generate the weekly newspaper", error);
      await interaction.editReply({
        content:
          "Sorry, I couldn't generate the Weekly Newspaper right now. Please try again shortly.",
      });
    }
  },
};
