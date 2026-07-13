import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig, isOnedriveConfigured } from "@/bot/config";
import { syncOnedrive } from "@/bot/onedrive/monitor";
import { isCommissioner } from "@/bot/permissions";
import type { OnedriveSyncResult } from "@/bot/onedrive/monitor";

/**
 * `/sync-onedrive` — manually trigger a OneDrive delta poll instead of waiting
 * for the background monitor. Restricted to commissioners (same rule as
 * `/advance`). Pass `full:true` to ignore the stored delta link and re-scan the
 * whole monitored folder (useful after changing folder structure).
 */
export const syncOnedriveCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("sync-onedrive")
    .setDescription("Poll OneDrive for new screenshots now (commissioners only).")
    .addBooleanOption((option) =>
      option
        .setName("full")
        .setDescription("Re-scan the whole monitored folder instead of only changes.")
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can trigger a OneDrive sync.",
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

    const full = interaction.options.getBoolean("full") ?? false;
    await interaction.deferReply({ ephemeral: true });

    try {
      const result: OnedriveSyncResult = await syncOnedrive({ full });
      await interaction.editReply({ content: formatSyncResult(result) });
    } catch (error) {
      console.error("[sync-onedrive] Failed to sync OneDrive", error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Sorry, I couldn't sync OneDrive right now. Please try again shortly.";
      await interaction.editReply({ content: `⚠️ ${message}` });
    }
  },
};

/** Render a short human summary of a sync run for the ephemeral reply. */
export function formatSyncResult(result: OnedriveSyncResult): string {
  if (!result.configured) {
    return "⚠️ OneDrive is not configured.";
  }
  if (result.processed === 0 && result.failed === 0) {
    return "✅ OneDrive sync complete — no new screenshots to process.";
  }
  const parts = [`✅ Processed **${result.processed}** screenshot(s)`];
  if (result.skipped > 0) {
    parts.push(`${result.skipped} already processed`);
  }
  if (result.failed > 0) {
    parts.push(`${result.failed} failed (see logs)`);
  }
  return `${parts.join(", ")}.`;
}
