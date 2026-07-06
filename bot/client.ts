import { getApplicationId, getGuildId } from "@/bot/config";
import { logBot, logError, logWarn } from "@/bot/logger";

type DiscordClient = import("discord.js").Client;
type DiscordInteraction = import("discord.js").Interaction;

type DiscordRuntime = {
  Client: typeof import("discord.js").Client;
  Events: typeof import("discord.js").Events;
  GatewayIntentBits: typeof import("discord.js").GatewayIntentBits;
  REST: typeof import("discord.js").REST;
  Routes: typeof import("discord.js").Routes;
};

const globalForBot = globalThis as typeof globalThis & {
  discordClient?: DiscordClient;
  discordBotStarted?: boolean;
  discordRuntime?: DiscordRuntime;
};

async function getDiscordRuntime(): Promise<DiscordRuntime> {
  if (!globalForBot.discordRuntime) {
    const { Client, Events, GatewayIntentBits, REST, Routes } = await import(
      /* webpackIgnore: true */ "discord.js"
    );
    globalForBot.discordRuntime = {
      Client,
      Events,
      GatewayIntentBits,
      REST,
      Routes,
    };
  }

  return globalForBot.discordRuntime;
}

/**
 * Register the bot's slash commands against the configured guild.
 *
 * Guild-scoped registration updates instantly (unlike global commands), which
 * is ideal for local development and a single-server dynasty. Requires
 * DISCORD_APPLICATION_ID and DISCORD_GUILD_ID.
 *
 * To switch to GLOBAL commands later (visible in every server the bot is in,
 * but with up to ~1 hour propagation delay), swap the route below to
 * `Routes.applicationCommands(applicationId)` and drop the guild id requirement.
 *
 * Returns true when commands were registered, false when it was skipped.
 */
async function registerGuildCommands(token: string): Promise<boolean> {
  const applicationId = getApplicationId();
  const guildId = getGuildId();

  if (!applicationId || !guildId) {
    logWarn(
      "Skipping command registration: DISCORD_APPLICATION_ID and/or DISCORD_GUILD_ID are missing.",
    );
    return false;
  }

  const { REST, Routes } = await getDiscordRuntime();
  const { getCommandPayloads } = await import("@/bot/commands");

  const rest = new REST({ version: "10" }).setToken(token);

  // Surface REST-level rate limiting so it is obvious when Discord is throttling
  // us (e.g. during repeated deploys) instead of failing silently.
  rest.on("rateLimited", (info) => {
    logWarn(
      `REST rate limited: retry after ${info.timeToReset}ms (route ${info.route}).`,
    );
  });

  // Global (application) command registration would go here instead:
  //   await rest.put(Routes.applicationCommands(applicationId), { body: getCommandPayloads() });
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: getCommandPayloads(),
  });

  logBot(`Registered guild (${guildId}) slash commands.`);
  return true;
}

/**
 * Reply to an interaction with a user-friendly error message, choosing between
 * reply / followUp based on the interaction's current state. Never throws.
 */
async function replyWithError(
  interaction: DiscordInteraction,
  content: string,
): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (error) {
    logError("Failed to send error reply to interaction", error);
  }
}

/**
 * Attach gateway lifecycle listeners so disconnects, reconnects, rate limits and
 * errors are logged. discord.js handles reconnection automatically; here we just
 * make that behavior observable for production debugging.
 */
function attachLifecycleListeners(
  client: DiscordClient,
  Events: DiscordRuntime["Events"],
): void {
  client.once(Events.ClientReady, (readyClient) => {
    logBot(`Logged in as ${readyClient.user.tag} (id: ${readyClient.user.id}).`);
    logBot(`Serving ${readyClient.guilds.cache.size} guild(s).`);
  });

  client.on(Events.Error, (error) => {
    logError("Discord client error", error);
  });

  client.on(Events.Warn, (message) => {
    logWarn(`Discord client warning: ${message}`);
  });

  // Shard-level connection lifecycle. A single-shard bot still emits these.
  client.on(Events.ShardError, (error, shardId) => {
    logError(`Shard ${shardId} websocket error`, error);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    logWarn(`Shard ${shardId} disconnected (code ${event.code}); awaiting reconnect.`);
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logBot(`Shard ${shardId} reconnecting...`);
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logBot(`Shard ${shardId} resumed (${replayedEvents} events replayed).`);
  });
}

async function createDiscordClient(): Promise<DiscordClient> {
  const { Client, Events, GatewayIntentBits } = await getDiscordRuntime();
  const { commandMap, handleReadyButton } = await import("@/bot/commands");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  attachLifecycleListeners(client, Events);

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commandMap.get(interaction.commandName);

        if (command) {
          await command.execute(interaction);
          return;
        }

        await replyWithError(interaction, `Unknown command: ${interaction.commandName}`);
        return;
      }

      if (interaction.isButton()) {
        await handleReadyButton(interaction);
        return;
      }
    } catch (error) {
      logError("Interaction handler failed", error);
      await replyWithError(
        interaction,
        "An unexpected error occurred while processing the interaction. The issue has been logged.",
      );
    }
  });

  return client;
}

export async function getDiscordClient() {
  if (!globalForBot.discordClient) {
    globalForBot.discordClient = await createDiscordClient();
  }

  return globalForBot.discordClient;
}

/**
 * Log in the Discord client and register its commands. Assumes the caller has
 * already validated that the bot is enabled and a token is present (see
 * `bot/start.ts`). Idempotent: safe to call more than once.
 */
export async function loginDiscordBot(token: string): Promise<DiscordClient | undefined> {
  if (globalForBot.discordBotStarted) {
    return globalForBot.discordClient;
  }

  const client = await getDiscordClient();

  // Register guild-scoped commands before login so they are available
  // immediately when testing locally. Registration failures are non-fatal:
  // the bot can still log in and respond to previously-registered commands.
  try {
    await registerGuildCommands(token);
  } catch (error) {
    logError("Failed to register slash commands", error);
  }

  await client.login(token);
  globalForBot.discordBotStarted = true;
  return client;
}

/**
 * Cleanly disconnect the Discord client. Used by graceful-shutdown handlers.
 */
export async function stopDiscordBot(): Promise<void> {
  const client = globalForBot.discordClient;
  if (!client) {
    return;
  }

  try {
    logBot("Destroying Discord client...");
    await client.destroy();
  } catch (error) {
    logError("Error while destroying Discord client", error);
  } finally {
    globalForBot.discordClient = undefined;
    globalForBot.discordBotStarted = false;
  }
}

/**
 * Backward-compatible entry point kept so older callers (and any imports of
 * `startDiscordBot`) continue to work. New code should call `startBot()` from
 * `bot/start.ts`, which adds config validation and graceful-shutdown handling.
 */
export async function startDiscordBot() {
  const { startBot } = await import("@/bot/start");
  await startBot();
}
