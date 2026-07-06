import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
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

    const store = getReadyStore();
    const result = await store.advanceWeek();

    if (!result.advanced) {
      const { summary } = result;
      const message = await buildReadyStatusMessage(summary);
      await interaction.reply({
        content:
          `Not enough teams are ready to advance Week ${summary.weekNumber} ` +
          `(${summary.readyCount}/${summary.requiredCount}).`,
        ...message,
        ephemeral: true,
      });
      return;
    }

    const message = await buildReadyStatusMessage(result.summary);
    await interaction.reply({
      content:
        `Advanced from Week ${result.previousWeek} to **Week ${result.currentWeek}**! ` +
        "Ready statuses have been reset.",
      ...message,
    });
  },
};
