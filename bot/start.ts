import { getBotConfig } from "@/bot/config";
import { loginDiscordBot, stopDiscordBot } from "@/bot/client";
import { logBot, logError, logWarn } from "@/bot/logger";

/**
 * Main Discord bot startup logic.
 *
 * This is the single entry point responsible for:
 *  - validating configuration (enabled flag + required env vars),
 *  - logging the client in and registering commands, and
 *  - wiring up graceful-shutdown handlers.
 *
 * It is invoked today from `instrumentation.ts` so the bot boots alongside the
 * Next.js server on Railway. Keeping the startup logic isolated here means we
 * could later run the bot as a COMPLETELY SEPARATE process/service instead
 * (e.g. a dedicated Railway service with its own start command such as
 * `tsx bot/start.ts`, or a small `bot/main.ts` that just calls `startBot()`),
 * without touching the Next.js app. That separation is preferable at scale
 * because the bot's gateway connection is long-lived and independent from HTTP
 * request handling.
 */

const globalForStart = globalThis as typeof globalThis & {
  discordShutdownRegistered?: boolean;
};

/**
 * Register process signal handlers so the bot disconnects cleanly when the
 * platform (Railway, Docker, local Ctrl-C) terminates the process. Registered
 * once per process to avoid leaking listeners across hot reloads.
 */
function registerShutdownHandlers(): void {
  if (globalForStart.discordShutdownRegistered) {
    return;
  }
  globalForStart.discordShutdownRegistered = true;

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logBot(`Received ${signal}; shutting down gracefully...`);
    await stopDiscordBot();
    logBot("Shutdown complete.");

    // Re-raise the signal's default behavior by exiting explicitly. Railway
    // sends SIGTERM on deploys; exiting 0 signals a clean stop.
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Last-resort safety nets so an unexpected error doesn't take the process
  // down without a trace. We log rather than exit to keep the bot alive.
  process.on("unhandledRejection", (reason) => {
    logError("Unhandled promise rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    logError("Uncaught exception", error);
  });
}

/**
 * Validate configuration and start the Discord bot. Safe to call multiple times;
 * the underlying login is idempotent. No-ops (with a log line) when the bot is
 * disabled or misconfigured, so it never crashes the host Next.js process.
 */
export async function startBot(): Promise<void> {
  const config = getBotConfig();

  if (!config.enabled) {
    logBot("Bot disabled (set DISCORD_BOT_ENABLED=true to enable). Skipping startup.");
    return;
  }

  // Surface non-fatal configuration gaps (e.g. missing ids for registration).
  for (const warning of config.warnings) {
    logWarn(warning);
  }

  // Refuse to start when a required value is missing rather than crashing later.
  if (config.errors.length > 0 || !config.token) {
    for (const error of config.errors) {
      logError(error);
    }
    logWarn("Bot enabled but not fully configured; skipping startup.");
    return;
  }

  registerShutdownHandlers();

  try {
    logBot("Starting Discord bot...");
    await loginDiscordBot(config.token);
  } catch (error) {
    logError("Failed to start Discord bot", error);
  }
}
