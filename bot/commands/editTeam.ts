import { SlashCommandBuilder } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { respondWithTeamChoices } from "@/bot/commands/teamAutocomplete";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";
import {
  MAX_ABBREVIATION_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  normalizeAbbreviation,
  normalizeTeamName,
} from "@/bot/store/teamNaming";

/**
 * `/edit-team` — rename a team and/or change its abbreviation. Restricted to
 * commissioners (configured role or Manage Server permission). At least one of
 * `name` or `abbreviation` must be provided.
 */
export const editTeamCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("edit-team")
    .setDescription("Change a team's name or abbreviation (commissioners only).")
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team to edit. Start typing to search.")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("The new team name.")
        .setMaxLength(MAX_TEAM_NAME_LENGTH),
    )
    .addStringOption((option) =>
      option
        .setName("abbreviation")
        .setDescription("The new short abbreviation (e.g. ORST).")
        .setMaxLength(MAX_ABBREVIATION_LENGTH),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can edit teams.",
        ephemeral: true,
      });
      return;
    }

    const teamId = interaction.options.getString("team", true);
    const rawName = interaction.options.getString("name");
    const rawAbbreviation = interaction.options.getString("abbreviation");

    const newName = rawName ? normalizeTeamName(rawName) : undefined;
    const newAbbreviation = rawAbbreviation ? normalizeAbbreviation(rawAbbreviation) : undefined;

    if (!newName && !newAbbreviation) {
      await interaction.reply({
        content: "Provide a new `name` and/or `abbreviation` to change.",
        ephemeral: true,
      });
      return;
    }

    if (newName && newName.length > MAX_TEAM_NAME_LENGTH) {
      await interaction.reply({
        content: `Team names must be ${MAX_TEAM_NAME_LENGTH} characters or fewer.`,
        ephemeral: true,
      });
      return;
    }

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

      const updated = await store.updateTeam(teamId, {
        name: newName,
        abbreviation: newAbbreviation,
      });

      const label = updated.abbreviation
        ? `**${updated.name}** (${updated.abbreviation})`
        : `**${updated.name}**`;
      await interaction.editReply({
        content: `Updated ${label}.`,
      });
    } catch (error) {
      console.error("[edit-team] Failed to update team", error);
      await interaction.editReply({
        content: "Sorry, I couldn't update the team right now. Please try again shortly.",
      });
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    await respondWithTeamChoices(interaction, String(interaction.options.getFocused()));
  },
};
