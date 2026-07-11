import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
} from "discord.js";
import { executeAdvance, postAdvanceAnnouncements } from "@/bot/commands/advance";
import { ADVANCE_EMOJI, DASHBOARD_ADVANCE_BUTTON_IDS } from "@/bot/ui/readyMessage";

/**
 * Encode an optional deadline override (in hours) onto the Confirm button's
 * custom id. Because interactions are dispatched by custom id from the client's
 * global listener (not per-message collectors), any state the confirm step needs
 * — here, the `/advance` command's `deadline_hours` option — has to travel on the
 * id itself so it survives a bot restart. Format: `<confirm-id>` or
 * `<confirm-id>:<hours>`.
 */
function buildConfirmCustomId(deadlineOverrideHours?: number): string {
  const base = DASHBOARD_ADVANCE_BUTTON_IDS.confirm;
  return deadlineOverrideHours !== undefined
    ? `${base}:${deadlineOverrideHours}`
    : base;
}

/** Whether a custom id is a Confirm-Advance click (with or without a deadline). */
function isConfirmCustomId(customId: string): boolean {
  const base = DASHBOARD_ADVANCE_BUTTON_IDS.confirm;
  return customId === base || customId.startsWith(`${base}:`);
}

/** Parse the optional deadline override encoded on a Confirm button custom id. */
function parseConfirmDeadline(customId: string): number | undefined {
  const base = DASHBOARD_ADVANCE_BUTTON_IDS.confirm;
  if (!customId.startsWith(`${base}:`)) {
    return undefined;
  }
  const parsed = Number.parseInt(customId.slice(base.length + 1), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Build the ephemeral confirmation prompt shown before the week is advanced — by
 * either the dashboard **Advance Week** button or the `/advance` command. It
 * carries Confirm / Cancel buttons so an accidental click can't roll the week
 * forward — the actual advance only runs once Confirm is pressed. An optional
 * deadline override (from `/advance deadline_hours:`) is encoded on the Confirm
 * button so it is applied when the advance runs.
 */
export async function buildAdvanceConfirmRow(
  deadlineOverrideHours?: number,
): Promise<ActionRowBuilder<ButtonBuilder>> {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import(
    /* webpackIgnore: true */ "discord.js"
  );

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildConfirmCustomId(deadlineOverrideHours))
      .setLabel("Confirm Advance")
      .setEmoji(ADVANCE_EMOJI)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(DASHBOARD_ADVANCE_BUTTON_IDS.cancel)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Handle the Advance flow shared by the persistent status dashboard and the
 * `/advance` command. The dashboard button is open to everyone; the slash
 * command stays commissioner-only and opens its own copy of the confirmation.
 *
 *  1. **Advance Week** (`advance`) — reply with an ephemeral Confirm / Cancel
 *     prompt to guard against accidental advances. The prompt is only ever seen
 *     by the person who clicked.
 *  2. **Cancel** (`cancel`) — dismiss the prompt without advancing.
 *  3. **Confirm Advance** (`confirm`) — run the shared {@link executeAdvance}
 *     logic. Advancing no longer requires teams to be ready (`force: true`): it
 *     rolls the week, recalculates the deadline, resets readiness, refreshes the
 *     dashboard, posts the public mass-tag announcement in the main channel, and
 *     — when everyone was already ready — pings the commissioners separately.
 *
 * Because dispatch happens from the client's global `InteractionCreate` listener
 * keyed on custom id (not per-message collectors), these buttons keep working
 * after a bot restart with no re-registration. Returns `true` when the
 * interaction was one of the advance buttons so the caller can stop dispatching.
 */
export async function handleAdvanceButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const { customId } = interaction;
  const ids = DASHBOARD_ADVANCE_BUTTON_IDS;
  const isConfirm = isConfirmCustomId(customId);

  if (customId !== ids.advance && customId !== ids.cancel && !isConfirm) {
    return false;
  }

  // Step 1: open the confirmation prompt (ephemeral, only the clicker sees it).
  if (customId === ids.advance) {
    const row = await buildAdvanceConfirmRow();
    await interaction.reply({
      content:
        "⚠️ **Advance the dynasty to the next week?**\n" +
        "This advances regardless of who is marked ready, resets every team's ready " +
        "status, and posts a public announcement. This can't be undone from here " +
        "(use `/set-week` to move back).",
      components: [row],
      ephemeral: true,
    });
    return true;
  }

  // Step 2: the clicker backed out — collapse the prompt.
  if (customId === ids.cancel) {
    await interaction.update({
      content: "Advance cancelled — nothing was changed.",
      components: [],
    });
    return true;
  }

  // Step 3: confirmed — run the shared advance logic and announce the result.
  await interaction.update({ content: "⏳ Advancing the week…", components: [] });

  try {
    const deadlineOverrideHours = parseConfirmDeadline(customId);
    // Advancing no longer requires readiness — force it through so it always
    // proceeds once confirmed. Any /advance deadline override rides on the id.
    const { result, payload } = await executeAdvance(interaction.client, {
      force: true,
      deadlineOverrideHours,
    });

    if (result.advanced) {
      // Post the public mass-tag announcement (and the commissioner heads-up when
      // everyone was ready) in the main channel, then leave the clicker a short
      // ephemeral receipt.
      await postAdvanceAnnouncements(interaction.client, result, interaction.channel);
      await interaction.editReply({
        content: `✅ Advanced to **${result.currentWeekName}**. The announcement has been posted.`,
        components: [],
      });
      return true;
    }

    // Not advanced (end of season): surface the reason to the clicker privately
    // without spamming the channel.
    await interaction.editReply(payload);
  } catch (error) {
    console.error("[advance-button] Failed to advance the week", error);
    await interaction.editReply({
      content: "Sorry, I couldn't advance the week right now. Please try again shortly.",
      components: [],
    });
  }

  return true;
}
