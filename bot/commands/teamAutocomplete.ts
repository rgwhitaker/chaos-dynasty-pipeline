import type { AutocompleteInteraction } from "discord.js";
import { getReadyStore } from "@/bot/store/readyStore";

/** Discord caps autocomplete responses at 25 choices. */
export const MAX_AUTOCOMPLETE_RESULTS = 25;

/**
 * Respond to an autocomplete interaction with existing teams matching the user's
 * input. Unlike `/register` (which uses the team *name* as the value so it can
 * create new teams), management commands operate on existing teams, so the
 * choice value is the stable team **id**. Failures respond with an empty list so
 * the Discord client doesn't hang.
 */
export async function respondWithTeamChoices(
  interaction: AutocompleteInteraction,
  query: string,
  optionName = "team",
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== optionName) {
    await interaction.respond([]);
    return;
  }

  try {
    const store = getReadyStore();
    const teams = await store.searchTeams(query, MAX_AUTOCOMPLETE_RESULTS);

    const choices = teams.map((team) => {
      const label = team.abbreviation ? `${team.name} (${team.abbreviation})` : team.name;
      return {
        // Discord requires choice names to be <= 100 characters.
        name: label.slice(0, 100),
        value: team.id,
      };
    });

    await interaction.respond(choices);
  } catch (error) {
    console.error("[team-autocomplete] Lookup failed", error);
    await interaction.respond([]);
  }
}
