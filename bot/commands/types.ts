import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

/**
 * A slash command module. `data` is the discord.js builder used both to register
 * the command with the Discord API and to describe its options; `execute` runs
 * when the command is invoked. Commands with autocomplete options also provide
 * an `autocomplete` handler.
 */
export interface BotCommand {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  /** Optional handler for autocomplete interactions on this command's options. */
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}
