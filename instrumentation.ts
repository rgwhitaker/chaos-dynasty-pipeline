import { startDiscordBot } from "@/bot/client";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await startDiscordBot();
  }
}
