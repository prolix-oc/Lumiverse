/**
 * Removes the final word when a streamed response ends directly on that word.
 * A trailing space or terminal punctuation is treated as a completed boundary,
 * so ordinary completed responses are left untouched.
 */
export function trimIncompleteTrailingWord(content: string): string {
  if (!content || /\s$/u.test(content)) return content;

  // Only word-like endings can be an unfinished word. Punctuation, markdown
  // delimiters, and emoji are intentionally preserved.
  if (!/[\p{L}\p{N}\p{M}]$/u.test(content)) return content;

  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter === "function") {
    const segments = [...new Segmenter(undefined, { granularity: "word" }).segment(content)];
    const last = segments.at(-1);
    if (last?.isWordLike && last.index + last.segment.length === content.length) {
      return content.slice(0, last.index).trimEnd();
    }
  }

  // Intl.Segmenter is available in supported runtimes, but keep a Unicode-aware
  // fallback for older environments. Apostrophes and hyphens remain part of an
  // English-style trailing word once it begins with a letter or number.
  return content
    .replace(/[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}'’_-]*$/u, "")
    .trimEnd();
}
