import { analyzeImages, visionModel } from "@/lib/grok/client";
import { parseBoxScore } from "@/lib/grok/boxScore";
import type { ScreenshotDataType } from "@/lib/types";

/**
 * General screenshot extraction from a single image using Grok Vision.
 *
 * This is the multi-type sibling of {@link import("./boxScore")} (which is
 * specialized for box scores read from video frames). Given one Xbox screenshot
 * and an inferred {@link ScreenshotDataType}, we pick a type-specific prompt,
 * ask Grok Vision to read the screen, and return the structured JSON.
 *
 * Parsing is defensive — matching `boxScore.ts`: the model occasionally wraps
 * JSON in code fences, so we strip fences before parsing and always return a
 * plain object (never throw on a partial read) so one bad screenshot can't stop
 * a batch. Extending to a new screenshot type is just adding a prompt below.
 */

/** Result of a screenshot extraction: the structured data plus the model used. */
export interface GeneratedScreenshotResult {
  dataType: ScreenshotDataType;
  data: Record<string, unknown>;
  model: string;
}

/** Shared instruction preamble reused across every screenshot type. */
const SYSTEM_PREAMBLE =
  "You are a meticulous sports-data extractor for a College Football video-game " +
  "dynasty. You are shown a single screenshot captured from an Xbox game. Read " +
  "the on-screen data and report exactly what is visible. Never invent teams, " +
  "players, scores, or stats: if a value is not clearly legible, omit it. Always " +
  "respond with a single valid JSON object and no surrounding prose or markdown " +
  "code fences.";

/** A prompt pair (system + user) describing the JSON we want for a type. */
interface ScreenshotPrompt {
  system: string;
  user: string;
}

/** The user prompt for a generic screenshot when the type is unknown. */
const GENERIC_USER_PROMPT = [
  "Extract the data shown in this College Football video-game screenshot.",
  "",
  "Respond with a JSON object that best captures what is on screen. Use short",
  'camelCase keys. Always include a "screenType" string briefly describing what',
  "the screenshot shows (e.g. \"box score\", \"team standings\", \"stat leaders\").",
  "Only include values you can actually read. Do not wrap the JSON in code fences.",
].join("\n");

/** Per-type prompts. Anything not listed here uses the generic prompt. */
const PROMPTS: Partial<Record<ScreenshotDataType, ScreenshotPrompt>> = {
  "box-score": {
    system: SYSTEM_PREAMBLE,
    user: [
      "Extract the Box Score from this College Football video-game screenshot.",
      "",
      "Respond with a JSON object using exactly these keys:",
      '- "home": object — the HOME team.',
      '- "away": object — the AWAY team.',
      '- "notes": string (optional) — brief caveats, e.g. a value you were unsure about.',
      "",
      'Each of "home" and "away" is an object with:',
      '- "name": string — the team name as shown on screen.',
      '- "score": number (optional) — the final score for that team.',
      '- "quarterScores": number[] (optional) — points per quarter [Q1, Q2, Q3, Q4, ...].',
      '- "stats": object (optional) — headline team stats keyed by a short camelCase',
      '  label, e.g. { "totalYards": 412, "turnovers": 2, "passingYards": 250 }.',
      "",
      "Only include fields you can actually read. Do not wrap the JSON in code fences.",
    ].join("\n"),
  },
  heisman: {
    system: SYSTEM_PREAMBLE,
    user: [
      "Extract the Heisman race / trophy standings from this College Football",
      "video-game screenshot.",
      "",
      "Respond with a JSON object using exactly these keys:",
      '- "candidates": array — the players listed, in the order shown.',
      '- "notes": string (optional) — brief caveats about anything unclear.',
      "",
      "Each candidate is an object with (include only what is legible):",
      '- "rank": number (optional) — the ranking position shown.',
      '- "player": string — the player name.',
      '- "team": string (optional) — the player\'s team.',
      '- "position": string (optional) — the position abbreviation (e.g. "QB").',
      '- "points": number (optional) — Heisman points/votes if shown.',
      '- "stats": object (optional) — headline stats keyed by a short camelCase',
      '  label, e.g. { "passingYards": 3200, "touchdowns": 34 }.',
      "",
      "Only include fields you can actually read. Do not wrap the JSON in code fences.",
    ].join("\n"),
  },
};

/**
 * Strip an optional Markdown code fence (```json ... ```), returning the raw
 * JSON text. Mirrors the box-score / newspaper parsers for consistency.
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Parse a raw completion into a plain JSON object. Throws only when the response
 * is not a JSON object at all; individual missing fields are the caller's (and
 * consumers') concern, so partial reads still flow through.
 */
export function parseScreenshotData(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    throw new Error(
      `Screenshot response was not valid JSON: ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Screenshot response was not a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

/** Resolve the prompt pair for a data type, falling back to the generic one. */
function resolvePrompt(dataType: ScreenshotDataType): ScreenshotPrompt {
  return (
    PROMPTS[dataType] ?? { system: SYSTEM_PREAMBLE, user: GENERIC_USER_PROMPT }
  );
}

/**
 * Send a single screenshot (a base64 `data:` URL or public URL) to Grok Vision
 * using the prompt for `dataType`, and return the parsed structured data.
 *
 * For `box-score` the response is validated through the existing
 * {@link parseBoxScore} so the stored shape matches `/process-video` exactly;
 * every other type is parsed as free-form JSON.
 */
export async function generateScreenshotData(
  imageUrl: string,
  dataType: ScreenshotDataType,
): Promise<GeneratedScreenshotResult> {
  const { system, user } = resolvePrompt(dataType);
  const raw = await analyzeImages([imageUrl], user, system);

  const data =
    dataType === "box-score"
      ? (parseBoxScore(raw) as unknown as Record<string, unknown>)
      : parseScreenshotData(raw);

  return { dataType, data, model: visionModel() };
}
