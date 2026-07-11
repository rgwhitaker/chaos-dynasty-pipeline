import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { notifyCommissionersIfEveryoneReady } from "@/bot/allReadyNotifier";
import { updateStatusDashboard } from "@/bot/statusDashboard";
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
    let team;
    try {
      team = await store.getTeamByDiscordUserId(interaction.user.id);
    } catch (error) {
      console.error("[ready] Failed to look up linked team", error);
      await interaction.reply({
        content: "Sorry, I couldn't reach the league data right now. Please try again shortly.",
        ephemeral: true,
      });
      return;
    }

    if (!team) {
      await interaction.reply({
        content:
          "You are not linked to a team, so you can't set a ready status. " +
          "Ask a commissioner to link your Discord account to a team.",
        ephemeral: true,
      });
      return;
    }

    // Defer the public reply so we have time to persist the change to the store.
    await interaction.deferReply();

    try {
      const wantsReady = interaction.options.getBoolean("ready") ?? true;
      await store.setReadyStatus(team.id, wantsReady ? "READY" : "NOT_READY", interaction.user.id);

      const summary = await store.getReadySummary();
      const message = await buildReadyStatusMessage(summary);

      const verb = wantsReady ? "ready" : "not ready";
      await interaction.editReply({
        content: `**${team.name}** is now marked **${verb}** for ${summary.weekName}.`,
        ...message,
      });

      // Keep the persistent status dashboard in sync with this change.
      await updateStatusDashboard(interaction.client);

      // Ping commissioners if this change made every team ready.
      await notifyCommissionersIfEveryoneReady(interaction.client);
    } catch (error) {
      console.error("[ready] Failed to update ready status", error);
      await interaction.editReply({
        content: "Sorry, I couldn't update your ready status right now. Please try again shortly.",
      });
    }
  },
};
