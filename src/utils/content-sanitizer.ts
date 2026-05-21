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
  paired: new RegExp(`\\s*<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>\\s*`, "gi"),
  self: new RegExp(`\\s*<${tag}(?:\\s[^>]*)?\\/?>\\s*`, "gi"),
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
    result = result.replace(/\s*<details(?:\s[^>]*)?>([\s\S]*?)<\/details>\s*/gi, " ");
  } while (result !== prev);
  return result;
}

/** Remove loom structural/meta tags and their content; strip narrative loom tags but keep their inner text. */
export function stripLoomTags(content: string): string {
  let result = content;

  // Strip meta tags entirely (remove tag + content + surrounding whitespace,
  // replacing with a single space so adjacent prose words don't fuse).
  for (const { paired, self } of LOOM_STRIP_REGEXES) {
    paired.lastIndex = 0;
    self.lastIndex = 0;
    result = result.replace(paired, " ");
    result = result.replace(self, " ");
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

/** Strip HTML/XML-like markup while preserving the authored text inside it. */
export function stripAllHtmlTagsPreserveContent(content: string): string {
  return content
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/?\s*(?:p|div|li|ul|ol|blockquote|pre|section|article|header|footer|table|thead|tbody|tfoot|tr|h[1-6])(?:\s[^>]*)?>/gi, "\n")
    .replace(/<\s*\/?\s*(?:td|th)(?:\s[^>]*)?>/gi, " ")
    .replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, "");
}

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
    " ",
  );
  // Strip trailing unclosed custom reasoning blocks (interrupted generation)
  result = result.replace(
    new RegExp(`\\s*${escapedPrefix}[\\s\\S]*$`),
    "",
  );
  return result;
}

export interface StripNonProseOptions {
  /**
   * Preserve `<font color="...">` and `<span style="color: ...">` tags so
   * downstream font-color attribution can still run on the cleaned content.
   * Orphan `</span>` tags are also preserved for symmetry; orphan losses
   * are rare in practice because color spans are typically paired.
   */
  keepFontTags?: boolean;
}

/**
 * Strip non-prose markup so Memory Cortex evaluators (entity / relationship /
 * salience extraction, sidecar LLM prompts) only see narrative text.
 *
 * Removes `<details>` blocks, lumia_ooc and other meta loom tags, reasoning
 * blocks, and HTML formatting wrappers (preserving inner text where the tag
 * itself is decorative). When `options.keepFontTags` is true, font color tags
 * are stashed through the pass so they survive for font-color attribution.
 */
export function stripNonProseTags(content: string, options?: StripNonProseOptions): string {
  let result = content;

  result = result.replace(/\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/gi, " ");
  result = result.replace(/\s*<(think|thinking|reasoning)>[\s\S]*$/gi, "");

  result = stripDetailsBlocks(result);
  result = stripLoomTags(result);

  if (options?.keepFontTags) {
    // Pair-stash whole color blocks so orphan opens/closes from non-color spans
    // are still stripped by the catch-all below.
    const stash: string[] = [];
    const stashPair = (re: RegExp) => {
      result = result.replace(re, (match) => {
        stash.push(match);
        return `\x00FT${stash.length - 1}\x00`;
      });
    };
    stashPair(/<font\b[^>]*>[\s\S]*?<\/font\s*>/gi);
    stashPair(/<span\s+style\s*=\s*["'][^"']*color\s*:[^"']*["'][^>]*>[\s\S]*?<\/span\s*>/gi);

    result = stripHtmlFormattingTags(result);
    result = stripAllHtmlTagsPreserveContent(result);

    result = result.replace(/\x00FT(\d+)\x00/g, (_, idx) => stash[Number(idx)]);
  } else {
    result = stripHtmlFormattingTags(result);
    result = stripAllHtmlTagsPreserveContent(result);
  }

  return collapseExcessiveNewlines(result).trim();
}

/**
 * Apply full content sanitization for embedding/vectorization.
 *
 * Strips reasoning tags, custom reasoning blocks, known non-narrative
 * structural blocks, and HTML/XML-like markup. Formatting wrappers keep
 * their inner text so authored narrative content remains vectorizable.
 *
 * Pass `options.reasoningPrefix` / `options.reasoningSuffix` to also strip
 * blocks wrapped in the user's custom reasoning delimiters.
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
    " ",
  );
  // Also strip trailing open reasoning blocks
  result = result.replace(
    /\s*<(think|thinking|reasoning)>[\s\S]*$/gi,
    "",
  );

  result = stripDetailsBlocks(result);
  result = stripLoomTags(result);
  result = stripAllHtmlTagsPreserveContent(result);

  result = collapseExcessiveNewlines(result);
  return result.trim();
}
