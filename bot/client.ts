type DiscordClient = import("discord.js").Client;
type DiscordInteraction = import("discord.js").Interaction;
type SlashCommandHandler = (interaction: DiscordInteraction) => Promise<void>;

type DiscordRuntime = {
  Client: typeof import("discord.js").Client;
  Events: typeof import("discord.js").Events;
  GatewayIntentBits: typeof import("discord.js").GatewayIntentBits;
};

const globalForBot = globalThis as typeof globalThis & {
  discordClient?: DiscordClient;
  discordBotStarted?: boolean;
  discordRuntime?: DiscordRuntime;
};

const commandHandlers = new Map<string, SlashCommandHandler>();

commandHandlers.set("ping", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  await interaction.reply({ content: "Pong from Chaos Dynasty Pipeline.", ephemeral: true });
});

async function getDiscordRuntime(): Promise<DiscordRuntime> {
  if (!globalForBot.discordRuntime) {
    const { Client, Events, GatewayIntentBits } = await import(
      /* webpackIgnore: true */ "discord.js"
    );
    globalForBot.discordRuntime = {
      Client,
      Events,
      GatewayIntentBits,
    };
  }

  return globalForBot.discordRuntime;
}

async function createDiscordClient(): Promise<DiscordClient> {
  const { Client, Events, GatewayIntentBits } = await getDiscordRuntime();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[discord] Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const handler = commandHandlers.get(interaction.commandName);

        if (handler) {
          await handler(interaction);
          return;
        }

        await interaction.reply({
          content: `Unknown command: ${interaction.commandName}`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.isButton() && interaction.customId === "ready-status-toggle") {
        await interaction.reply({
          content: "Ready-state interaction placeholder. Backend wiring comes next.",
          ephemeral: true,
        });
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

  await client.login(token);
  globalForBot.discordBotStarted = true;
}
