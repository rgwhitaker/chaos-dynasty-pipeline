import type {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  MessageCreateOptions,
} from "discord.js";
import type { ReadySummary } from "@/lib/types";
import {
  buildReadyButtonRow,
  DASHBOARD_ADVANCE_BUTTON_IDS,
  DASHBOARD_BUTTON_IDS,
  formatDeadline,
} from "@/bot/ui/readyMessage";

const READY_EMOJI = "✅";
const NOT_READY_EMOJI = "⛔";
const ADVANCE_EMOJI = "⏭️";

/** Zero-width placeholder used when an embed field would otherwise be empty. */
const EMPTY_FIELD = "_None_";

/**
 * Render the list of teams for one side of the dashboard (ready or not ready).
 * Linked owners are mentioned so they can be pinged from the dashboard at a
 * glance; unlinked teams are shown in italics.
 */
function formatTeamList(
  entries: ReadySummary["entries"],
  emoji: string,
): string {
  if (entries.length === 0) {
    return EMPTY_FIELD;
  }

  return entries
    .map((entry) => {
      const teamEmoji = entry.team.emoji ? `${entry.team.emoji} ` : "";
      const owner = entry.team.userId ? ` — <@${entry.team.userId}>` : " — _unlinked_";
      return `${emoji} ${teamEmoji}**${entry.team.name}**${owner}`;
    })
    .join("\n");
}

/**
 * Build the commissioner-only **Advance Week** button row shown on the
 * persistent dashboard. The button itself is visible to everyone (Discord has
 * no per-viewer component rendering on a shared message), but the click handler
 * gates the action behind {@link isCommissioner}: non-commissioners are turned
 * away with an ephemeral note, and commissioners get a confirmation prompt
 * before anything advances. Rendered as a green Success button to stand apart
 * from the neutral ready-check controls above it.
 */
async function buildAdvanceButtonRow(): Promise<ActionRowBuilder<ButtonBuilder>> {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import(
    /* webpackIgnore: true */ "discord.js"
  );

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(DASHBOARD_ADVANCE_BUTTON_IDS.advance)
      .setLabel("Advance Week")
      .setEmoji(ADVANCE_EMOJI)
      .setStyle(ButtonStyle.Success),
  );
}

/**
 * Build the persistent status-dashboard message shown in the configured
 * `STATUS_CHANNEL_ID` channel. It mirrors `/status` but with a two-column
 * ready/not-ready layout, and carries the same **Mark Ready / Mark Not Ready /
 * Refresh** buttons so members can act on it directly. The buttons use a
 * dashboard-specific id namespace ({@link DASHBOARD_BUTTON_IDS}) so the shared
 * handler re-renders this layout (not the `/status` one) when they are clicked.
 * A second row adds a commissioner-only green **Advance Week** button
 * ({@link DASHBOARD_ADVANCE_BUTTON_IDS}) that runs the `/advance` flow after a
 * confirmation prompt.
 *
 * The deadline renders as a native Discord timestamp, so "time remaining"
 * updates on its own in every viewer's client without the bot re-editing the
 * message.
 */
export async function buildStatusDashboardMessage(
  summary: ReadySummary,
): Promise<Pick<MessageCreateOptions, "embeds" | "content" | "components">> {
  const { EmbedBuilder } = await import(/* webpackIgnore: true */ "discord.js");

  const readyEntries = summary.entries.filter((entry) => entry.status === "READY");
  const notReadyEntries = summary.entries.filter((entry) => entry.status !== "READY");

  const progress =
    `${summary.readyCount}/${summary.requiredCount} ready` +
    (summary.requiredCount !== summary.totalCount
      ? ` (of ${summary.totalCount} teams)`
      : "");

  const deadline = formatDeadline(summary.deadline);

  const embed: EmbedBuilder = new EmbedBuilder()
    .setTitle(`📊 Dynasty Status — ${summary.weekName}`)
    .setColor(summary.canAdvance ? 0x2ecc71 : 0xe67e22)
    .addFields(
      {
        name: "Deadline",
        value: deadline ? `⏳ ${deadline}` : "_No deadline set._",
      },
      {
        name: `${READY_EMOJI} Ready (${readyEntries.length})`,
        value: formatTeamList(readyEntries, READY_EMOJI),
        inline: true,
      },
      {
        name: `${NOT_READY_EMOJI} Not Ready (${notReadyEntries.length})`,
        value: formatTeamList(notReadyEntries, NOT_READY_EMOJI),
        inline: true,
      },
      { name: "Progress", value: progress },
    )
    .setFooter({
      text: summary.canAdvance
        ? "Enough teams are ready — a commissioner can run /advance."
        : "Waiting on more teams to mark ready. Use the buttons below to check in.",
    })
    .setTimestamp(new Date());

  const row: ActionRowBuilder<ButtonBuilder> = await buildReadyButtonRow(
    DASHBOARD_BUTTON_IDS,
  );
  const advanceRow: ActionRowBuilder<ButtonBuilder> = await buildAdvanceButtonRow();

  return { embeds: [embed], components: [row, advanceRow] };
}
