import { analyzeImages, visionModel } from "@/lib/grok/client";
import type { BoxScore, BoxScoreTeam } from "@/lib/types";

/**
 * Box Score extraction from video frames using Grok Vision.
 *
 * Given a handful of stills sampled from a recorded game, we ask Grok to read
 * the on-screen box score and return it as strict JSON. Parsing is defensive:
 * the model occasionally wraps JSON in code fences or omits fields it can't read,
 * so we strip fences, coerce types, and drop anything malformed rather than
 * throwing on partial data.
 */

/** Result of a box-score extraction call: the data plus the model used. */
export interface GeneratedBoxScoreResult {
  boxScore: BoxScore;
  model: string;
}

const SYSTEM_PROMPT =
  "You are a meticulous sports-data extractor for a College Football video-game " +
  "dynasty. You are shown several still frames captured from a recorded Xbox " +
  "game. Read the on-screen BOX SCORE / final results screen and report exactly " +
  "what is visible. Never invent teams, scores, or stats: if a value is not " +
  "clearly legible in the frames, omit it. Always respond with a single valid " +
  "JSON object and no surrounding prose or markdown code fences.";

/** The user prompt describing the exact JSON shape we want back. */
const USER_PROMPT = [
  "Extract the Box Score from these frames of a College Football video game.",
  "",
  "Respond with a JSON object using exactly these keys:",
  '- "home": object — the HOME team.',
  '- "away": object — the AWAY team.',
  '- "notes": string (optional) — brief caveats, e.g. a value you were unsure about.',
  "",
  "Each of \"home\" and \"away\" is an object with:",
  '- "name": string — the team name as shown on screen.',
  '- "score": number (optional) — the final score for that team.',
  '- "quarterScores": number[] (optional) — points per quarter in order [Q1, Q2, Q3, Q4, ...].',
  '- "stats": object (optional) — headline team stats keyed by a short camelCase label',
  '  when clearly visible, e.g. { "totalYards": 412, "turnovers": 2, "passingYards": 250, "rushingYards": 162 }.',
  "",
  "Only include fields you can actually read from the frames. Omit anything not clearly visible.",
  "Do not wrap the JSON in code fences.",
].join("\n");

/**
 * Strip an optional Markdown code fence (```json ... ```), returning the raw
 * JSON text. Mirrors the newspaper parser so behavior is consistent.
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/** Coerce an unknown value into a trimmed string, or undefined when empty. */
function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Coerce an unknown value into a finite number, or undefined. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Normalize a quarter-scores array into finite numbers, or undefined. */
function parseQuarterScores(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scores = value
    .map((item) => asNumber(item))
    .filter((item): item is number => item !== undefined);
  return scores.length > 0 ? scores : undefined;
}

/** Normalize a free-form stats object, keeping string/number values only. */
function parseStats(value: unknown): Record<string, string | number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const stats: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const label = key.trim();
    if (!label) {
      continue;
    }
    const num = asNumber(raw);
    if (num !== undefined) {
      stats[label] = num;
      continue;
    }
    const str = asString(raw);
    if (str !== undefined) {
      stats[label] = str;
    }
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

/** Parse one team object, defaulting the name so callers always get a label. */
function parseTeam(value: unknown, fallbackName: string): BoxScoreTeam {
  if (typeof value !== "object" || value === null) {
    return { name: fallbackName };
  }
  const record = value as Record<string, unknown>;
  return {
    name: asString(record.name) ?? fallbackName,
    score: asNumber(record.score),
    quarterScores: parseQuarterScores(record.quarterScores),
    stats: parseStats(record.stats),
  };
}

/**
 * Parse Grok's raw completion into a structured {@link BoxScore}. Throws only
 * when the response isn't a JSON object at all; missing individual fields are
 * tolerated (they simply stay undefined) so a partial read is still useful.
 */
export function parseBoxScore(raw: string): BoxScore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    throw new Error(
      `Box score response was not valid JSON: ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Box score response was not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  return {
    home: parseTeam(record.home, "Home"),
    away: parseTeam(record.away, "Away"),
    notes: asString(record.notes),
  };
}

/**
 * Send the supplied frames (base64 `data:` URLs) to Grok Vision and parse the
 * response into a structured box score.
 */
export async function generateBoxScore(
  frameDataUrls: string[],
): Promise<GeneratedBoxScoreResult> {
  const raw = await analyzeImages(frameDataUrls, USER_PROMPT, SYSTEM_PROMPT);
  return { boxScore: parseBoxScore(raw), model: visionModel() };
}
