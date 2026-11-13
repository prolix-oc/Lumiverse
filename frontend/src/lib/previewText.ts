/**
 * Light-strip RP/markdown from a message so a last-message preview reads as
 * clean, single-line plain text. Intentionally lightweight — not a full
 * markdown parser; just enough to flatten the common emphasis/heading/quote
 * markers and collapse newlines for compact list rows.
 */
export function previewText(raw: string): string {
  return raw
    .replace(/[*_~`]+/g, '') // emphasis / inline-code markers
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/^>\s?/gm, '') // blockquote markers
    .replace(/\s+/g, ' ') // collapse newlines + whitespace runs
    .trim()
}
