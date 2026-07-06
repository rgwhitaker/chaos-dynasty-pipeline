import { getApplicationId, getGuildId } from "@/bot/config";

type DiscordClient = import("discord.js").Client;

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
 * Register the bot's slash commands against the configured guild. Guild-scoped
 * registration updates instantly (unlike global commands), which is ideal for
 * local development. Requires DISCORD_APPLICATION_ID and DISCORD_GUILD_ID.
 */
async function registerGuildCommands(token: string): Promise<void> {
  const applicationId = getApplicationId();
  const guildId = getGuildId();

  if (!applicationId || !guildId) {
    console.warn(
      "[discord] Skipping command registration: DISCORD_APPLICATION_ID and/or DISCORD_GUILD_ID are missing.",
    );
    return;
  }

  const { REST, Routes } = await getDiscordRuntime();
  const { getCommandPayloads } = await import("@/bot/commands");

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: getCommandPayloads(),
  });

  console.log(`[discord] Registered guild (${guildId}) slash commands.`);
}

async function createDiscordClient(): Promise<DiscordClient> {
  const { Client, Events, GatewayIntentBits } = await getDiscordRuntime();
  const { commandMap, handleReadyButton } = await import("@/bot/commands");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[discord] Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commandMap.get(interaction.commandName);

        if (command) {
          await command.execute(interaction);
          return;
        }

        await interaction.reply({
          content: `Unknown command: ${interaction.commandName}`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.isButton()) {
        const handled = await handleReadyButton(interaction);
        if (handled) {
          return;
        }
      }
    } catch (error) {
      console.error("[discord] Interaction handler failed", error);

      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content:
            "An unexpected error occurred while processing the interaction. The issue has been logged.",
          ephemeral: true,
        });
      } else if (interaction.isRepliable()) {
        await interaction.followUp({
          content:
            "An unexpected error occurred while processing the interaction. The issue has been logged.",
          ephemeral: true,
        });
      }
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

export async function startDiscordBot() {
  if (globalForBot.discordBotStarted) {
    return;
  }

  if (process.env.DISCORD_BOT_ENABLED !== "true") {
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token) {
    console.warn("[discord] DISCORD_BOT_ENABLED=true but DISCORD_BOT_TOKEN is missing.");
    return;
  }

  const client = await getDiscordClient();

  // Register guild-scoped commands before/at login so they are available
  // immediately when testing locally.
  try {
    await registerGuildCommands(token);
  } catch (error) {
    console.error("[discord] Failed to register slash commands", error);
  }

  await client.login(token);
  globalForBot.discordBotStarted = true;
}
