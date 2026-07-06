import type {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  InteractionReplyOptions,
} from "discord.js";
import type { ReadySummary } from "@/lib/types";

/** Custom ids for the ready-status buttons (namespaced by feature). */
export const READY_BUTTON_IDS = {
  markReady: "ready:mark",
  markNotReady: "ready:unmark",
  refresh: "ready:refresh",
} as const;

const READY_EMOJI = "✅";
const NOT_READY_EMOJI = "⛔";

/**
 * Build the human-readable body describing every team's readiness for the
 * current week. Kept separate from the embed so it can be reused in plain-text
 * contexts (logs, tests) if needed.
 */
export function formatReadyLines(summary: ReadySummary): string {
  if (summary.entries.length === 0) {
    return "_No teams are configured yet._";
  }

  return summary.entries
    .map((entry) => {
      const emoji = entry.status === "READY" ? READY_EMOJI : NOT_READY_EMOJI;
      const teamEmoji = entry.team.emoji ? `${entry.team.emoji} ` : "";
      const owner = entry.team.userId ? ` — <@${entry.team.userId}>` : " — _unlinked_";
      return `${emoji} ${teamEmoji}**${entry.team.name}**${owner}`;
    })
    .join("\n");
}

/**
 * Build the rich status embed shown by `/status`, `/ready`, and button updates.
 * discord.js runtime classes are imported dynamically so this module can be
 * loaded without eagerly pulling in the (server-external) discord.js package.
 */
export async function buildReadyStatusMessage(
  summary: ReadySummary,
): Promise<Pick<InteractionReplyOptions, "embeds" | "components">> {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import(
    /* webpackIgnore: true */ "discord.js"
  );

  const progress = `${summary.readyCount}/${summary.requiredCount} ready` +
    (summary.requiredCount !== summary.totalCount
      ? ` (of ${summary.totalCount} teams)`
      : "");

  const embed: EmbedBuilder = new EmbedBuilder()
    .setTitle(`Week ${summary.weekNumber} — Ready Check`)
    .setDescription(formatReadyLines(summary))
    .addFields({ name: "Progress", value: progress, inline: true })
    .setColor(summary.canAdvance ? 0x2ecc71 : 0xe67e22)
    .setFooter({
      text: summary.canAdvance
        ? "Enough teams are ready — a commissioner can run /advance."
        : "Waiting on more teams to mark ready.",
    })
    .setTimestamp(new Date());

  const row: ActionRowBuilder<ButtonBuilder> = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(READY_BUTTON_IDS.markReady)
      .setLabel("Mark Ready")
      .setEmoji(READY_EMOJI)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(READY_BUTTON_IDS.markNotReady)
      .setLabel("Mark Not Ready")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(READY_BUTTON_IDS.refresh)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}
