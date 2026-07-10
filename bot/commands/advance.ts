import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, InteractionReplyOptions } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getBotStateStore } from "@/bot/store/botStateStore";
import { getReadyStore } from "@/bot/store/readyStore";
import type { AdvanceOptions } from "@/bot/store/readyStore";
import { MS_PER_HOUR } from "@/bot/time";
import { buildReadyStatusMessage, formatDeadline } from "@/bot/ui/readyMessage";
import type { AdvanceResult } from "@/lib/types";

/** Bounds for the optional deadline override (in hours). */
const MIN_DEADLINE_HOURS = 1;
const MAX_DEADLINE_HOURS = 720; // 30 days

/** A ready-to-send message payload describing the outcome of an advance attempt. */
export type AdvanceReplyPayload = Pick<
  InteractionReplyOptions,
  "content" | "embeds" | "components"
>;

/**
 * Render the message payload (announcement + status embed + buttons) that
 * describes the outcome of an {@link AdvanceResult}. Shared by the `/advance`
 * command and the dashboard Advance button so both surfaces speak identically,
 * covering all three outcomes: end-of-season, not-enough-ready, and advanced.
 */
export async function buildAdvanceReplyPayload(
  result: AdvanceResult,
): Promise<AdvanceReplyPayload> {
  if (!result.advanced) {
    // Already at the end of the schedule — there is nowhere left to go.
    if (result.atLastWeek) {
      const message = await buildReadyStatusMessage(result.summary);
      return {
        content:
          `**${result.previousWeekName}** is the final week of the season — ` +
          "there is nothing left to advance to. Use `/set-week` to jump to " +
          "another week if you need to reset the schedule.",
        ...message,
      };
    }

    const { summary } = result;
    const message = await buildReadyStatusMessage(summary);
    return {
      content:
        `Not enough teams are ready to advance ${summary.weekName} ` +
        `(${summary.readyCount}/${summary.requiredCount}). ` +
        "Re-run with `force: true` to advance anyway.",
      ...message,
    };
  }

  const message = await buildReadyStatusMessage(result.summary);
  const deadline = formatDeadline(result.deadline);
  const deadlineLine = deadline ? `\n🗓️ Deadline: ${deadline}` : "";
  // Announce, in plain language, when the next advance will happen.
  const nextAdvanceLine = formatNextAdvanceLine(result.deadline);
  const forcedLine = result.forced
    ? "\n⚠️ Forced advance — not all teams were marked ready in the bot."
    : "";

  return {
    content:
      `📢 The dynasty has advanced from **${result.previousWeekName}** to ` +
      `**${result.currentWeekName}**! Ready statuses have been reset.` +
      `${deadlineLine}${nextAdvanceLine}${forcedLine}`,
    ...message,
  };
}

/**
 * Run the shared advance logic against the ready store and, on a successful
 * advance, refresh the persistent status dashboard so it reflects the new week
 * and freshly-reset readiness. Returns both the raw {@link AdvanceResult} and a
 * ready-to-send {@link AdvanceReplyPayload}. This is the single entry point
 * reused by the `/advance` command and the dashboard Advance button.
 */
export async function executeAdvance(
  client: Client,
  options: AdvanceOptions,
): Promise<{ result: AdvanceResult; payload: AdvanceReplyPayload }> {
  const store = getReadyStore();
  const result = await store.advanceWeek(options);
  const payload = await buildAdvanceReplyPayload(result);

  if (result.advanced) {
    // Anchor the recurring reminder window on this advance so the next reminder
    // fires 12h from now (not on a fixed global schedule). Persisted so the
    // timing survives bot restarts. Best-effort — never block the advance.
    try {
      await getBotStateStore().setLastAdvanceAt(new Date().toISOString());
    } catch (error) {
      console.error("[advance] Failed to record last advance time", error);
    }

    // Best-effort — the updater never throws.
    await updateStatusDashboard(client);
  }

  return { result, payload };
}

/**
 * `/advance` — advance the league to the next week once enough teams are ready.
 * Restricted to commissioners (configured role or Manage Server permission).
 *
 * An optional `deadline_hours` overrides the automatically-calculated deadline
 * window for the new week (e.g. force 24h even on a 48h game week).
 *
 * Advancing only rolls the week forward, resets readiness, and announces the new
 * week. Generating the Weekly Newspaper is fully manual via `/newspaper`.
 */
export const advanceCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("advance")
    .setDescription("Advance the league to the next week (commissioners only).")
    .addIntegerOption((option) =>
      option
        .setName("deadline_hours")
        .setDescription(
          "Override the new week's deadline window, in hours (default: 48 game weeks / 24 otherwise).",
        )
        .setMinValue(MIN_DEADLINE_HOURS)
        .setMaxValue(MAX_DEADLINE_HOURS),
    )
    .addBooleanOption((option) =>
      option
        .setName("force")
        .setDescription(
          "Advance even if not enough teams are marked ready (e.g. ready in-game or past deadline).",
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const config = getLeagueConfig();

    // Permission check: commissioners only.
    if (!isCommissioner(interaction, config)) {
      await interaction.reply({
        content: "Only commissioners can advance the week.",
        ephemeral: true,
      });
      return;
    }

    const deadlineOverrideHours =
      interaction.options.getInteger("deadline_hours") ?? undefined;
    const force = interaction.options.getBoolean("force") ?? false;

    // Defer the public reply so advancing (which touches the store) stays within
    // Discord's response window.
    await interaction.deferReply();

    try {
      const { payload } = await executeAdvance(interaction.client, {
        deadlineOverrideHours,
        force,
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.error("[advance] Failed to advance the week", error);
      await interaction.editReply({
        content: "Sorry, I couldn't advance the week right now. Please try again shortly.",
      });
    }
  },
};

/**
 * Build the "We will advance again in ~N hours" line from the new deadline, so
 * the announcement clearly states when the next advance window closes. Returns
 * an empty string when there is no deadline (or it is already in the past).
 */
function formatNextAdvanceLine(deadline?: string): string {
  if (!deadline) {
    return "";
  }

  const parsed = Date.parse(deadline);
  if (Number.isNaN(parsed)) {
    return "";
  }

  const hours = Math.round((parsed - Date.now()) / MS_PER_HOUR);
  if (hours <= 0) {
    return "";
  }

  const unit = hours === 1 ? "hour" : "hours";
  return `\n⏭️ We will advance again in ~${hours} ${unit} (once enough teams are ready).`;
}
