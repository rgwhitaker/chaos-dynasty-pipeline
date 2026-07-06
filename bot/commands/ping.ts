import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";

/** Simple liveness check, handy while wiring the bot up. */
export const pingCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check that the Chaos Dynasty bot is responding."),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply({
      content: "Pong from Chaos Dynasty Pipeline.",
      ephemeral: true,
    });
  },
};
