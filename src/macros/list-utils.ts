/**
 * Shared helpers for the list/iteration macro family.
 *
 * In this engine a "list" is just a delimited string. The canonical form is
 * comma-separated (what {{players}}, {{group}}, {{join}}, {{range}}, {{sort}},
 * … all produce), so the pure list macros ({{count}}, {{includes}}, {{sort}},
 * …) read and write commas. The scoped iteration macros ({{foreach}},
 * {{filter}}, …) additionally accept a custom delimiter for bringing in
 * non-comma data. Either way, items are trimmed and blanks are dropped so
 * structural whitespace from multi-line templates never leaks into results.
 */

/** Upper bound for generated / iterated items, mirroring the {{repeat}} cap. */
export const MAX_LIST_ITEMS = 1000;

/** Split a delimited string into trimmed, non-empty items. */
export function parseDelimitedList(str: string, delimiter: string): string[] {
  if (str.trim() === "") return [];
  // An empty delimiter means "treat the whole string as one item" — never split
  // into individual characters the way String.split("") would.
  const parts = delimiter === "" ? [str] : str.split(delimiter);
  return parts.map((s) => s.trim()).filter((s) => s !== "");
}

/** Parse a canonical comma-separated list. */
export function parseList(str: string): string[] {
  return parseDelimitedList(str, ",");
}

/** Render items back into the canonical comma-separated form. */
export function formatList(items: string[]): string {
  return items.join(", ");
}

/**
 * Resolve a possibly-negative index against a length (JS-style: -1 is the last
 * item). Returns a value that may be out of range; callers should guard with a
 * bounds check / `?? ""`.
 */
export function resolveIndex(raw: number, length: number): number {
  if (isNaN(raw)) return -1; // force an out-of-range miss
  return raw < 0 ? length + raw : raw;
}
