import { SlashCommandBuilder } from "discord.js";
import type {
  ChatInputCommandInteraction,
  Client,
  InteractionReplyOptions,
  MessageCreateOptions,
} from "discord.js";
import { buildAdvanceConfirmRow } from "@/bot/commands/advanceButton";
import type { BotCommand } from "@/bot/commands/types";
import { fetchSendableTextChannel } from "@/bot/channels";
import { getAnnounceChannelId, getLeagueConfig } from "@/bot/config";
import { logError } from "@/bot/logger";
import { isCommissioner } from "@/bot/permissions";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getReadyStore } from "@/bot/store/readyStore";
import type { AdvanceOptions } from "@/bot/store/readyStore";
import { MS_PER_HOUR } from "@/bot/time";
import { buildReadyStatusMessage, formatDeadline } from "@/bot/ui/readyMessage";
import type { AdvanceResult } from "@/lib/types";

/**
 * A minimal channel we can post the public advance announcement to. Both the
 * dashboard button's interaction channel and a fetched announce channel satisfy
 * this, so the announcement helper can accept either.
 */
type SendableChannel = { send: (options: MessageCreateOptions) => Promise<unknown> };

/** Narrow an unknown channel to something we can `.send()` an announcement to. */
function asSendableChannel(channel: unknown): SendableChannel | undefined {
  if (
    channel &&
    typeof channel === "object" &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
  ) {
    return channel as SendableChannel;
  }
  return undefined;
}

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
        `The week could not be advanced right now for ${summary.weekName} ` +
        `(${summary.readyCount}/${summary.totalCount} ready). Please try again shortly.`,
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
    // Best-effort — the updater never throws.
    await updateStatusDashboard(client);
  }

  return { result, payload };
}

/**
 * Build the mass-tag mention (and matching `allowedMentions`) used to ping the
 * whole league in the public advance announcement. Uses the configured league
 * role when set, otherwise falls back to `@everyone`.
 */
function buildMassTag(): { mention: string; allowedMentions: Record<string, unknown> } {
  const { leagueRoleId } = getLeagueConfig();
  if (leagueRoleId) {
    return {
      mention: `<@&${leagueRoleId}>`,
      allowedMentions: { roles: [leagueRoleId] },
    };
  }
  return { mention: "@everyone", allowedMentions: { parse: ["everyone"] } };
}

/**
 * Post the public "week advanced" announcement (mass-tagging the whole league)
 * and, when every team was already marked ready, a separate heads-up to the
 * commissioners so they know they can safely force the advance in-game.
 *
 * The announcement is posted to the configured announce channel (falling back to
 * `fallbackChannel` — usually the channel the advance was triggered from — when
 * `ANNOUNCE_CHANNEL_ID` is unset). It never falls back to the status channel.
 * Best-effort: it logs and swallows errors so a failed announcement never breaks
 * the advance flow.
 */
export async function postAdvanceAnnouncements(
  client: Client,
  result: AdvanceResult,
  fallbackChannel?: unknown,
): Promise<void> {
  if (!result.advanced) {
    return;
  }

  try {
    const config = getLeagueConfig();
    const channelId = getAnnounceChannelId();

    // Prefer the configured announce/status channel; otherwise post wherever the
    // advance was triggered from.
    let channel: SendableChannel | undefined;
    if (channelId) {
      channel = asSendableChannel(await fetchSendableTextChannel(client, channelId));
    }
    if (!channel) {
      channel = asSendableChannel(fallbackChannel);
    }
    if (!channel) {
      logError("Advance announcement skipped: no sendable announce channel could be resolved.");
      return;
    }

    // Public announcement, mass-tagging the whole league.
    const payload = await buildAdvanceReplyPayload(result);
    const { mention, allowedMentions } = buildMassTag();
    const announcement = payload.content ? `${mention}\n${payload.content}` : mention;
    await channel.send({
      embeds: payload.embeds,
      components: payload.components,
      content: announcement,
      allowedMentions,
    } as MessageCreateOptions);

    // When everyone was already ready, ping the commissioners separately so they
    // know they can force the advance in-game. Needs a role to tag.
    if (result.everyoneReady && config.commissionerRoleId) {
      await channel.send({
        content:
          `<@&${config.commissionerRoleId}> ✅ Every team is marked ready for ` +
          `**${result.previousWeekName}** — you're clear to force the advance in-game.`,
        allowedMentions: { roles: [config.commissionerRoleId] },
      } as MessageCreateOptions);
    }
  } catch (error) {
    logError("Failed to post the advance announcement", error);
  }
}

/**
 * `/advance` — advance the league to the next week. Restricted to commissioners
 * (configured role or Manage Server permission). Advancing no longer requires
 * teams to be ready: it always proceeds after a confirmation step.
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

    // Advancing no longer requires teams to be ready, but we still guard against
    // an accidental advance with a confirmation prompt. The shared Advance button
    // handler runs the actual advance once Confirm is pressed; any deadline
    // override is carried on the Confirm button's custom id.
    const row = await buildAdvanceConfirmRow(deadlineOverrideHours);
    await interaction.reply({
      content:
        "⚠️ **Advance the dynasty to the next week?**\n" +
        "This advances regardless of who is marked ready, resets every team's ready " +
        "status, and posts a public announcement. Use `/set-week` to move back.",
      components: [row],
      ephemeral: true,
    });
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
