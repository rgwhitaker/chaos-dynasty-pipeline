import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["discord.js", "@discordjs/ws", "undici"],
};

export default nextConfig;
