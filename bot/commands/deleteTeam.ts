import { SlashCommandBuilder } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { respondWithTeamChoices } from "@/bot/commands/teamAutocomplete";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";

/**
 * `/delete-team` — permanently delete a team. Restricted to commissioners
 * (configured role or Manage Server permission). As a safety check, deletion is
 * refused while a user is still linked to the team unless `force:true` is passed.
 */
export const deleteTeamCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("delete-team")
    .setDescription("Delete a team (commissioners only).")
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team to delete. Start typing to search.")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addBooleanOption((option) =>
      option
        .setName("force")
        .setDescription("Delete even if a user is still linked to the team."),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can delete teams.",
        ephemeral: true,
      });
      return;
    }

    const teamId = interaction.options.getString("team", true);
    const force = interaction.options.getBoolean("force") ?? false;

    await interaction.deferReply({ ephemeral: true });

    try {
      const store = getReadyStore();
      const team = await store.getTeamById(teamId);
      if (!team) {
        await interaction.editReply({
          content: "I couldn't find that team. Pick one from the autocomplete list.",
        });
        return;
      }

      // Safety check: don't silently orphan a linked user unless forced.
      if (team.userId && !force) {
        await interaction.editReply({
          content:
            `**${team.name}** still has <@${team.userId}> linked to it. ` +
            "Unlink them with `/unlink` first, or re-run with `force:true` to delete anyway.",
        });
        return;
      }

      await store.deleteTeam(teamId);

      const forcedNote = team.userId ? ` (unlinked <@${team.userId}>)` : "";
      await interaction.editReply({
        content: `Deleted **${team.name}**${forcedNote}.`,
      });
    } catch (error) {
      console.error("[delete-team] Failed to delete team", error);
      await interaction.editReply({
        content: "Sorry, I couldn't delete the team right now. Please try again shortly.",
      });
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    await respondWithTeamChoices(interaction, String(interaction.options.getFocused()));
  },
};
