/**
 * Full custom week structure for a CHAOS dynasty season.
 *
 * The season is modelled as an ordered list of named weeks. A week's position in
 * {@link WEEK_SCHEDULE} (its 0-based index) is the stable integer identifier used
 * everywhere the code previously used a plain "week number" — including the
 * `week` columns in Supabase (`team_ready_states`, `newspapers`, `box_scores`)
 * and the in-memory readiness keys. Because each index is unique and ordered,
 * advancing to the next week is simply "index + 1", and readiness naturally
 * resets when the week changes.
 *
 * Each week carries the metadata the advance system needs:
 *  - `isGameWeek`           — true for weeks where games are played.
 *  - `defaultDurationHours` — the default deadline window (48h for game weeks,
 *                             24h otherwise), used to calculate the next deadline
 *                             when the commissioner does not override it.
 */

/** Default deadline window (in hours) for a game week. */
export const GAME_WEEK_DURATION_HOURS = 48;

/** Default deadline window (in hours) for a non-game week. */
export const NON_GAME_WEEK_DURATION_HOURS = 24;

/** A single week in the dynasty schedule. */
export interface WeekDefinition {
  /** Stable, URL-safe slug used for lookups (e.g. `"week-0"`). */
  key: string;
  /** Human-readable name shown in Discord (e.g. `"Week 0"`). */
  name: string;
  /** True for weeks where games are played. */
  isGameWeek: boolean;
  /** Default deadline duration in hours (48 for game weeks, 24 otherwise). */
  defaultDurationHours: number;
}

/** Turn a display name into a stable slug key. */
function slugifyWeekName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build a game week (48h default deadline). */
function gameWeek(name: string): WeekDefinition {
  return {
    key: slugifyWeekName(name),
    name,
    isGameWeek: true,
    defaultDurationHours: GAME_WEEK_DURATION_HOURS,
  };
}

/** Build a non-game week (24h default deadline). */
function nonGameWeek(name: string): WeekDefinition {
  return {
    key: slugifyWeekName(name),
    name,
    isGameWeek: false,
    defaultDurationHours: NON_GAME_WEEK_DURATION_HOURS,
  };
}

/** Week 0 … Week 15 are all game weeks (they occupy schedule indices 1–16). */
const numberedGameWeeks: WeekDefinition[] = Array.from({ length: 16 }, (_, index) =>
  gameWeek(`Week ${index}`),
);

/**
 * The complete, ordered dynasty schedule. The index of each entry is its stable
 * integer identifier used throughout the app.
 */
export const WEEK_SCHEDULE: readonly WeekDefinition[] = [
  nonGameWeek("Preseason"),
  ...numberedGameWeeks,
  gameWeek("Conference Championships"),
  gameWeek("Bowl Week 1"),
  gameWeek("Bowl Week 2"),
  gameWeek("Bowl Week 3"),
  gameWeek("National Championship"),
  nonGameWeek("End of Season Recap"),
  nonGameWeek("Players Leaving"),
  nonGameWeek("Offseason Recruiting Week 1"),
  nonGameWeek("Offseason Recruiting Week 2"),
  nonGameWeek("Offseason Recruiting Week 3"),
  nonGameWeek("Offseason Recruiting Week 4"),
  nonGameWeek("National Signing Day"),
  nonGameWeek("Training Results"),
  nonGameWeek("Offseason"),
];

/** Index of the first week in the schedule. */
export const FIRST_WEEK_INDEX = 0;

/** Index of the last week in the schedule. */
export const LAST_WEEK_INDEX = WEEK_SCHEDULE.length - 1;

/** Whether `index` refers to a real week in the schedule. */
export function isValidWeekIndex(index: number): boolean {
  return Number.isInteger(index) && index >= FIRST_WEEK_INDEX && index <= LAST_WEEK_INDEX;
}

/** Clamp an arbitrary number to a valid schedule index. */
export function clampWeekIndex(index: number): number {
  if (!Number.isFinite(index)) {
    return FIRST_WEEK_INDEX;
  }
  return Math.min(Math.max(Math.trunc(index), FIRST_WEEK_INDEX), LAST_WEEK_INDEX);
}

/** Resolve a week definition by its schedule index, if valid. */
export function getWeekByIndex(index: number): WeekDefinition | undefined {
  return isValidWeekIndex(index) ? WEEK_SCHEDULE[index] : undefined;
}

/** Whether the week at `index` is the last week of the schedule. */
export function isLastWeekIndex(index: number): boolean {
  return index === LAST_WEEK_INDEX;
}

/**
 * Human-readable label for a schedule index. Falls back to `Week {index}` for
 * out-of-range values so callers always have something to show.
 */
export function getWeekName(index: number): string {
  return getWeekByIndex(index)?.name ?? `Week ${index}`;
}

/** Normalize free-form user input for name/key matching. */
function normalizeWeekQuery(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve a week index from a user-supplied name, slug, or key. Matching is
 * case-insensitive and punctuation-insensitive (so "Bowl Week 1", "bowl-week-1",
 * and "bowl week 1" all resolve to the same week). Returns `-1` when no week
 * matches.
 */
export function findWeekIndexByName(query: string): number {
  const needle = normalizeWeekQuery(query);
  if (!needle) {
    return -1;
  }
  return WEEK_SCHEDULE.findIndex((week) => week.key === needle);
}

/**
 * Search the schedule for weeks whose name or key contains `query`, for Discord
 * autocomplete. An empty query returns the start of the schedule. Results are
 * capped at `limit` (Discord allows at most 25 autocomplete choices).
 */
export function searchWeeks(query: string, limit = 25): Array<{ index: number; week: WeekDefinition }> {
  const needle = normalizeWeekQuery(query);
  const matches: Array<{ index: number; week: WeekDefinition }> = [];

  for (let index = 0; index < WEEK_SCHEDULE.length; index += 1) {
    const week = WEEK_SCHEDULE[index];
    if (!needle || week.key.includes(needle)) {
      matches.push({ index, week });
    }
    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

/**
 * Calculate a deadline for a week. When `overrideHours` is provided (and valid)
 * it wins over the week's `defaultDurationHours`, letting a commissioner force a
 * shorter/longer window (e.g. 24h on a game week). Returns an ISO timestamp.
 */
export function calculateDeadline(
  week: WeekDefinition,
  overrideHours?: number,
  from: Date = new Date(),
): string {
  const hours =
    typeof overrideHours === "number" && Number.isFinite(overrideHours) && overrideHours > 0
      ? overrideHours
      : week.defaultDurationHours;
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}
