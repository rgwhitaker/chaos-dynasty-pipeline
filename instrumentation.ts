/**
 * Next.js instrumentation hook. Runs once when the server process boots.
 *
 * We only start the Discord bot in the Node.js runtime (not the Edge runtime),
 * and delegate all startup logic to `bot/start.ts` so the same entry point can
 * be reused if we later run the bot as a standalone process on Railway.
 *
 * The import of `bot/start` is intentionally dynamic and kept inside the
 * Node.js-runtime guard. A static top-level import would pull the bot's
 * Node-only dependencies (e.g. `discord.js` → `which` → `isexe`, which requires
 * `fs`) into the module graph for every runtime, breaking the Edge/client
 * bundling with "Module not found: Can't resolve 'fs'".
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBot } = await import("@/bot/start");
    await startBot();
  }
}
