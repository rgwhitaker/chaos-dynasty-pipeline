import { findWeekIndexByName } from "@/lib/weekSchedule";
import type { ScreenshotDataType } from "@/lib/types";

/**
 * Folder / filename → (week, data type) inference for the screenshot pipeline.
 *
 * Xbox screenshots are auto-uploaded to OneDrive and the user organizes them
 * into folders like:
 *
 *   2026 Week 2/Box Scores/shot.png   → week = "Week 2", type = box-score
 *   2026 Heisman Race/candidate.png   → type = heisman
 *
 * We infer the **week** from a `Week N` folder segment and the **data type**
 * from a known subfolder name, falling back to the filename when the folders
 * give no hint. Everything is best-effort and case/punctuation-insensitive so a
 * slightly different folder name (e.g. "Boxscores") still resolves.
 */

/** The result of inferring metadata from a screenshot's path. */
export interface InferredScreenshotMeta {
  /**
   * Week the screenshot belongs to as a 0-based schedule index (see
   * `lib/weekSchedule.ts`), or `undefined` when no week could be inferred.
   */
  weekNumber?: number;
  /** The kind of screenshot, used to pick the vision prompt. */
  dataType: ScreenshotDataType;
}

/** Image extensions the pipeline processes. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/**
 * Keyword → data type mapping. Each entry lists the normalized substrings that,
 * when found in a folder segment or filename, map to that data type. Order
 * matters: more specific terms should precede generic ones.
 */
const DATA_TYPE_KEYWORDS: Array<{ type: ScreenshotDataType; keywords: string[] }> = [
  { type: "box-score", keywords: ["box score", "boxscore", "box-score"] },
  { type: "heisman", keywords: ["heisman"] },
  { type: "player-stats", keywords: ["player stats", "playerstats", "player-stats", "stat leaders"] },
  { type: "standings", keywords: ["standings", "rankings", "top 25", "poll"] },
];

/** Lower-case and collapse whitespace/punctuation for tolerant matching. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Whether a filename looks like a supported image. */
export function isSupportedImage(filename: string): boolean {
  const lower = filename.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Split a path into its individual segments, dropping empties. Accepts both
 * "/" and "\" separators so Windows-style paths work too.
 */
function pathSegments(path: string): string[] {
  return path
    .split(/[/\\]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Infer the week (as a schedule index) from a path segment such as
 * "2026 Week 2". Returns `undefined` when the segment has no `Week N` token or
 * the resolved week is not in the schedule.
 */
function inferWeekFromSegment(segment: string): number | undefined {
  const match = normalize(segment).match(/week\s*(\d+)/);
  if (!match) {
    return undefined;
  }
  const index = findWeekIndexByName(`Week ${match[1]}`);
  return index >= 0 ? index : undefined;
}

/** Find the first data type keyword match within a normalized string. */
function matchDataType(normalized: string): ScreenshotDataType | undefined {
  for (const { type, keywords } of DATA_TYPE_KEYWORDS) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return type;
    }
  }
  return undefined;
}

/**
 * Infer the week and data type for a screenshot from its path relative to the
 * monitored root. `relativePath` should include the filename (e.g.
 * "2026 Week 2/Box Scores/final.png"); a bare filename is also accepted.
 *
 * Detection order:
 *  1. Week — the first segment containing a `Week N` token.
 *  2. Data type — the first segment (or the filename) matching a known keyword.
 *     Folder segments are checked before the filename so an explicit subfolder
 *     wins over an ambiguous filename.
 */
export function inferScreenshotMeta(relativePath: string): InferredScreenshotMeta {
  const segments = pathSegments(relativePath);

  let weekNumber: number | undefined;
  for (const segment of segments) {
    const inferred = inferWeekFromSegment(segment);
    if (inferred !== undefined) {
      weekNumber = inferred;
      break;
    }
  }

  // Prefer folder segments (all but the last) over the filename for type hints,
  // then fall back to the filename itself.
  const folderSegments = segments.slice(0, -1);
  const filename = segments[segments.length - 1] ?? "";

  let dataType: ScreenshotDataType | undefined;
  for (const segment of folderSegments) {
    dataType = matchDataType(normalize(segment));
    if (dataType) {
      break;
    }
  }
  if (!dataType) {
    dataType = matchDataType(normalize(filename));
  }

  return { weekNumber, dataType: dataType ?? "unknown" };
}
