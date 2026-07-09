import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
} from "discord.js";
import { executeAdvance } from "@/bot/commands/advance";
import { getLeagueConfig } from "@/bot/config";
import { isCommissioner } from "@/bot/permissions";
import { DASHBOARD_ADVANCE_BUTTON_IDS } from "@/bot/ui/readyMessage";

const ADVANCE_EMOJI = "⏭️";

/**
 * Build the ephemeral confirmation prompt shown after a commissioner clicks the
 * dashboard **Advance Week** button. It carries Confirm / Cancel buttons so an
 * accidental click can't roll the week forward — the actual advance only runs
 * once Confirm is pressed.
 */
async function buildAdvanceConfirmRow(): Promise<ActionRowBuilder<ButtonBuilder>> {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import(
    /* webpackIgnore: true */ "discord.js"
  );

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(DASHBOARD_ADVANCE_BUTTON_IDS.confirm)
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
 * Handle the commissioner-only Advance flow on the persistent status dashboard:
 *
 *  1. **Advance Week** (`advance`) — verify the clicker is a commissioner, then
 *     reply with an ephemeral Confirm / Cancel prompt to guard against accidental
 *     advances. The prompt is only ever seen by the person who clicked.
 *  2. **Cancel** (`cancel`) — dismiss the prompt without advancing.
 *  3. **Confirm Advance** (`confirm`) — re-check permissions, run the shared
 *     {@link executeAdvance} logic (roll the week, recalculate the deadline,
 *     reset readiness, refresh the dashboard), post the advance announcement
 *     publicly in the channel, and collapse the ephemeral prompt to a receipt.
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

  if (customId !== ids.advance && customId !== ids.confirm && customId !== ids.cancel) {
    return false;
  }

  // Commissioner gate applies to every step: even if a regular member somehow
  // triggers a confirm/cancel id, they cannot advance the week.
  const config = getLeagueConfig();
  if (!isCommissioner(interaction, config)) {
    await interaction.reply({
      content: "Only commissioners can advance the week.",
      ephemeral: true,
    });
    return true;
  }

  // Step 1: open the confirmation prompt (ephemeral, only the clicker sees it).
  if (customId === ids.advance) {
    const row = await buildAdvanceConfirmRow();
    await interaction.reply({
      content:
        "⚠️ **Advance the dynasty to the next week?**\n" +
        "This resets every team's ready status and announces the new week. " +
        "This can't be undone from here (use `/set-week` to move back).",
      components: [row],
      ephemeral: true,
    });
    return true;
  }

  // Step 2: the commissioner backed out — collapse the prompt.
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
    const { result, payload } = await executeAdvance(interaction.client, {});

    if (result.advanced) {
      // Post the public announcement in the channel the dashboard lives in, then
      // leave the commissioner a short ephemeral receipt.
      const channel = interaction.channel;
      if (channel && "send" in channel) {
        await channel.send(payload);
      }
      await interaction.editReply({
        content: `✅ Advanced to **${result.currentWeekName}**. The announcement has been posted.`,
        components: [],
      });
      return true;
    }

    // Not advanced (end of season or not enough teams ready): surface the reason
    // to the commissioner privately without spamming the channel.
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
