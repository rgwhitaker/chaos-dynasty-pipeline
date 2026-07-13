import type { ButtonInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { notifyCommissionersIfEveryoneReady } from "@/bot/allReadyNotifier";
import { advanceCommand } from "@/bot/commands/advance";
import { deleteTeamCommand } from "@/bot/commands/deleteTeam";
import { editTeamCommand } from "@/bot/commands/editTeam";
import { importFromOnedriveCommand } from "@/bot/commands/importFromOnedrive";
import { newspaperCommand } from "@/bot/commands/newspaper";
import { pingCommand } from "@/bot/commands/ping";
import { processScreenshotCommand } from "@/bot/commands/processScreenshot";
import { processVideoCommand } from "@/bot/commands/processVideo";
import { readyCommand } from "@/bot/commands/ready";
import { registerCommand } from "@/bot/commands/register";
import { setEmojiCommand } from "@/bot/commands/setEmoji";
import { setReadyCommand } from "@/bot/commands/setReady";
import { setWeekCommand } from "@/bot/commands/setWeek";
import { statusCommand } from "@/bot/commands/status";
import { syncOnedriveCommand } from "@/bot/commands/syncOnedrive";
import { unlinkCommand } from "@/bot/commands/unlink";
import { updateStatusDashboard } from "@/bot/statusDashboard";
import { getReadyStore } from "@/bot/store/readyStore";
import {
  buildReadyStatusMessage,
  DASHBOARD_BUTTON_IDS,
  READY_BUTTON_IDS,
  type ReadyButtonIds,
} from "@/bot/ui/readyMessage";
import { buildStatusDashboardMessage } from "@/bot/ui/statusDashboard";

/** All slash commands the bot exposes. */
export const commands: BotCommand[] = [
  readyCommand,
  statusCommand,
  advanceCommand,
  setWeekCommand,
  newspaperCommand,
  registerCommand,
  setReadyCommand,
  setEmojiCommand,
  editTeamCommand,
  unlinkCommand,
  deleteTeamCommand,
  pingCommand,
  processVideoCommand,
  processScreenshotCommand,
  syncOnedriveCommand,
  importFromOnedriveCommand,
];

/** Lookup by command name, used by the interaction dispatcher. */
export const commandMap = new Map<string, BotCommand>(
  commands.map((command) => [command.data.name, command]),
);

/** JSON payloads used to register the commands with the Discord API. */
export function getCommandPayloads() {
  return commands.map((command) => command.data.toJSON());
}

/** Re-exported so the client's interaction router can dispatch dashboard buttons. */
export { handleAdvanceButton } from "@/bot/commands/advanceButton";

/**
 * Handle the ready-status buttons. The same three actions (mark ready, mark not
 * ready, refresh) back two surfaces: the ephemeral `/status` reply and the
 * single shared persistent status dashboard message. Each surface uses its own
 * custom-id namespace ({@link READY_BUTTON_IDS} / {@link DASHBOARD_BUTTON_IDS})
 * so this handler can re-render the clicked message with its matching layout,
 * while sharing all of the underlying store logic.
 *
 * Because interactions are dispatched by custom id from the client's global
 * `InteractionCreate` listener (not per-message collectors), the dashboard
 * buttons keep working after a bot restart with no extra re-registration.
 *
 * Returns true when the interaction was handled so the client can fall through
 * to other button handlers otherwise.
 */
export async function handleReadyButton(interaction: ButtonInteraction): Promise<boolean> {
  const { customId } = interaction;

  const isReadyButton = Object.values(READY_BUTTON_IDS).includes(customId as never);
  const isDashboardButton = Object.values(DASHBOARD_BUTTON_IDS).includes(customId as never);
  if (!isReadyButton && !isDashboardButton) {
    return false;
  }

  const store = getReadyStore();

  // Pick the id set + renderer for whichever surface was clicked. When acting
  // from the dashboard message itself, editing the reply already updates the
  // shared dashboard, so there is no separate dashboard to sync afterwards.
  const ids: ReadyButtonIds = isDashboardButton ? DASHBOARD_BUTTON_IDS : READY_BUTTON_IDS;
  const buildMessage = isDashboardButton
    ? buildStatusDashboardMessage
    : buildReadyStatusMessage;

  // The refresh button just re-renders the current status for everyone.
  if (customId === ids.refresh) {
    await interaction.deferUpdate();
    try {
      const summary = await store.getReadySummary();
      const message = await buildMessage(summary);
      await interaction.editReply(message);
    } catch (error) {
      console.error("[ready-button] Failed to refresh status", error);
      await interaction.followUp({
        content: "Sorry, I couldn't refresh the status right now. Please try again shortly.",
        ephemeral: true,
      });
    }
    return true;
  }

  // Mark/unmark buttons require a linked team (same rule as `/ready`). On the
  // shared dashboard message all members see these buttons, so unlinked users
  // are turned away here with an ephemeral note instead of being able to act.
  let team;
  try {
    team = await store.getTeamByDiscordUserId(interaction.user.id);
  } catch (error) {
    console.error("[ready-button] Failed to look up linked team", error);
    await interaction.reply({
      content: "Sorry, I couldn't reach the league data right now. Please try again shortly.",
      ephemeral: true,
    });
    return true;
  }

  if (!team) {
    await interaction.reply({
      content:
        "You are not linked to a team, so you can't set a ready status. " +
        "Ask a commissioner to link your Discord account to a team.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferUpdate();
  try {
    const wantsReady = customId === ids.markReady;
    await store.setReadyStatus(team.id, wantsReady ? "READY" : "NOT_READY", interaction.user.id);

    const summary = await store.getReadySummary();
    const message = await buildMessage(summary);
    // Update the message the button lives on in place so everyone sees the change.
    await interaction.editReply(message);

    // From an ephemeral `/status` reply we still need to sync the separate
    // persistent dashboard; from the dashboard itself the edit above already did.
    if (!isDashboardButton) {
      await updateStatusDashboard(interaction.client);
    }

    // Ping commissioners if this change made every team ready.
    await notifyCommissionersIfEveryoneReady(interaction.client);
  } catch (error) {
    console.error("[ready-button] Failed to update ready status", error);
    await interaction.followUp({
      content: "Sorry, I couldn't update your ready status right now. Please try again shortly.",
      ephemeral: true,
    });
  }
  return true;
}
