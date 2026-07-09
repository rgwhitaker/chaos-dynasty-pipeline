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

/**
 * Custom ids for the buttons shown on the persistent status dashboard message.
 * They are distinct from {@link READY_BUTTON_IDS} so the shared button handler
 * can tell which message it is editing (the ephemeral `/status` reply vs. the
 * single shared dashboard message) and re-render it with the matching layout.
 */
export const DASHBOARD_BUTTON_IDS = {
  markReady: "status-dashboard:mark",
  markNotReady: "status-dashboard:unmark",
  refresh: "status-dashboard:refresh",
} as const;

/**
 * Custom ids for the commissioner-only Advance flow on the persistent status
 * dashboard message. `advance` opens an ephemeral confirmation; `confirm` and
 * `cancel` back the two buttons on that confirmation prompt. They share the
 * dashboard id namespace so the interaction router can recognise and dispatch
 * them from the global `InteractionCreate` listener, which keeps them working
 * across bot restarts with no per-message collectors to re-register.
 */
export const DASHBOARD_ADVANCE_BUTTON_IDS = {
  advance: "status-dashboard:advance",
  confirm: "status-dashboard:advance-confirm",
  cancel: "status-dashboard:advance-cancel",
} as const;

/** The shape of a set of ready-button custom ids (mark / unmark / refresh). */
export type ReadyButtonIds = {
  markReady: string;
  markNotReady: string;
  refresh: string;
};

const READY_EMOJI = "✅";
const NOT_READY_EMOJI = "⛔";

/**
 * Format an ISO deadline as a Discord timestamp so every viewer sees it in their
 * own timezone, with a relative "in N hours" hint. Returns `undefined` when
 * there is no deadline to show.
 */
export function formatDeadline(deadline?: string): string | undefined {
  if (!deadline) {
    return undefined;
  }
  const parsed = Date.parse(deadline);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  const unix = Math.floor(parsed / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

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
 * Build the shared Mark Ready / Mark Not Ready / Refresh button row. The custom
 * ids are passed in so the same layout can back both the `/status` reply and the
 * persistent status dashboard while remaining individually addressable by the
 * button handler. discord.js runtime classes are imported dynamically to match
 * the rest of the UI modules.
 */
export async function buildReadyButtonRow(
  ids: ReadyButtonIds,
): Promise<ActionRowBuilder<ButtonBuilder>> {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import(
    /* webpackIgnore: true */ "discord.js"
  );

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ids.markReady)
      .setLabel("Mark Ready")
      .setEmoji(READY_EMOJI)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ids.markNotReady)
      .setLabel("Mark Not Ready")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ids.refresh)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Primary),
  );
}

/**
 * Build the rich status embed shown by `/status`, `/ready`, and button updates.
 * discord.js runtime classes are imported dynamically so this module can be
 * loaded without eagerly pulling in the (server-external) discord.js package.
 */
export async function buildReadyStatusMessage(
  summary: ReadySummary,
): Promise<Pick<InteractionReplyOptions, "embeds" | "components">> {
  const { EmbedBuilder } = await import(/* webpackIgnore: true */ "discord.js");

  const progress = `${summary.readyCount}/${summary.requiredCount} ready` +
    (summary.requiredCount !== summary.totalCount
      ? ` (of ${summary.totalCount} teams)`
      : "");

  const embed: EmbedBuilder = new EmbedBuilder()
    .setTitle(`${summary.weekName} — Ready Check`)
    .setDescription(formatReadyLines(summary))
    .addFields({ name: "Progress", value: progress, inline: true })
    .setColor(summary.canAdvance ? 0x2ecc71 : 0xe67e22)
    .setFooter({
      text: summary.canAdvance
        ? "Enough teams are ready — a commissioner can run /advance."
        : "Waiting on more teams to mark ready.",
    })
    .setTimestamp(new Date());

  // Surface the current week's deadline when one is set.
  const deadline = formatDeadline(summary.deadline);
  if (deadline) {
    embed.addFields({ name: "Deadline", value: deadline, inline: true });
  }

  const row: ActionRowBuilder<ButtonBuilder> = await buildReadyButtonRow(READY_BUTTON_IDS);

  return { embeds: [embed], components: [row] };
}
