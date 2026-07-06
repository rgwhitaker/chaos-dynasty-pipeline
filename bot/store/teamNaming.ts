/**
 * Helpers for turning a human-entered team name into the derived values the
 * store needs: a URL/id-friendly slug and a short display abbreviation.
 *
 * Kept as pure functions so they are easy to reason about and reuse from both
 * the in-memory and Supabase stores.
 */

/** Maximum length we accept for a team name (matches the Discord option limit). */
export const MAX_TEAM_NAME_LENGTH = 100;

/** Maximum length for a generated/normalized abbreviation. */
export const MAX_ABBREVIATION_LENGTH = 8;

/**
 * Convert a team name into a lowercase, hyphenated slug suitable for use in a
 * team id (e.g. "Oregon State Beavers" -> "oregon-state-beavers"). Falls back to
 * "team" when the name has no slug-able characters.
 */
export function slugifyTeamName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "team";
}

/**
 * Generate a reasonable abbreviation from a team name when the user does not
 * provide one:
 *  - multi-word names use the leading initials (up to 4), e.g.
 *    "Oregon State Beavers" -> "OSB";
 *  - single-word names use the first 3–4 letters, e.g. "Liberty" -> "LIB".
 *
 * Returns an uppercase string, or an empty string when the name has no letters
 * or digits to work with.
 */
export function generateAbbreviation(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return "";
  }

  if (words.length === 1) {
    return words[0].slice(0, 4).toUpperCase();
  }

  const initials = words.map((word) => word[0]).join("");
  return initials.slice(0, 4).toUpperCase();
}

/** Trim and collapse internal whitespace in a user-entered team name. */
export function normalizeTeamName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Normalize an abbreviation: trim, strip whitespace, uppercase, and cap length. */
export function normalizeAbbreviation(abbreviation: string): string {
  return abbreviation
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, MAX_ABBREVIATION_LENGTH);
}
