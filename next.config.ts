import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "discord.js",
    "@discordjs/rest",
    "@discordjs/ws",
    "undici",
    "node-fetch",
  ],
};

export default nextConfig;