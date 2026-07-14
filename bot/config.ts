import type { LeagueConfig } from "@/lib/types";

/**
 * Default dynasty id used when `LEAGUE_DYNASTY_ID` is not set. This scopes the
 * Supabase rows (teams, week_states, team_ready_states) the bot coordinates.
 */
export const DEFAULT_DYNASTY_ID = "default";

/**
 * Parse the configured start week. The value is interpreted as a 0-based index
 * into the dynasty schedule (see `lib/weekSchedule.ts`), so `0` is the first week
 * (Preseason). Non-numeric/negative input falls back to the schedule start.
 */
function parseWeek(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolve the advance threshold. Accepts:
 *  - "ALL" (case-insensitive) or empty -> null (every team must be ready)
 *  - a positive integer -> that many ready teams are required
 */
function parseThreshold(value: string | undefined): number | null {
  if (!value || value.trim().toUpperCase() === "ALL") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Build the league configuration from environment variables. Kept in a single
 * place so the ready store and slash commands share one source of truth.
 */
export function getLeagueConfig(): LeagueConfig {
  return {
    dynastyId: process.env.LEAGUE_DYNASTY_ID?.trim() || DEFAULT_DYNASTY_ID,
    startWeek: parseWeek(process.env.LEAGUE_START_WEEK, 0),
    advanceThreshold: parseThreshold(process.env.LEAGUE_ADVANCE_THRESHOLD),
    commissionerRoleId: process.env.DISCORD_COMMISSIONER_ROLE_ID?.trim() || undefined,
    leagueRoleId: process.env.DISCORD_LEAGUE_ROLE_ID?.trim() || undefined,
  };
}

/** The guild the bot registers its commands against (guild-scoped for now). */
export function getGuildId(): string | undefined {
  return process.env.DISCORD_GUILD_ID?.trim() || undefined;
}

/** The Discord application id, required to register slash commands. */
export function getApplicationId(): string | undefined {
  return process.env.DISCORD_APPLICATION_ID?.trim() || undefined;
}

/** The Discord bot token used to log in to the gateway. */
export function getBotToken(): string | undefined {
  return process.env.DISCORD_BOT_TOKEN?.trim() || undefined;
}

/**
 * The Discord channel id where the Weekly Newspaper is posted. When unset, the
 * newspaper is generated and stored but not posted to a channel (a warning is
 * logged). Set `NEWSPAPER_CHANNEL_ID` to enable posting.
 */
export function getNewspaperChannelId(): string | undefined {
  return process.env.NEWSPAPER_CHANNEL_ID?.trim() || undefined;
}

/**
 * The Discord channel id that hosts the persistent status dashboard. When unset,
 * the dashboard is not maintained.
 */
export function getStatusChannelId(): string | undefined {
  return process.env.STATUS_CHANNEL_ID?.trim() || undefined;
}

/**
 * The Discord channel id where the public "week advanced" announcement (with its
 * mass tag) is posted. Only `ANNOUNCE_CHANNEL_ID` is used — it intentionally does
 * *not* fall back to the status channel so mass-tag messages never land in the
 * status dashboard channel. When unset, the announcement is posted in the channel
 * the advance was triggered from.
 */
export function getAnnounceChannelId(): string | undefined {
  return process.env.ANNOUNCE_CHANNEL_ID?.trim() || undefined;
}

/**
 * The Discord channel id that receives the recurring "not ready" reminders.
 * Set `REMINDER_CHANNEL_ID` to post reminders to a dedicated channel. When
 * unset, reminders fall back to the announce channel (`ANNOUNCE_CHANNEL_ID`) so
 * they land where weekly advance announcements are posted. `STATUS_CHANNEL_ID`
 * remains the final legacy fallback; when none are set, reminders are skipped
 * (a warning is logged).
 */
export function getReminderChannelId(): string | undefined {
  return (
    process.env.REMINDER_CHANNEL_ID?.trim() ||
    getAnnounceChannelId() ||
    getStatusChannelId()
  );
}

/**
 * Whether the bot should attempt to start/log in. Defaults to disabled so the
 * Next.js app can run (build, preview, tests) without Discord credentials.
 */
export function isBotEnabled(): boolean {
  return process.env.DISCORD_BOT_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Resolved OneDrive / Microsoft Graph configuration for the background
 * screenshot monitor. All fields are optional so the bot runs fine without
 * OneDrive configured; {@link isOnedriveConfigured} reports whether the minimum
 * required values are present.
 */
export interface OnedriveConfig {
  /** Azure AD application (client) id. */
  clientId?: string;
  /** Azure AD application client secret. */
  clientSecret?: string;
  /** Azure AD tenant id (or "common"/"consumers"/"organizations"). */
  tenantId?: string;
  /**
   * Root OneDrive folder path to monitor, relative to the drive root
   * (e.g. "Xbox Screenshots"). Leading/trailing slashes are trimmed.
   */
  monitoredPath?: string;
  /**
   * Optional folder path (relative to the drive root) to move processed files
   * into. When unset, processed files are left in place.
   */
  processedPath?: string;
  /**
   * Optional explicit drive id to target. Required for app-only access to a
   * specific user's OneDrive; when unset the client falls back to `/me/drive`.
   */
  driveId?: string;
  /** How often (ms) the background monitor polls for new screenshots. */
  pollIntervalMs: number;
}

/** Trim surrounding whitespace and slashes from a OneDrive folder path. */
function normalizeFolderPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? trimmed : undefined;
}

/** Default OneDrive poll cadence: 3 minutes. */
const DEFAULT_ONEDRIVE_POLL_INTERVAL_MS = 3 * 60 * 1000;

/**
 * Parse the OneDrive poll interval (in minutes) from the environment, clamped to
 * a sane minimum so a misconfiguration can't hammer the Graph API.
 */
function parsePollIntervalMs(value: string | undefined): number {
  const minutes = Number.parseFloat(value ?? "");
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_ONEDRIVE_POLL_INTERVAL_MS;
  }
  // Never poll more often than once per minute.
  return Math.max(minutes, 1) * 60 * 1000;
}

/**
 * Read the OneDrive / Microsoft Graph configuration from the environment. Kept
 * in one place so the monitor, poller, and manual commands share a single source
 * of truth.
 */
export function getOnedriveConfig(): OnedriveConfig {
  return {
    clientId: process.env.ONEDRIVE_CLIENT_ID?.trim() || undefined,
    clientSecret: process.env.ONEDRIVE_CLIENT_SECRET?.trim() || undefined,
    tenantId: process.env.ONEDRIVE_TENANT_ID?.trim() || undefined,
    monitoredPath: normalizeFolderPath(process.env.ONEDRIVE_MONITORED_PATH),
    processedPath: normalizeFolderPath(process.env.ONEDRIVE_PROCESSED_PATH),
    driveId: process.env.ONEDRIVE_DRIVE_ID?.trim() || undefined,
    pollIntervalMs: parsePollIntervalMs(process.env.ONEDRIVE_POLL_INTERVAL_MINUTES),
  };
}

/**
 * Whether OneDrive monitoring has the minimum configuration to run: Azure AD
 * credentials (client id/secret/tenant) plus a monitored folder path.
 */
export function isOnedriveConfigured(config: OnedriveConfig = getOnedriveConfig()): boolean {
  return Boolean(
    config.clientId &&
      config.clientSecret &&
      config.tenantId &&
      config.monitoredPath,
  );
}

/**
 * Whether the background OneDrive poller should run on startup. Requires OneDrive
 * to be configured and `ONEDRIVE_MONITOR_ENABLED` not explicitly set to "false"
 * (so it defaults on once credentials are present, but can be disabled without
 * removing the credentials).
 */
export function isOnedriveMonitorEnabled(): boolean {
  if (!isOnedriveConfigured()) {
    return false;
  }
  return process.env.ONEDRIVE_MONITOR_ENABLED?.trim().toLowerCase() !== "false";
}

/**
 * Optional Discord channel id where the OneDrive monitor posts a short summary
 * after processing new screenshots. Falls back to `STATUS_CHANNEL_ID`; when
 * neither is set, processing is silent (still logged).
 */
export function getOnedriveNotifyChannelId(): string | undefined {
  return process.env.ONEDRIVE_NOTIFY_CHANNEL_ID?.trim() || getStatusChannelId();
}

/**
 * Resolved, validated bot configuration.
 *
 * `errors` lists any missing *required* values that prevent login; `warnings`
 * lists missing *optional* values that only degrade functionality (for example
 * a missing application/guild id means commands can't be registered, but the
 * bot can still log in). Callers should refuse to start when `errors` is
 * non-empty and surface `warnings` for visibility.
 */
export interface BotConfig {
  enabled: boolean;
  token?: string;
  applicationId?: string;
  guildId?: string;
  errors: string[];
  warnings: string[];
}

/**
 * Read and validate the Discord bot configuration from the environment in one
 * place, so startup logic doesn't have to re-check individual variables.
 */
export function getBotConfig(): BotConfig {
  const enabled = isBotEnabled();
  const token = getBotToken();
  const applicationId = getApplicationId();
  const guildId = getGuildId();

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!token) {
    errors.push("DISCORD_BOT_TOKEN is required to log in.");
  }

  // Command registration is guild-scoped for now and needs both ids. Missing
  // ids are non-fatal: the bot can still log in and respond to existing
  // (already-registered) commands.
  if (!applicationId) {
    warnings.push(
      "DISCORD_APPLICATION_ID is missing; slash commands will not be registered.",
    );
  }
  if (!guildId) {
    warnings.push(
      "DISCORD_GUILD_ID is missing; guild-scoped slash commands will not be registered.",
    );
  }

  return { enabled, token, applicationId, guildId, errors, warnings };
}
