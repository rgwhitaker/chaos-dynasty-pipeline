import type { EmbedBuilder } from "discord.js";
import { getWeekName } from "@/lib/weekSchedule";
import type { ExtractedDataRecord, ScreenshotDataType } from "@/lib/types";

/** Chaos brand color reused for screenshot-import embeds (a warm amber). */
const IMPORT_COLOR = 0xf5a623;

/** Discord hard-limits an embed field value to 1024 characters. */
const FIELD_VALUE_LIMIT = 1024;

/** Truncate text to `limit` characters, appending an ellipsis when clipped. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Human-friendly label for a data type. */
function dataTypeLabel(dataType: ScreenshotDataType): string {
  switch (dataType) {
    case "box-score":
      return "🏈 Box Score";
    case "heisman":
      return "🏆 Heisman Race";
    case "player-stats":
      return "📊 Player Stats";
    case "standings":
      return "📋 Standings";
    default:
      return "🖼️ Screenshot";
  }
}

/**
 * Render a compact one-line summary of the extracted `data`, tailored to a few
 * known shapes (box score, heisman) with a generic JSON fallback for everything
 * else. Kept defensive: the JSONB payload is free-form, so every access is
 * guarded.
 */
function summarizeData(record: ExtractedDataRecord): string {
  const data = record.data as Record<string, unknown>;

  if (record.dataType === "box-score") {
    const home = data.home as { name?: string; score?: number } | undefined;
    const away = data.away as { name?: string; score?: number } | undefined;
    if (home?.name || away?.name) {
      const fmt = (team?: { name?: string; score?: number }) =>
        `${team?.name ?? "?"} ${typeof team?.score === "number" ? team.score : "?"}`;
      return `${fmt(away)} @ ${fmt(home)}`;
    }
  }

  if (record.dataType === "heisman") {
    const candidates = data.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const top = candidates
        .slice(0, 5)
        .map((entry, index) => {
          const candidate = entry as { player?: string; team?: string };
          return `${index + 1}. ${candidate.player ?? "?"}${
            candidate.team ? ` (${candidate.team})` : ""
          }`;
        })
        .join("\n");
      return top;
    }
  }

  // Generic fallback: pretty-print the JSON so the extraction is at least visible.
  return "```json\n" + truncate(JSON.stringify(data, null, 2), FIELD_VALUE_LIMIT - 12) + "\n```";
}

/**
 * Build a summary embed for an extracted-data record. discord.js runtime classes
 * are imported dynamically (matching the other UI builders) so this module can be
 * loaded without eagerly pulling in the server-external discord.js package.
 */
export async function buildExtractedDataEmbed(
  record: ExtractedDataRecord,
): Promise<EmbedBuilder> {
  const { EmbedBuilder } = await import(/* webpackIgnore: true */ "discord.js");

  const weekSuffix =
    typeof record.weekNumber === "number"
      ? ` — ${getWeekName(record.weekNumber)}`
      : "";

  const embed: EmbedBuilder = new EmbedBuilder()
    .setTitle(`${dataTypeLabel(record.dataType)} Extracted`)
    .setDescription(truncate(summarizeData(record), 4096))
    .setColor(IMPORT_COLOR)
    .setAuthor({ name: `CHAOS Dynasty — Screenshot Import${weekSuffix}` })
    .setFooter({
      text: `Extracted by ${record.model}${
        record.sourceName ? ` • ${record.sourceName}` : ""
      }`,
    })
    .setTimestamp(new Date(record.processedAt));

  return embed;
}
