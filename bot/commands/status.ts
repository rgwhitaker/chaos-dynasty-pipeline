import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage } from "@/bot/ui/readyMessage";

/**
 * `/status` — show the current week plus which teams are ready / not ready.
 * Anyone in the guild can run this; it is ephemeral by default to avoid channel
 * spam, but includes the interactive buttons so members can act on it.
 */
export const statusCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current week and which teams are ready to advance."),

  async execute(interaction: ChatInputCommandInteraction) {
    // Defer immediately so we stay within Discord's 3s window while we hit the
    // (potentially remote) store. The reply stays ephemeral to avoid spam.
    await interaction.deferReply({ ephemeral: true });

    try {
      const store = getReadyStore();
      const summary = await store.getReadySummary();
      const message = await buildReadyStatusMessage(summary);

      await interaction.editReply(message);
    } catch (error) {
      console.error("[status] Failed to load ready summary", error);
      await interaction.editReply({
        content: "Sorry, I couldn't load the ready status right now. Please try again shortly.",
      });
    }
  },
};
