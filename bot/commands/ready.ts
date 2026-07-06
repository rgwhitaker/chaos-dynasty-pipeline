import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage } from "@/bot/ui/readyMessage";

/**
 * `/ready` — let the invoking user mark their linked team as ready (or not
 * ready) for the current week. Only Discord users linked to a team may use it.
 *
 * The optional `ready` boolean lets a user un-ready themselves; it defaults to
 * true so the common case (`/ready`) just marks the team ready.
 */
export const readyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("ready")
    .setDescription("Mark your team as ready to advance the week.")
    .addBooleanOption((option) =>
      option
        .setName("ready")
        .setDescription("Set to false to mark your team as NOT ready. Defaults to true."),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const store = getReadyStore();

    // Permission check: only users linked to a team can mark ready.
    const team = await store.getTeamByDiscordUserId(interaction.user.id);
    if (!team) {
      await interaction.reply({
        content:
          "You are not linked to a team, so you can't set a ready status. " +
          "Ask a commissioner to link your Discord account to a team.",
        ephemeral: true,
      });
      return;
    }

    const wantsReady = interaction.options.getBoolean("ready") ?? true;
    await store.setReadyStatus(team.id, wantsReady ? "READY" : "NOT_READY", interaction.user.id);

    const summary = await store.getReadySummary();
    const message = await buildReadyStatusMessage(summary);

    const verb = wantsReady ? "ready" : "not ready";
    await interaction.reply({
      content: `**${team.name}** is now marked **${verb}** for Week ${summary.weekNumber}.`,
      ...message,
    });
  },
};
