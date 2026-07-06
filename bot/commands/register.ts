import { SlashCommandBuilder } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";
import { MAX_TEAM_NAME_LENGTH, normalizeTeamName } from "@/bot/store/teamNaming";

/** Discord caps autocomplete responses at 25 choices. */
const MAX_AUTOCOMPLETE_RESULTS = 25;

/**
 * `/register` — link a Discord user to a team, creating the team if it does not
 * already exist. Restricted to commissioners (configured role or Manage Server
 * permission), matching `/advance`.
 */
export const registerCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("register")
    .setDescription("Register a Discord user to a team (commissioners only).")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The Discord user to link to the team.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team name (existing or new). Start typing to search.")
        .setRequired(true)
        .setAutocomplete(true)
        .setMaxLength(MAX_TEAM_NAME_LENGTH),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    // Permission check: commissioners only (same rule as `/advance`).
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can register users to teams.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const rawTeam = interaction.options.getString("team", true);
    const teamQuery = normalizeTeamName(rawTeam);

    if (!teamQuery) {
      await interaction.reply({
        content: "Please provide a team name.",
        ephemeral: true,
      });
      return;
    }

    if (teamQuery.length > MAX_TEAM_NAME_LENGTH) {
      await interaction.reply({
        content: `Team names must be ${MAX_TEAM_NAME_LENGTH} characters or fewer.`,
        ephemeral: true,
      });
      return;
    }

    // Registering may create a team and touch the store, so defer to stay within
    // Discord's response window. Ephemeral to keep admin actions quiet.
    await interaction.deferReply({ ephemeral: true });

    try {
      const store = getReadyStore();

      // Reuse an existing team when the name/abbreviation already matches;
      // otherwise create a new one.
      let team = await store.findTeamByNameOrAbbreviation(teamQuery);
      let created = false;
      if (!team) {
        team = await store.createTeam({ name: teamQuery });
        created = true;
      }

      // If the user is already on this exact team, there is nothing to do.
      const existing = await store.getTeamByDiscordUserId(targetUser.id);
      if (existing && existing.id === team.id) {
        await interaction.editReply({
          content: `${targetUser} is already registered to **${team.name}**.`,
        });
        return;
      }

      const linked = await store.linkTeamToDiscordUser(team.id, targetUser.id);

      const moved = existing ? ` (moved from **${existing.name}**)` : "";
      const createdNote = created ? " (new team created)" : "";
      await interaction.editReply({
        content: `Registered ${targetUser} to **${linked.name}**${createdNote}${moved}.`,
      });
    } catch (error) {
      console.error("[register] Failed to register user to team", error);
      await interaction.editReply({
        content: "Sorry, I couldn't complete the registration right now. Please try again shortly.",
      });
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "team") {
      await interaction.respond([]);
      return;
    }

    try {
      const store = getReadyStore();
      const teams = await store.searchTeams(String(focused.value), MAX_AUTOCOMPLETE_RESULTS);

      const choices = teams.map((team) => {
        const label = team.abbreviation ? `${team.name} (${team.abbreviation})` : team.name;
        return {
          // Discord requires choice names to be <= 100 characters.
          name: label.slice(0, 100),
          value: team.name.slice(0, MAX_TEAM_NAME_LENGTH),
        };
      });

      await interaction.respond(choices);
    } catch (error) {
      console.error("[register] Autocomplete lookup failed", error);
      // Respond with an empty list so the client doesn't hang on failure.
      await interaction.respond([]);
    }
  },
};
