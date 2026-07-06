import { PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction, GuildMemberRoleManager } from "discord.js";
import type { LeagueConfig } from "@/lib/types";

/**
 * Determine whether the interaction's member is allowed to run commissioner-only
 * commands such as `/advance`.
 *
 * A member qualifies if either:
 *  - they hold the configured commissioner role (`DISCORD_COMMISSIONER_ROLE_ID`), or
 *  - they have the Manage Server permission (a reasonable default for admins).
 */
export function isCommissioner(
  interaction: ChatInputCommandInteraction,
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
