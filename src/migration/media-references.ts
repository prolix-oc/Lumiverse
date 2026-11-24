/** Shared boundary-aware media path/URL replacement for migration importers. */

export function replaceMediaReferences(text: string, mappings: ReadonlyMap<string, string>): string {
  let result = text;
  // Longest first prevents a short filename from consuming another path's prefix.
  for (const [path, reference] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Do not consume a filename prefix or a same-looking path at another host.
    result = result.replace(new RegExp(`(?<![\\w:/.-])${escaped}(?![\\w%./-])`, "g"), () => reference);
  }
  return result;
}
