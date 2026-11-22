import { generateNarrative } from "@/lib/grok/client";

/**
 * NSFW "not ready" roasts for the recurring Discord reminder.
 *
 * Given the not-ready owners (with how often each has been reminded relative to
 * the rest of the league) Grok writes one short, crude, unique roast per
 * person. Parsing is defensive — code fences, partial JSON, or a missing entry
 * never throw; callers simply get fewer roasts back and fall back to the plain
 * reminder when the map is empty.
 */

/** One not-ready owner to roast. */
export interface RoastTarget {
  /** Discord user id (the key of the returned map). */
  userId: string;
  teamName: string;
  abbreviation?: string;
  /** Reminders this team has received, including the one being sent now. */
  reminderCount: number;
  /** Percent (0–100) of the other league teams reminded fewer times than this one. */
  relativeRank: number;
  /** Total reminders sent across the whole league. */
  totalReminders: number;
}

/** A recent chat message offered to Grok as extra roast material. */
export interface RoastChatMessage {
  authorId: string;
  authorName?: string;
  content: string;
  createdAt: string;
}

export interface RoastContext {
  /** Number of teams in the league, for framing the relative ranking. */
  leagueSize?: number;
  /** Recent messages authored by or mentioning the targets. */
  recentMessages?: RoastChatMessage[];
}

/** Known owners for flavor. `team` is matched against the stored team name. */
export const LEAGUE_OWNERS: ReadonlyArray<{ owner: string; team: string; note?: string }> = [
  { owner: "Rob", team: "Iowa", note: "the commissioner" },
  { owner: "Al", team: "UNLV" },
  { owner: "Grice", team: "Stanford" },
  { owner: "Kevin", team: "Florida" },
  { owner: "Tony", team: "Oregon" },
  { owner: "Jpatt", team: "Indiana" },
  { owner: "Derek", team: "Rutgers" },
];

const MAX_ROAST_LENGTH = 300;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const RECENT_ROAST_MEMORY = 40;

// Roasts used recently in this process, fed back so Grok doesn't repeat itself.
const globalForRoasts = globalThis as typeof globalThis & { recentRoasts?: string[] };

function recentRoasts(): string[] {
  globalForRoasts.recentRoasts ??= [];
  return globalForRoasts.recentRoasts;
}

function rememberRoasts(roasts: Iterable<string>): void {
  const memory = recentRoasts();
  memory.push(...roasts);
  memory.splice(0, Math.max(0, memory.length - RECENT_ROAST_MEMORY));
}

/**
 * Resolve the owner nickname for a team ("Iowa Hawkeyes" → Rob). Matches the
 * whole name or a leading word boundary so "Oregon" does not match "Oregon State".
 */
export function findLeagueOwner(
  teamName: string,
  abbreviation?: string,
): { owner: string; team: string; note?: string } | undefined {
  const name = teamName.trim().toLowerCase();
  const abbr = abbreviation?.trim().toLowerCase();
  return LEAGUE_OWNERS.find((entry) => {
    const team = entry.team.toLowerCase();
    if (name === team || abbr === team) {
      return true;
    }
    if (!name.startsWith(`${team} `)) {
      return false;
    }
    // Reject "Oregon State" / "Florida State"-style schools.
    return !/^(state|st\.?|tech|international|atlantic)\b/.test(name.slice(team.length + 1));
  });
}

const SYSTEM_PROMPT = [
  "You are the unhinged, foul-mouthed roast comic of a private College Football video-game",
  "dynasty league Discord. Every member is an adult friend who opted in to being roasted, and",
  "this channel is explicitly NSFW. You are ENCOURAGED to be vulgar, crude, profane, raunchy and",
  "chaotic: swear freely, use dirty jokes and gross-out humor, and go for the throat.",
  "",
  "Your job: roast each league member who STILL hasn't marked their team ready to advance.",
  "Material to lean on: their team's real-life and in-dynasty failures, recruiting busts, choking",
  "in big games, their laziness and procrastination, holding the whole league hostage, how often",
  "they get reminded compared to everyone else, and general league drama.",
  "",
  "Rules:",
  "- Exactly ONE roast per person, 1-2 short punchy sentences each (under 280 characters).",
  "- Every roast must be completely unique: different angle, joke structure and punchline.",
  "  Never reuse a line, template or punchline across people or from the 'already used' list.",
  "- Address the person by their nickname/team when known. Do NOT write Discord mentions",
  "  (no <@...>, @everyone or @here) — the bot adds the pings.",
  "- Make the reminder frequency sting: the more often someone gets reminded relative to the",
  "  league, the more savage the roast.",
  "- Hard limits (non-negotiable even in NSFW mode): no slurs or jokes attacking race, ethnicity,",
  "  religion, sexual orientation, gender identity or disability; nothing sexual involving minors;",
  "  no real threats or encouraging self-harm; no real-world private info.",
  "- Respond with ONLY a JSON object, no code fences, no prose, shaped exactly like:",
  '  {"roasts":[{"userId":"<id>","roast":"<text>"}]}',
].join("\n");

