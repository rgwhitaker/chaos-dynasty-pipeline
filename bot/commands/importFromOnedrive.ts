import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig, isOnedriveConfigured } from "@/bot/config";
import { importFromOnedrivePath } from "@/bot/onedrive/monitor";
import { isCommissioner } from "@/bot/permissions";
import { formatSyncResult } from "@/bot/commands/syncOnedrive";

/**
 * `/import-from-onedrive` — re-scan a specific OneDrive folder and process every
 * image under it, ignoring the delta token. Restricted to commissioners. Handy
 * for back-filling an existing folder (e.g. "2026 Week 1/Box Scores") the first
 * time monitoring is set up. Already-processed files are skipped automatically.
 */
export const importFromOnedriveCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("import-from-onedrive")
    .setDescription("Import all screenshots under a OneDrive folder (commissioners only).")
    .addStringOption((option) =>
      option
        .setName("path")
        .setDescription("Folder path relative to the drive root (defaults to the monitored folder).")
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can import from OneDrive.",
        ephemeral: true,
      });
      return;
    }

    if (!isOnedriveConfigured()) {
      await interaction.reply({
        content:
          "⚠️ OneDrive is not configured. Set `ONEDRIVE_CLIENT_ID`, " +
          "`ONEDRIVE_CLIENT_SECRET`, `ONEDRIVE_TENANT_ID`, and `ONEDRIVE_MONITORED_PATH`.",
        ephemeral: true,
      });
      return;
    }

    const path = interaction.options.getString("path")?.trim() ?? "";
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await importFromOnedrivePath(path);
      await interaction.editReply({ content: formatSyncResult(result) });
    } catch (error) {
      console.error("[import-from-onedrive] Failed to import from OneDrive", error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Sorry, I couldn't import from OneDrive right now. Please try again shortly.";
      await interaction.editReply({ content: `⚠️ ${message}` });
    }
  },
};
