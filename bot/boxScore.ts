import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBot } from "@/bot/logger";
import { getBoxScoreStore } from "@/bot/store/boxScoreStore";
import { generateBoxScore } from "@/lib/grok/boxScore";
import { extractVideoFrames } from "@/lib/video/frames";
import type { BoxScoreRecord } from "@/lib/types";

/**
 * `/process-video` orchestration: download an uploaded video, sample frames with
 * ffmpeg, extract a Box Score with Grok Vision, and persist the result.
 *
 * Kept separate from the slash command (mirroring `bot/newspaper.ts`) so the
 * pipeline can be reused later — for example by a storage poller — without going
 * through Discord.
 */

/** Upper bound on downloaded video size (bytes). Guards memory + API usage. */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

/** Inputs to a single video-processing run. */
export interface ProcessVideoInput {
  /** Direct URL to download the video from (e.g. a Discord attachment URL). */
  videoUrl: string;
  /** Original filename, stored for reference. */
  filename?: string;
  /** Reported content type, used for a light validation check. */
  contentType?: string | null;
  /** Reported size in bytes, used to reject oversized uploads early. */
  sizeBytes?: number | null;
  /** Optional week the game belongs to. */
  weekNumber?: number;
}

/** Result of a processing run: the stored record plus how many frames we used. */
export interface ProcessVideoResult {
  record: BoxScoreRecord;
  frameCount: number;
}

/** Whether the attachment looks like a video we can process. */
export function isLikelyVideo(input: {
  contentType?: string | null;
  filename?: string;
}): boolean {
  if (input.contentType && input.contentType.toLowerCase().startsWith("video/")) {
    return true;
  }
  const name = input.filename?.toLowerCase() ?? "";
  return /\.(mp4|mov|m4v|webm|mkv|avi)$/.test(name);
}

/** Download the video to a temp file, enforcing the size guard. */
async function downloadVideo(
  videoUrl: string,
  filename: string | undefined,
  dir: string,
): Promise<string> {
  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(
      `Could not download the video (HTTP ${response.status} ${response.statusText}).`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error("The downloaded video was empty.");
  }
  if (buffer.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(
      `The video is too large to process (${Math.round(buffer.byteLength / (1024 * 1024))} MB; ` +
        `limit is ${MAX_VIDEO_BYTES / (1024 * 1024)} MB).`,
    );
  }

  // Preserve a sane extension so ffmpeg can sniff the container.
  const safeName = filename?.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.mp4";
  const videoPath = join(dir, safeName);
  await writeFile(videoPath, buffer);
  return videoPath;
}

/**
 * Run the full pipeline for one uploaded video. Throws with a user-friendly
 * message on any failure; temp files are always cleaned up.
 */
export async function processVideoBoxScore(
  input: ProcessVideoInput,
): Promise<ProcessVideoResult> {
  if (!isLikelyVideo(input)) {
    throw new Error(
      "That attachment does not look like a video. Please upload an MP4/MOV recording.",
    );
  }

  if (
    typeof input.sizeBytes === "number" &&
    input.sizeBytes > MAX_VIDEO_BYTES
  ) {
    throw new Error(
      `The video is too large to process (${Math.round(input.sizeBytes / (1024 * 1024))} MB; ` +
        `limit is ${MAX_VIDEO_BYTES / (1024 * 1024)} MB).`,
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), "cdp-video-"));
  try {
    logBot("Processing uploaded video for box score extraction...");
    const videoPath = await downloadVideo(input.videoUrl, input.filename, workDir);

    const frames = await extractVideoFrames(videoPath);
    logBot(`Extracted ${frames.length} frame(s); sending to Grok Vision...`);

    const { boxScore, model } = await generateBoxScore(
      frames.map((frame) => frame.dataUrl),
    );

    const store = getBoxScoreStore();
    const record = await store.saveBoxScore({
      boxScore,
      model,
      weekNumber: input.weekNumber,
      sourceVideo: input.filename,
    });

    return { record, frameCount: frames.length };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
