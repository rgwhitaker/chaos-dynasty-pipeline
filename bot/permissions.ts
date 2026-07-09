import { PermissionFlagsBits } from "discord.js";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMemberRoleManager,
  ModalSubmitInteraction,
} from "discord.js";
import type { LeagueConfig } from "@/lib/types";

/**
 * Any interaction that carries guild-member context we can authorize against.
 * The commissioner check only reads `member.roles` and `memberPermissions`,
 * both of which are present on slash-command, button, and modal interactions —
 * so the same gate can protect `/advance` and the dashboard Advance button.
 */
export type CommissionerCheckableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

/**
 * Determine whether the interaction's member is allowed to run commissioner-only
 * actions such as `/advance` or the dashboard Advance button.
 *
 * A member qualifies if either:
 *  - they hold the configured commissioner role (`DISCORD_COMMISSIONER_ROLE_ID`), or
 *  - they have the Manage Server permission (a reasonable default for admins).
 */
export function isCommissioner(
  interaction: CommissionerCheckableInteraction,
  config: LeagueConfig,
): boolean {
  // Role-based check (preferred when configured).
  if (config.commissionerRoleId) {
    const roles = interaction.member?.roles;
    if (roles && typeof roles !== "string" && "cache" in roles) {
      if ((roles as GuildMemberRoleManager).cache.has(config.commissionerRoleId)) {
        return true;
      }
    }
  }

  // Permission-based fallback: Manage Server implies commissioner-level access.
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.ManageGuild));
}
