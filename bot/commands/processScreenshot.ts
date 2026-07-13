import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { processScreenshotFromUrl } from "@/bot/onedrive/monitor";
import { buildExtractedDataEmbed } from "@/bot/ui/extractedDataMessage";
import type { ScreenshotDataType } from "@/lib/types";

/**
 * `/process-screenshot` — manual fallback for the OneDrive monitor.
 *
 * The user attaches a single screenshot (PNG/JPG); the bot sends it to Grok
 * Vision with a type-specific prompt, stores the structured result in
 * `extracted_data`, and replies with a summary embed. Week and data type are
 * inferred from the filename when not supplied. Available to anyone in the server.
 */

/** Selectable data types for the optional `type` option. */
const DATA_TYPE_CHOICES: Array<{ name: string; value: ScreenshotDataType }> = [
  { name: "Box Score", value: "box-score" },
  { name: "Heisman Race", value: "heisman" },
  { name: "Player Stats", value: "player-stats" },
  { name: "Standings", value: "standings" },
];

/** Whether the attachment looks like a supported screenshot image. */
function isLikelyImage(input: {
  contentType?: string | null;
  filename?: string;
}): boolean {
  if (input.contentType && input.contentType.toLowerCase().startsWith("image/")) {
    return true;
  }
  const name = input.filename?.toLowerCase() ?? "";
  return /\.(png|jpg|jpeg)$/.test(name);
}

export const processScreenshotCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("process-screenshot")
    .setDescription("Extract structured data from a screenshot (Box Score, Heisman, etc.).")
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("The screenshot to process (PNG/JPG).")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("What the screenshot shows (inferred from the filename when omitted).")
        .setRequired(false)
        .addChoices(...DATA_TYPE_CHOICES),
    )
    .addIntegerOption((option) =>
      option
        .setName("week")
        .setDescription("Week the data belongs to (schedule index; optional).")
        .setMinValue(0)
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const image = interaction.options.getAttachment("image", true);
    const dataType =
      (interaction.options.getString("type") as ScreenshotDataType | null) ?? undefined;
    const weekNumber = interaction.options.getInteger("week") ?? undefined;

    if (!isLikelyImage({ contentType: image.contentType, filename: image.name })) {
      await interaction.reply({
        content:
          "⚠️ That attachment does not look like an image. Please upload a PNG or JPG screenshot.",
        ephemeral: true,
      });
      return;
    }

    // Downloading + Grok Vision take longer than Discord's 3s window, so defer.
    await interaction.deferReply();

    try {
      const record = await processScreenshotFromUrl({
        // Discord attachment URLs are publicly fetchable; Grok reads them directly.
        imageUrl: image.url,
        // Namespace manual uploads so they never collide with OneDrive paths.
        sourcePath: `manual/${Date.now()}-${image.name}`,
        sourceName: image.name,
        weekNumber,
        dataType,
      });

      const embed = await buildExtractedDataEmbed(record);
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("[process-screenshot] Failed to process the screenshot", error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Sorry, I couldn't process that screenshot. Please try again shortly.";
      await interaction.editReply({ content: `⚠️ ${message}` });
    }
  },
};
