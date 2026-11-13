/**
 * Remove configured trim strings until no newly-joined occurrences remain.
 *
 * Empty strings must be ignored: every string includes "", and replacing an
 * empty string with itself makes no progress, so the removal loop would never
 * terminate.
 */
export function applyRegexTrimStrings(
  result: string,
  trimStrings: readonly string[],
): string {
  for (const trim of trimStrings) {
    if (trim === "") continue;
    while (result.includes(trim)) {
      result = result.replaceAll(trim, "");
    }
  }
  return result;
}
