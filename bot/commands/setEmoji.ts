import { SlashCommandBuilder } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { respondWithTeamChoices } from "@/bot/commands/teamAutocomplete";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";
import { MAX_EMOJI_LENGTH, normalizeEmoji } from "@/bot/store/teamNaming";

/**
 * `/set-emoji` — set (or clear) the emoji shown next to a team's name in Discord
 * messages. Restricted to commissioners (configured role or Manage Server
 * permission). Leave the `emoji` option empty to remove a team's emoji.
 */
export const setEmojiCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("set-emoji")
    .setDescription("Set or clear a team's emoji (commissioners only).")
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team to update. Start typing to search.")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("emoji")
        .setDescription("The emoji to show next to the team. Leave empty to remove it.")
        .setMaxLength(MAX_EMOJI_LENGTH),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can set a team's emoji.",
        ephemeral: true,
      });
      return;
    }

    const teamId = interaction.options.getString("team", true);
    const rawEmoji = interaction.options.getString("emoji") ?? "";

    let emoji: string | undefined;
    try {
      emoji = normalizeEmoji(rawEmoji);
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : "That emoji isn't valid.",
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

      const updated = await store.updateTeam(teamId, { emoji: emoji ?? null });

      await interaction.editReply({
        content: emoji
          ? `Set ${updated.emoji} as the emoji for **${updated.name}**.`
          : `Removed the emoji from **${updated.name}**.`,
      });
    } catch (error) {
      console.error("[set-emoji] Failed to update team emoji", error);
      await interaction.editReply({
        content: "Sorry, I couldn't update the team emoji right now. Please try again shortly.",
      });
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    await respondWithTeamChoices(interaction, String(interaction.options.getFocused()));
  },
};
