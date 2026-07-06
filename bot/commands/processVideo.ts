import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { processVideoBoxScore } from "@/bot/boxScore";
import { buildBoxScoreEmbed } from "@/bot/ui/boxScoreMessage";

/**
 * `/process-video` — extract structured game data (v1: a Box Score) from a
 * recorded Xbox game.
 *
 * The user attaches a video; the bot downloads it, samples a handful of frames
 * with ffmpeg, sends them to Grok Vision to read the box score, stores the
 * result, and replies with a summary embed. Available to anyone in the server.
 */
export const processVideoCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("process-video")
    .setDescription("Extract a Box Score from a recorded game video.")
    .addAttachmentOption((option) =>
      option
        .setName("video")
        .setDescription("The recorded game video (MP4/MOV).")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("week")
        .setDescription("Week the game belongs to (optional).")
        .setMinValue(1)
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const video = interaction.options.getAttachment("video", true);
    const weekNumber = interaction.options.getInteger("week") ?? undefined;

    // Downloading + ffmpeg + Grok Vision all take well beyond Discord's 3s
    // window, so defer immediately. Non-ephemeral so the summary is shared.
    await interaction.deferReply();

    try {
      const { record, frameCount } = await processVideoBoxScore({
        videoUrl: video.url,
        filename: video.name,
        contentType: video.contentType,
        sizeBytes: video.size,
        weekNumber,
      });

      const embed = await buildBoxScoreEmbed(record, frameCount);
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("[process-video] Failed to process the video", error);
      // Surface the specific, user-friendly message when we threw one on
      // purpose; fall back to a generic note for anything unexpected.
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Sorry, I couldn't process that video. Please try again shortly.";
      await interaction.editReply({
        content: `⚠️ ${message}`,
      });
    }
  },
};
