import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "discord.js",
    "@discordjs/rest",
    "@discordjs/ws",
    "undici",
    "node-fetch",
    "fluent-ffmpeg",
    "ffmpeg-static",
    "ffprobe-static",
  ],
};

export default nextConfig;