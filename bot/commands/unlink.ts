import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { getReadyStore } from "@/bot/store/readyStore";

/**
 * `/unlink` — remove a Discord user's link to whatever team they are currently
 * on, without deleting the team. Restricted to commissioners (configured role or
 * Manage Server permission).
 */
export const unlinkCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove a user's link to their current team (commissioners only).")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The Discord user to unlink from their team.")
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can unlink users from teams.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);

    await interaction.deferReply({ ephemeral: true });

    try {
      const store = getReadyStore();
      const team = await store.unlinkDiscordUser(targetUser.id);

      if (!team) {
        await interaction.editReply({
          content: `${targetUser} isn't linked to a team, so there's nothing to unlink.`,
        });
        return;
      }

      await interaction.editReply({
        content: `Unlinked ${targetUser} from **${team.name}**.`,
      });
    } catch (error) {
      console.error("[unlink] Failed to unlink user from team", error);
      await interaction.editReply({
        content: "Sorry, I couldn't unlink that user right now. Please try again shortly.",
      });
    }
  },
};
