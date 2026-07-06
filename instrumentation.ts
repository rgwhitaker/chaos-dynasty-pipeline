import { startBot } from "@/bot/start";

/**
 * Next.js instrumentation hook. Runs once when the server process boots.
 *
 * We only start the Discord bot in the Node.js runtime (not the Edge runtime),
 * and delegate all startup logic to `bot/start.ts` so the same entry point can
 * be reused if we later run the bot as a standalone process on Railway.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await startBot();
  }
}
