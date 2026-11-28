export type CharacterSearchScope = "metadata" | "all";

export class CharacterSearchValidationError extends Error {
  readonly code = "INVALID_CHARACTER_SEARCH";
}

/** MATCH phrases keep user input literal, including quotes and FTS operators. */
function phrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function buildCharacterSearch(
  search: string | undefined,
  scope: CharacterSearchScope = "metadata",
  includeRank = false,
): { join: string; joinParams: string[]; condition: string; params: string[]; usedFts: boolean } {
  if (scope !== "metadata" && scope !== "all") {
    throw new CharacterSearchValidationError('search_in must be "metadata" or "all"');
  }
  const empty = { join: "", joinParams: [], condition: "", params: [], usedFts: false };
  const trimmed = search?.trim();
  if (!trimmed) return empty;
  const terms = trimmed.split(/\s+/);
  if (scope === "all") {
    if (terms.some(term => Array.from(term).length < 3)) {
      throw new CharacterSearchValidationError("All-fields search requires at least 3 characters in each word");
    }
    return {
      // Prevent flattening: materialize matching IDs before reading large cards.
      // This also keeps ownership, library scope, favorites and tag filtering in
      // the outer query without scanning card text to find candidates.
      join: ` JOIN (SELECT rowid${includeRank ? ", rank" : ""} FROM characters_content_fts WHERE characters_content_fts MATCH ? LIMIT -1) fts ON fts.rowid = c.rowid`,
      joinParams: [terms.map(phrase).join(" ")], condition: "", params: [], usedFts: true,
    };
  }
  if (trimmed.length >= 3) {
    return {
      join: " JOIN characters_fts fts ON fts.rowid = c.rowid", joinParams: [],
      condition: "characters_fts MATCH ?", params: [terms.map(phrase).join(" ")], usedFts: true,
    };
  }
  // Preserve the existing metadata-only fallback for short names/CJK input.
  const like = `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
  return {
    join: "", joinParams: [], usedFts: false,
    condition: "(c.name LIKE ? ESCAPE '\\' OR c.creator LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')",
    params: [like, like, like],
  };
}
