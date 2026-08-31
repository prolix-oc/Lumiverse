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

import type { ExpansionBudgetV1 } from "../types/agent-preprocessing";
/** Upper bound for generated / iterated items, mirroring the {{repeat}} cap. */
export const MAX_LIST_ITEMS = 1000;

/** Split a delimited string into trimmed, non-empty items without unbounded materialization. */
export function parseDelimitedList(
  str: string,
  delimiter: string,
  maxItems = MAX_LIST_ITEMS,
): string[] {
  if (str.trim() === "") return [];
  const limit = Number.isSafeInteger(maxItems) && maxItems >= 0
    ? Math.min(maxItems, MAX_LIST_ITEMS + 1)
    : MAX_LIST_ITEMS;
  // An empty delimiter means "treat the whole string as one item" — never split
  // into individual characters the way String.split("") would.
  if (delimiter === "") return limit > 0 ? [str.trim()] : [];

  const items: string[] = [];
  let start = 0;
  while (start <= str.length && items.length < limit) {
    const separatorAt = str.indexOf(delimiter, start);
    const end = separatorAt < 0 ? str.length : separatorAt;
    const item = str.slice(start, end).trim();
    if (item !== "") items.push(item);
    if (separatorAt < 0) break;
    start = separatorAt + delimiter.length;
  }
  return items;
}
/** Select from a delimited string while preserving empty-item positions. */
export function selectDelimitedItem(
  str: string,
  delimiter: string,
  rawIndex: number,
  maxItems = MAX_LIST_ITEMS,
): { value: string; overflow: boolean } {
  const limit = Number.isSafeInteger(maxItems) && maxItems >= 0
    ? Math.min(maxItems, MAX_LIST_ITEMS)
    : MAX_LIST_ITEMS;
  const items: string[] = [];

  if (delimiter === "") {
    const count = Math.min(str.length, limit + 1);
    for (let index = 0; index < count; index += 1) items.push(str[index] ?? "");
    if (str.length > limit) return { value: "", overflow: true };
  } else {
    let start = 0;
    while (start <= str.length && items.length <= limit) {
      const separatorAt = str.indexOf(delimiter, start);
      const end = separatorAt < 0 ? str.length : separatorAt;
      items.push(str.slice(start, end));
      if (separatorAt < 0) break;
      start = separatorAt + delimiter.length;
    }
    if (items.length > limit) return { value: "", overflow: true };
  }

  const index = rawIndex < 0 ? items.length + rawIndex : rawIndex;
  return { value: items[index]?.trim() ?? "", overflow: false };
}

/** Parse a canonical comma-separated list. */
export function parseList(str: string, maxItems = MAX_LIST_ITEMS): string[] {
  return parseDelimitedList(str, ",", maxItems);
}

export function formatList(items: string[], budget?: ExpansionBudgetV1): string {
  return budget ? budget.join(items, ", ") : items.join(", ");
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
