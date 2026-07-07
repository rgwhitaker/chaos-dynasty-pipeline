import type { EmbedBuilder } from "discord.js";
import type { BoxScoreRecord, BoxScoreTeam } from "@/lib/types";

/** Chaos brand color reused for box-score embeds (an electric blue). */
const BOX_SCORE_COLOR = 0x1f8bff;

/** Discord hard-limits an embed field value to 1024 characters. */
const FIELD_VALUE_LIMIT = 1024;

/** Truncate text to `limit` characters, appending an ellipsis when clipped. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Render a team's headline line: name and final score (when known). */
function formatTeamLine(team: BoxScoreTeam, label: string): string {
  const score = typeof team.score === "number" ? `**${team.score}**` : "_?_";
  return `${label}: ${team.name} — ${score}`;
}

/** Render quarter-by-quarter scores for both teams as a compact table. */
function formatQuarters(home: BoxScoreTeam, away: BoxScoreTeam): string | undefined {
  const homeQ = home.quarterScores;
  const awayQ = away.quarterScores;
  if ((!homeQ || homeQ.length === 0) && (!awayQ || awayQ.length === 0)) {
    return undefined;
  }

  const count = Math.max(homeQ?.length ?? 0, awayQ?.length ?? 0);
  const header = ["", ...Array.from({ length: count }, (_u, i) => `Q${i + 1}`)];
  const cell = (scores: number[] | undefined, i: number) =>
    scores && typeof scores[i] === "number" ? String(scores[i]) : "-";

  const rows = [
    header.join(" | "),
    [away.name, ...Array.from({ length: count }, (_u, i) => cell(awayQ, i))].join(" | "),
    [home.name, ...Array.from({ length: count }, (_u, i) => cell(homeQ, i))].join(" | "),
  ];

  return truncate("```\n" + rows.join("\n") + "\n```", FIELD_VALUE_LIMIT);
}

/** Render a team's stats block as `label: value` lines. */
function formatStats(team: BoxScoreTeam): string | undefined {
  const stats = team.stats;
  if (!stats || Object.keys(stats).length === 0) {
    return undefined;
  }
  const lines = Object.entries(stats).map(([label, value]) => `• ${label}: ${value}`);
  return truncate(lines.join("\n"), FIELD_VALUE_LIMIT);
}

/**
 * Build the rich box-score embed. discord.js runtime classes are imported
 * dynamically (matching the other UI builders) so this module can be loaded
 * without eagerly pulling in the server-external discord.js package.
 */
export async function buildBoxScoreEmbed(
  record: BoxScoreRecord,
  frameCount: number,
): Promise<EmbedBuilder> {
  const { EmbedBuilder } = await import(/* webpackIgnore: true */ "discord.js");
  const { boxScore } = record;

  const weekSuffix =
    typeof record.weekNumber === "number" ? ` — Week ${record.weekNumber}` : "";

  const embed: EmbedBuilder = new EmbedBuilder()
    .setTitle("🏈 Box Score Extracted")
    .setDescription(
      `${formatTeamLine(boxScore.away, "Away")}\n${formatTeamLine(boxScore.home, "Home")}`,
    )
    .setColor(BOX_SCORE_COLOR)
    .setAuthor({ name: `CHAOS Dynasty — Video Import${weekSuffix}` })
    .setFooter({
      text: `Extracted by ${record.model} from ${frameCount} frame(s)`,
    })
    .setTimestamp(new Date(record.createdAt));

  const quarters = formatQuarters(boxScore.home, boxScore.away);
  if (quarters) {
    embed.addFields({ name: "Quarter-by-quarter", value: quarters });
  }

  const awayStats = formatStats(boxScore.away);
  if (awayStats) {
    embed.addFields({ name: `${boxScore.away.name} stats`, value: awayStats });
  }

  const homeStats = formatStats(boxScore.home);
  if (homeStats) {
    embed.addFields({ name: `${boxScore.home.name} stats`, value: homeStats });
  }

  if (boxScore.notes) {
    embed.addFields({ name: "Notes", value: truncate(boxScore.notes, FIELD_VALUE_LIMIT) });
  }

  return embed;
}
