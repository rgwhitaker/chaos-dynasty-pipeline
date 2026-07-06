import { generateNarrative } from "@/lib/grok/client";
import type { NewspaperContent, PowerPollEntry } from "@/lib/types";

/**
 * Minimal team information the newspaper generator needs. Kept intentionally
 * small so callers can pass whatever league data they have available.
 */
export interface NewspaperTeamInput {
  name: string;
  abbreviation?: string;
  /** Whether the team was marked ready for the week that just ended. */
  wasReady?: boolean;
}

/** Everything the generator knows about the week being written up. */
export interface NewspaperGenerationContext {
  dynastyId: string;
  /** The week the newspaper covers (the one that just ended). */
  weekNumber: number;
  teams: NewspaperTeamInput[];
}

/** Result of a generation call: the structured content plus the model used. */
export interface GeneratedNewspaperResult {
  content: NewspaperContent;
  model: string;
}

const SYSTEM_PROMPT =
  "You are the editor-in-chief of the CHAOS CFB 27 Dynasty's weekly sports " +
  "newspaper. You write punchy, entertaining college-football-style coverage " +
  "with a chaotic, high-energy voice. Keep it fun and a little dramatic, but " +
  "never offensive. You always respond with a single valid JSON object and no " +
  "surrounding prose or markdown code fences.";

/** Model used for newspaper generation (falls back to the shared text model). */
function textModel(): string {
  return process.env.XAI_MODEL_TEXT ?? "grok-3-latest";
}

/**
 * Build the user prompt describing the week and the exact JSON shape we want
 * back. Team data is included so Grok can ground the highlights and power poll
 * in real names instead of inventing teams.
 */
function buildPrompt(context: NewspaperGenerationContext): string {
  const teamLines =
    context.teams.length > 0
      ? context.teams
          .map((team) => {
            const abbr = team.abbreviation ? ` (${team.abbreviation})` : "";
            const ready =
              team.wasReady === undefined
                ? ""
                : team.wasReady
                  ? " — submitted results"
                  : " — did not submit results";
            return `- ${team.name}${abbr}${ready}`;
          })
          .join("\n")
      : "- (no teams on record yet)";

  const canRank = context.teams.length > 0;

  return [
    `Write the Weekly Newspaper for Week ${context.weekNumber} of the CHAOS CFB 27 Dynasty.`,
    "",
    "Teams in the league:",
    teamLines,
    "",
    "Respond with a JSON object using exactly these keys:",
    '- "headline": string — a catchy, punchy headline for the week.',
    '- "summary": string — 2-4 sentences summarizing the week overall.',
    '- "highlights": string[] — 3-5 short bullet strings covering the biggest storylines.',
    canRank
      ? '- "powerPoll": array of { "rank": number, "team": string, "note": string } — ' +
        "a \"Chaos Power Poll\" ranking every team from best to worst with a short one-line note each."
      : '- "powerPoll": [] — leave this as an empty array since there is not enough data.',
    "",
    "Only use the team names provided above. Do not wrap the JSON in code fences.",
  ].join("\n");
}

/**
 * Strip an optional Markdown code fence (```json ... ```), returning the raw
 * JSON text. Grok usually honors the "no code fences" instruction, but we guard
 * against it anyway so parsing is robust.
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

/** Normalize the highlights array into a clean list of non-empty strings. */
function parseHighlights(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));
}

/** Normalize the power poll into ranked entries, dropping malformed rows. */
function parsePowerPoll(value: unknown): PowerPollEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const entries: PowerPollEntry[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      return;
    }
    const row = item as Record<string, unknown>;
    const team = asString(row.team);
    if (!team) {
      return;
    }
    const rankValue = Number(row.rank);
    const rank = Number.isFinite(rankValue) && rankValue > 0 ? rankValue : index + 1;
    entries.push({ rank, team, note: asString(row.note) });
  });

  if (entries.length === 0) {
    return undefined;
  }

  entries.sort((a, b) => a.rank - b.rank);
  return entries;
}

/**
 * Parse Grok's raw completion into structured {@link NewspaperContent}. Throws
 * when the response can't be parsed or is missing required fields so callers can
 * surface a clear error instead of posting an empty newspaper.
 */
export function parseNewspaperContent(raw: string): NewspaperContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    throw new Error(
      `Newspaper response was not valid JSON: ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Newspaper response was not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const headline = asString(record.headline);
  const summary = asString(record.summary);

  if (!headline || !summary) {
    throw new Error("Newspaper response is missing a headline or summary.");
  }

  return {
    headline,
    summary,
    highlights: parseHighlights(record.highlights),
    powerPoll: parsePowerPoll(record.powerPoll),
  };
}

/**
 * Generate a weekly newspaper for the supplied context using the Grok API.
 * Returns the structured content and the model that produced it.
 */
export async function generateNewspaper(
  context: NewspaperGenerationContext,
): Promise<GeneratedNewspaperResult> {
  const prompt = buildPrompt(context);
  const raw = await generateNarrative(prompt, SYSTEM_PROMPT);
  return { content: parseNewspaperContent(raw), model: textModel() };
}
