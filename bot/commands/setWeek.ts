import { SlashCommandBuilder } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage, formatDeadline } from "@/bot/ui/readyMessage";
import { findWeekIndexByName, searchWeeks } from "@/lib/weekSchedule";

/** Discord caps autocomplete responses at 25 choices. */
const MAX_AUTOCOMPLETE_RESULTS = 25;

/** Bounds for the optional deadline override (in hours). */
const MIN_DEADLINE_HOURS = 1;
const MAX_DEADLINE_HOURS = 720; // 30 days

/**
 * `/set-week` — let a commissioner jump the dynasty to any week in the schedule
 * (e.g. skip ahead to "Bowl Week 1" or reset to "Preseason"). Restricted to
 * commissioners (same rule as `/advance`). The target week's deadline is
 * recalculated from its default duration unless `deadline_hours` overrides it.
 */
export const setWeekCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("set-week")
    .setDescription("Jump to a specific week in the schedule (commissioners only).")
    .addStringOption((option) =>
      option
        .setName("week")
        .setDescription("The week to jump to (start typing to search the schedule).")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("deadline_hours")
        .setDescription(
          "Override the week's deadline window, in hours (default: 48 game weeks / 24 otherwise).",
        )
        .setMinValue(MIN_DEADLINE_HOURS)
        .setMaxValue(MAX_DEADLINE_HOURS),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "week") {
      await interaction.respond([]);
      return;
    }

    const matches = searchWeeks(String(focused.value ?? ""), MAX_AUTOCOMPLETE_RESULTS);
    await interaction.respond(
      matches.map(({ week }) => ({
        // The value is the stable week key so execute() resolves it unambiguously.
        name: week.name.slice(0, 100),
        value: week.key,
      })),
    );
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    // Permission check: commissioners only (same rule as `/advance`).
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can set the current week.",
        ephemeral: true,
      });
      return;
    }

    const requestedWeek = interaction.options.getString("week", true);
    const weekIndex = findWeekIndexByName(requestedWeek);

    if (weekIndex < 0) {
      await interaction.reply({
        content:
          `"${requestedWeek}" isn't a valid week. Start typing in the \`week\` ` +
          "option to pick from the schedule (e.g. Preseason, Week 0–15, " +
          "Conference Championships, Bowl Week 1–3, National Championship, …).",
        ephemeral: true,
      });
      return;
    }

    const deadlineOverrideHours =
      interaction.options.getInteger("deadline_hours") ?? undefined;

    await interaction.deferReply();

    try {
      const store = getReadyStore();
      const weekState = await store.setCurrentWeek(
        weekIndex,
        deadlineOverrideHours ? { deadlineOverrideHours } : undefined,
      );

      const summary = await store.getReadySummary();
      const message = await buildReadyStatusMessage(summary);
      const deadline = formatDeadline(weekState.deadline);
      const deadlineLine = deadline ? `\n🗓️ Deadline: ${deadline}` : "";

      await interaction.editReply({
        content:
          `📢 The dynasty is now on **${weekState.weekName}**.${deadlineLine}`,
        ...message,
      });

      // Keep the persistent status dashboard in sync with the new week.
      await updateStatusDashboard(interaction.client);
    } catch (error) {
      console.error("[set-week] Failed to set the current week", error);
      await interaction.editReply({
        content: "Sorry, I couldn't set the week right now. Please try again shortly.",
      });
    }
  },
};
