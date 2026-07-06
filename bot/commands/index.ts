import type { ButtonInteraction } from "discord.js";
import type { BotCommand } from "@/bot/commands/types";
import { advanceCommand } from "@/bot/commands/advance";
import { deleteTeamCommand } from "@/bot/commands/deleteTeam";
import { editTeamCommand } from "@/bot/commands/editTeam";
import { pingCommand } from "@/bot/commands/ping";
import { readyCommand } from "@/bot/commands/ready";
import { registerCommand } from "@/bot/commands/register";
import { setEmojiCommand } from "@/bot/commands/setEmoji";
import { setReadyCommand } from "@/bot/commands/setReady";
import { statusCommand } from "@/bot/commands/status";
import { unlinkCommand } from "@/bot/commands/unlink";
import { getReadyStore } from "@/bot/store/readyStore";
import { buildReadyStatusMessage, READY_BUTTON_IDS } from "@/bot/ui/readyMessage";

/** All slash commands the bot exposes. */
export const commands: BotCommand[] = [
  readyCommand,
  statusCommand,
  advanceCommand,
  registerCommand,
  setReadyCommand,
  setEmojiCommand,
  editTeamCommand,
  unlinkCommand,
  deleteTeamCommand,
  pingCommand,
];

/** Lookup by command name, used by the interaction dispatcher. */
export const commandMap = new Map<string, BotCommand>(
  commands.map((command) => [command.data.name, command]),
);

/** JSON payloads used to register the commands with the Discord API. */
export function getCommandPayloads() {
  return commands.map((command) => command.data.toJSON());
}

/**
 * Handle the ready-status buttons. Returns true when the interaction was handled
 * so the client can fall through to other button handlers otherwise.
 */
export async function handleReadyButton(interaction: ButtonInteraction): Promise<boolean> {
  const { customId } = interaction;
  if (!Object.values(READY_BUTTON_IDS).includes(customId as never)) {
    return false;
  }

  const store = getReadyStore();

  // The refresh button just re-renders the current status for everyone.
  if (customId === READY_BUTTON_IDS.refresh) {
    await interaction.deferUpdate();
    try {
      const summary = await store.getReadySummary();
      const message = await buildReadyStatusMessage(summary);
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

  // Mark/unmark buttons require a linked team (same rule as `/ready`).
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
    const wantsReady = customId === READY_BUTTON_IDS.markReady;
    await store.setReadyStatus(team.id, wantsReady ? "READY" : "NOT_READY", interaction.user.id);

    const summary = await store.getReadySummary();
    const message = await buildReadyStatusMessage(summary);
    // Update the shared status message in place so everyone sees the change.
    await interaction.editReply(message);
  } catch (error) {
    console.error("[ready-button] Failed to update ready status", error);
    await interaction.followUp({
      content: "Sorry, I couldn't update your ready status right now. Please try again shortly.",
      ephemeral: true,
    });
  }
  return true;
}