function describeTarget(target: RoastTarget, leagueSize?: number): string {
  const owner = findLeagueOwner(target.teamName, target.abbreviation);
  const who = owner
    ? `${owner.owner}${owner.note ? ` (${owner.note})` : ""}`
    : "unknown owner";
  const team = target.abbreviation
    ? `${target.teamName} (${target.abbreviation})`
    : target.teamName;
  const share =
    target.totalReminders > 0
      ? Math.round((target.reminderCount / target.totalReminders) * 100)
      : 0;
  const league = leagueSize ? ` of ${leagueSize} teams` : "";

  return (
    `- userId ${target.userId}: ${who}, team ${team}. Reminded ${target.reminderCount} ` +
    `time(s) (${share}% of all ${target.totalReminders} league reminders); has been ` +
    `reminded more than ${Math.round(target.relativeRank)}% of the league${league}.`
  );
}

function buildUserPrompt(targets: RoastTarget[], context: RoastContext): string {
  const lines = [
    "League roster (owner → team), for flavor:",
    ...LEAGUE_OWNERS.map(
      (entry) => `- ${entry.owner}${entry.note ? ` (${entry.note})` : ""} → ${entry.team}`,
    ),
    "",
    "These people are STILL not ready to advance. Roast each one:",
    ...targets.map((target) => describeTarget(target, context.leagueSize)),
  ];

  const ownerById = new Map(
    targets.map((target) => [
      target.userId,
      findLeagueOwner(target.teamName, target.abbreviation)?.owner ?? target.teamName,
    ]),
  );
  const messages = context.recentMessages ?? [];
  if (messages.length > 0) {
    lines.push(
      "",
      "Recent league chat involving them (use as ammo if it's funny, ignore otherwise):",
      ...messages.map((message) => {
        const author =
          ownerById.get(message.authorId) ?? message.authorName ?? "someone";
        const text = message.content
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_CHAT_MESSAGE_LENGTH);
        return `- ${author}: "${text}"`;
      }),
    );
  }

  const used = recentRoasts();
  if (used.length > 0) {
    lines.push("", "Already used recently — do NOT repeat or paraphrase these:");
    lines.push(...used.map((roast) => `- ${roast}`));
  }

  lines.push("", 'Return only {"roasts":[{"userId":"...","roast":"..."}]}.');
  return lines.join("\n");
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/** Remove pings and tidy the text so a roast can't mass-mention or overflow. */
function sanitizeRoast(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  let text = raw
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/@(everyone|here)/gi, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“]+|["'”]+$/g, "")
    .trim();
  if (text.length > MAX_ROAST_LENGTH) {
    text = `${text.slice(0, MAX_ROAST_LENGTH - 1).trimEnd()}…`;
  }
  return text || undefined;
}

/** Pull `[userId, roast]` pairs out of whatever JSON-ish shape Grok returned. */
function extractPairs(raw: string): Array<[string, unknown]> {
  const text = stripCodeFence(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      const root =
        parsed && typeof parsed === "object" && "roasts" in parsed
          ? (parsed as { roasts: unknown }).roasts
          : parsed;

      if (Array.isArray(root)) {
        return root.flatMap((item): Array<[string, unknown]> => {
          if (!item || typeof item !== "object") {
            return [];
          }
          const record = item as Record<string, unknown>;
          const id = record.userId ?? record.user_id ?? record.id;
          return id === undefined ? [] : [[String(id), record.roast ?? record.text]];
        });
      }
      if (root && typeof root === "object") {
        return Object.entries(root as Record<string, unknown>);
      }
    } catch {
      // Fall through to line-based parsing for truncated/invalid JSON.
    }
  }

  // Line fallback: `123456789: roast` or `<@123456789> - roast`.
  return text.split("\n").flatMap((line): Array<[string, unknown]> => {
    const match = line.match(/^\W*<?@?!?(\d{5,})>?\W*[:\-–—]\s*(.+)$/);
    return match ? [[match[1], match[2]]] : [];
  });
}

/**
 * Parse Grok's response into `userId → roast`, keeping only known targets and
 * dropping duplicates so every roast in a reminder is unique.
 */
export function parseRoasts(raw: string, targetIds: Iterable<string>): Map<string, string> {
  const allowed = new Set(targetIds);
  const seen = new Set<string>();
  const roasts = new Map<string, string>();

  for (const [rawId, rawRoast] of extractPairs(raw)) {
    const userId = rawId.replace(/\D/g, "") || rawId;
    const roast = sanitizeRoast(rawRoast);
    const key = roast?.toLowerCase();
    if (!allowed.has(userId) || roasts.has(userId) || !roast || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    roasts.set(userId, roast);
  }

  return roasts;
}

/**
 * Generate one unique NSFW roast per target via Grok. Throws when the Grok call
 * itself fails; returns an empty map when the response has nothing usable.
 */
export async function generateRoasts(
  targets: RoastTarget[],
  context: RoastContext = {},
): Promise<Map<string, string>> {
  if (targets.length === 0) {
    return new Map();
  }

  const raw = await generateNarrative(buildUserPrompt(targets, context), SYSTEM_PROMPT);
  const roasts = parseRoasts(raw ?? "", targets.map((target) => target.userId));
  rememberRoasts(roasts.values());
  return roasts;
}
