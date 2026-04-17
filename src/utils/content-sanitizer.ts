/**
 * Content sanitization utilities for vectorization and embedding pipelines.
 *
 * These functions strip structural/formatting markup from message content
 * so that embedding vectors represent pure narrative content rather than
 * HTML syntax or framework-specific tags.
 *
 * Extracted from prompt-assembly.service.ts for reuse across services.
 */

// ---------------------------------------------------------------------------
// Loom tag definitions + compiled regexes
// ---------------------------------------------------------------------------

// Loom tags whose content should be REMOVED entirely (meta/structural, not narrative)
const LOOM_TAGS_STRIP_CONTENT = [
  "loom_sum", "loom_if", "loom_else", "loom_endif",
  "lumia_ooc", "lumiaooc", "lumio_ooc", "lumioooc",
  "loom_var", "loom_set", "loom_get",
  "loom_inject",
];

// Loom tags whose content should be KEPT (contains actual narrative)
const LOOM_TAGS_KEEP_CONTENT = [
  "loom_state", "loom_memory", "loom_context",
  "loom_record", "loomrecord", "loom_ledger", "loomledger",
];

const LOOM_STRIP_REGEXES = LOOM_TAGS_STRIP_CONTENT.map((tag) => ({
  paired: new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"),
  self: new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>`, "gi"),
}));

const LOOM_KEEP_REGEXES = LOOM_TAGS_KEEP_CONTENT.map((tag) => ({
  open: new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"),
  close: new RegExp(`</${tag}>`, "gi"),
}));

// HTML formatting tags to strip (preserves inner text)
const HTML_FORMAT_TAGS = ["span", "b", "i", "u", "em", "strong", "s", "strike", "sub", "sup", "mark", "small", "big"];
const HTML_TAG_REGEXES = HTML_FORMAT_TAGS.map((tag) => ({
  open: new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"),
  close: new RegExp(`</${tag}>`, "gi"),
}));

const MAX_FILTER_ITERATIONS = 20;

// ---------------------------------------------------------------------------
// Individual strip functions
// ---------------------------------------------------------------------------

/** Remove <details>...</details> blocks entirely (handles nesting). */
export function stripDetailsBlocks(content: string): string {
  let result = content;
  let prev: string;
  let iter = 0;
  do {
    if (++iter > MAX_FILTER_ITERATIONS) break;
    prev = result;
    result = result.replace(/<details(?:\s[^>]*)?>([\s\S]*?)<\/details>/gi, "");
  } while (result !== prev);
  return result;
}

/** Remove loom structural/meta tags and their content; strip narrative loom tags but keep their inner text. */
export function stripLoomTags(content: string): string {
  let result = content;

  // Strip meta tags entirely (remove tag + content)
  for (const { paired, self } of LOOM_STRIP_REGEXES) {
    paired.lastIndex = 0;
    self.lastIndex = 0;
    result = result.replace(paired, "");
    result = result.replace(self, "");
  }

  // Strip narrative tags but preserve inner text
  for (const { open, close } of LOOM_KEEP_REGEXES) {
    open.lastIndex = 0;
    close.lastIndex = 0;
    result = result.replace(open, "");
    result = result.replace(close, "");
  }

  return result;
}

/** Strip HTML formatting tags (preserving inner text) + div handling. */
export function stripHtmlFormattingTags(content: string): string {
  let result = content;

  // Handle divs: extract codeblock containers, then strip remaining divs
  let prev: string;
  let iter = 0;
  do {
    if (++iter > MAX_FILTER_ITERATIONS) break;
    prev = result;
    result = result.replace(
      /<div[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>(\s*```[\s\S]*?```\s*)<\/div>/gi,
      "$1",
    );
    result = result.replace(/<div(?:\s[^>]*)?>([\s\S]*?)<\/div>/gi, "$1");
  } while (result !== prev);
  result = result.replace(/<\/div>/gi, "");

  // Strip formatting tags (preserve inner text)
  for (const { open, close } of HTML_TAG_REGEXES) {
    open.lastIndex = 0;
    close.lastIndex = 0;
    result = result.replace(open, "");
    result = result.replace(close, "");
  }

  return result;
}

/** Collapse 3+ consecutive newlines to 2 (standard paragraph break). */
export function collapseExcessiveNewlines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Composed sanitization for vectorization
// ---------------------------------------------------------------------------

export interface SanitizeOptions {
  /** User-configured reasoning prefix (e.g. from `reasoningSettings.prefix`). */
  reasoningPrefix?: string;
  /** User-configured reasoning suffix (e.g. from `reasoningSettings.suffix`). */
  reasoningSuffix?: string;
}

const DEFAULT_REASONING_TAGS = new Set(["think", "thinking", "reasoning"]);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove reasoning blocks bracketed by the configured prefix/suffix (paired + unclosed). */
function stripCustomReasoningBlocks(content: string, prefix: string, suffix: string): string {
  const rawPrefix = prefix.replace(/^\n+|\n+$/g, "");
  const rawSuffix = suffix.replace(/^\n+|\n+$/g, "");
  if (!rawPrefix || !rawSuffix) return content;

  // Skip when the configured tags are just default <think>/<thinking>/<reasoning>
  // variants — the default regex below already handles them.
  const defaultTagPair = /^<\s*([a-z_][\w-]*)\s*>$/i;
  const prefixMatch = rawPrefix.match(defaultTagPair);
  const suffixMatch = rawSuffix.match(/^<\s*\/\s*([a-z_][\w-]*)\s*>$/i);
  if (
    prefixMatch && suffixMatch &&
    prefixMatch[1].toLowerCase() === suffixMatch[1].toLowerCase() &&
    DEFAULT_REASONING_TAGS.has(prefixMatch[1].toLowerCase())
  ) {
    return content;
  }

  const escapedPrefix = escapeRegex(rawPrefix);
  const escapedSuffix = escapeRegex(rawSuffix);
  let result = content.replace(
    new RegExp(`\\s*${escapedPrefix}[\\s\\S]*?${escapedSuffix}\\s*`, "g"),
    "",
  );
  // Strip trailing unclosed custom reasoning blocks (interrupted generation)
  result = result.replace(
    new RegExp(`\\s*${escapedPrefix}[\\s\\S]*$`),
    "",
  );
  return result;
}

/**
 * Apply full content sanitization for embedding/vectorization.
 *
 * Strips reasoning tags, details blocks, loom structural tags, and HTML
 * formatting tags. Font tags are intentionally KEPT — they carry semantic
 * styling intent rather than structural noise.
 *
 * Pass `options.reasoningPrefix` / `options.reasoningSuffix` to also strip
 * blocks wrapped in the user's custom reasoning delimiters — critical for
 * keeping reasoning out of chat chunks and retrieval queries when a user has
 * configured non-default CoT tags.
 */
export function sanitizeForVectorization(content: string, options?: SanitizeOptions): string {
  // Strip custom reasoning blocks first so default-tag regexes don't leave
  // stragglers inside a user-configured wrapper.
  let result = content;
  if (options?.reasoningPrefix && options?.reasoningSuffix) {
    result = stripCustomReasoningBlocks(result, options.reasoningPrefix, options.reasoningSuffix);
  }
  // Strip default reasoning tags (complete blocks only)
  result = result.replace(
    /\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/gi,
    "",
  );
  // Also strip trailing open reasoning blocks
  result = result.replace(
    /\s*<(think|thinking|reasoning)>[\s\S]*$/gi,
    "",
  );
  result = stripDetailsBlocks(result);
  result = stripLoomTags(result);
  result = stripHtmlFormattingTags(result);
  // NOTE: Font tags are intentionally KEPT — they carry semantic styling intent
  result = collapseExcessiveNewlines(result);
  return result.trim();
}
