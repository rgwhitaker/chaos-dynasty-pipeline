import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage } from "@/bot/ui/readyMessage";

/**
 * `/set-ready` — let a commissioner set the ready status of another user's team
 * for the current week, even if that user never marked ready themselves.
 * Restricted to commissioners (configured role or Manage Server permission),
 * matching `/advance` and `/register`.
 */
export const setReadyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("set-ready")
    .setDescription("Set another user's team ready status (commissioners only).")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The Discord user whose team ready status to set.")
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName("ready")
        .setDescription("Whether the team should be marked ready (true) or not ready (false).")
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    // Permission check: commissioners only (same rule as `/advance`).
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can set another user's ready status.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const wantsReady = interaction.options.getBoolean("ready", true);

    const store = getReadyStore();

    // Look up the team the target user is linked to.
    let team;
    try {
      team = await store.getTeamByDiscordUserId(targetUser.id);
    } catch (error) {
      console.error("[set-ready] Failed to look up linked team", error);
      await interaction.reply({
        content: "Sorry, I couldn't reach the league data right now. Please try again shortly.",
        ephemeral: true,
      });
      return;
    }

    if (!team) {
      await interaction.reply({
        content:
          `${targetUser} is not linked to a team, so I can't set their ready status. ` +
          "Link them to a team with `/register` first.",
        ephemeral: true,
      });
      return;
    }

    // Defer the public reply so we have time to persist the change to the store.
    await interaction.deferReply();

    try {
      await store.setReadyStatus(team.id, wantsReady ? "READY" : "NOT_READY", targetUser.id);

      const summary = await store.getReadySummary();
      const message = await buildReadyStatusMessage(summary);

      const verb = wantsReady ? "ready" : "not ready";
      await interaction.editReply({
        content:
          `**${team.name}** (${targetUser}) is now marked **${verb}** for ${summary.weekName}.`,
        ...message,
      });

      // Keep the persistent status dashboard in sync with this change.
      await updateStatusDashboard(interaction.client);
    } catch (error) {
      console.error("[set-ready] Failed to update ready status", error);
      await interaction.editReply({
        content: "Sorry, I couldn't update the ready status right now. Please try again shortly.",
      });
    }
  },
};
