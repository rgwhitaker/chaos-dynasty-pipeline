/**
 * Tiny structured logging helper for the Discord bot.
 *
 * We intentionally keep this dependency-free and built on `console.*` for now.
 * Every line is prefixed with a clear tag (`[Bot]`, `[Command]`, `[Error]`,
 * `[Warn]`) so logs are easy to scan/grep when the bot runs on Railway. If we
 * later adopt a real logger (pino, winston, etc.) this module is the single
 * place that needs to change.
 */

/** General bot lifecycle logging (startup, login, shutdown, gateway events). */
export function logBot(message: string, ...args: unknown[]): void {
  console.log(`[Bot] ${message}`, ...args);
}

/** Logging tied to slash command / interaction handling. */
export function logCommand(message: string, ...args: unknown[]): void {
  console.log(`[Command] ${message}`, ...args);
}

/** Non-fatal warnings (missing optional config, recoverable gateway hiccups). */
export function logWarn(message: string, ...args: unknown[]): void {
  console.warn(`[Warn] ${message}`, ...args);
}

/** Errors. Accepts an optional Error/unknown cause for the stack trace. */
export function logError(message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`[Error] ${message}`);
    return;
  }
  console.error(`[Error] ${message}`, error);
}
