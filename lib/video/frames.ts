import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Frame extraction for the `/process-video` pipeline.
 *
 * Videos recorded from an Xbox are sampled into a small set of still frames that
 * are then handed to Grok Vision. We intentionally keep the number of frames low
 * (single digits) so the vision API cost per video stays predictable.
 *
 * The ffmpeg/ffprobe binaries come from `ffmpeg-static` / `ffprobe-static` by
 * default so no system install is required, but both can be overridden with the
 * `FFMPEG_PATH` / `FFPROBE_PATH` environment variables (handy on hosts that ship
 * their own build).
 */

/** Default seconds between sampled frames. */
const DEFAULT_INTERVAL_SECONDS = 3;
/** Hard cap on frames per video to bound Grok Vision usage. */
const DEFAULT_MAX_FRAMES = 8;
/** Downscale width (height auto) to keep payloads small. */
const DEFAULT_WIDTH = 1280;

let binariesConfigured = false;

/** Resolve and register the ffmpeg/ffprobe binaries exactly once. */
function configureBinaries(): void {
  if (binariesConfigured) {
    return;
  }

  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || ffmpegStatic || "ffmpeg";
  const ffprobePath =
    process.env.FFPROBE_PATH?.trim() || ffprobeStatic.path || "ffprobe";

  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  binariesConfigured = true;
}

export interface FrameExtractionOptions {
  /** Target seconds between frames (before the max-frame cap is applied). */
  intervalSeconds?: number;
  /** Upper bound on the number of frames returned. */
  maxFrames?: number;
  /** Downscale width in pixels (height is scaled to preserve aspect ratio). */
  width?: number;
}

/** A single extracted frame, ready to send to a vision model. */
export interface ExtractedFrame {
  /** Base64 `data:` URL (JPEG) suitable for the Grok vision API. */
  dataUrl: string;
  /** Approximate timestamp (seconds) the frame was sampled from. */
  timestampSeconds: number;
}

/** Probe the video duration (in seconds) via ffprobe. */
function probeDurationSeconds(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) {
        reject(new Error(`Could not read the video (ffprobe failed): ${err.message}`));
        return;
      }

      const duration = data.format?.duration;
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
        resolve(duration);
        return;
      }

      reject(new Error("Could not determine the video duration."));
    });
  });
}

/**
 * Pick evenly spaced sample timestamps across the clip. We aim for one frame
 * every `intervalSeconds`, then clamp the count to `maxFrames`. Timestamps land
 * on the midpoints of equal segments so we avoid the black first/last frames
 * that clips often start or end on.
 */
export function computeSampleTimestamps(
  durationSeconds: number,
  intervalSeconds: number,
  maxFrames: number,
): number[] {
  const safeInterval = intervalSeconds > 0 ? intervalSeconds : DEFAULT_INTERVAL_SECONDS;
  const safeMax = Math.max(1, Math.floor(maxFrames));

  const desired = Math.max(1, Math.round(durationSeconds / safeInterval));
  const count = Math.min(desired, safeMax);

  const segment = durationSeconds / count;
  return Array.from({ length: count }, (_unused, index) =>
    Number((segment * (index + 0.5)).toFixed(3)),
  );
}

/** Capture the given timestamps as JPEG stills into `outputDir`. */
function captureFrames(
  videoPath: string,
  timestamps: number[],
  outputDir: string,
  width: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on("end", () => resolve())
      .on("error", (err) =>
        reject(new Error(`Failed to extract frames from the video: ${err.message}`)),
      )
      .screenshots({
        timestamps,
        filename: "frame-%i.jpg",
        folder: outputDir,
        size: `${width}x?`,
      });
  });
}

/**
 * Extract a small, evenly spaced set of frames from a local video file.
 *
 * Returns the frames as base64 `data:` URLs (in chronological order) alongside
 * the timestamp each was sampled from. All intermediate files are written to a
 * temporary directory that is removed before returning.
 *
 * @throws if the video can't be probed or no frames could be extracted.
 */
export async function extractVideoFrames(
  videoPath: string,
  options: FrameExtractionOptions = {},
): Promise<ExtractedFrame[]> {
  configureBinaries();

  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const width = options.width ?? DEFAULT_WIDTH;

  const durationSeconds = await probeDurationSeconds(videoPath);
  const timestamps = computeSampleTimestamps(durationSeconds, intervalSeconds, maxFrames);

  const outputDir = await mkdtemp(join(tmpdir(), "cdp-frames-"));
  try {
    await captureFrames(videoPath, timestamps, outputDir, width);

    // `filename: frame-%i.jpg` numbers frames 1..N in timestamp order.
    const files = (await readdir(outputDir))
      .filter((name) => name.endsWith(".jpg"))
      .sort((a, b) => frameIndex(a) - frameIndex(b));

    if (files.length === 0) {
      throw new Error("No frames could be extracted from the video.");
    }

    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const buffer = await readFile(join(outputDir, files[i]));
      frames.push({
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        timestampSeconds: timestamps[i] ?? timestamps[timestamps.length - 1],
      });
    }

    return frames;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

/** Parse the numeric index out of a `frame-<n>.jpg` filename (0 when absent). */
function frameIndex(filename: string): number {
  const match = filename.match(/frame-(\d+)\.jpg$/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}
