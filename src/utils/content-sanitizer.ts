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
const HTML_INLINE_TAGS = new Set([...HTML_FORMAT_TAGS, "font", "a", "abbr", "cite", "q", "kbd", "code", "var", "time"]);
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

/**
 * Strip HTML markup from chat-history context.
 *
 * Inline formatting wrappers keep their authored text. Block-level/custom
 * elements are treated as UI islands and removed wholesale so embedded HTML
 * widgets do not leak code, labels, or layout text into the prompt.
 */
export function stripHtmlFormattingTags(content: string): string {
  let result = content;

  result = result.replace(/<\s*br\s*\/?>/gi, "\n");

  // Remove paired non-inline elements with their content. Iterate so nested
  // islands collapse outward without preserving their inner scaffolding.
  let prev: string;
  let iter = 0;
  do {
    if (++iter > MAX_FILTER_ITERATIONS) break;
    prev = result;
    result = result.replace(
      /<\s*([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/g,
      (match, tag: string) =>
        HTML_INLINE_TAGS.has(tag.toLowerCase()) ? match : " ",
    );
  } while (result !== prev);

  result = result.replace(/<\s*([a-zA-Z][\w:-]*)\b[^>]*\/\s*>/g, (match, tag: string) =>
    HTML_INLINE_TAGS.has(tag.toLowerCase()) ? match : " ",
  );
  result = result.replace(/<\s*\/\s*([a-zA-Z][\w:-]*)\s*>/g, (match, tag: string) =>
    HTML_INLINE_TAGS.has(tag.toLowerCase()) ? match : " ",
  );
  result = result.replace(/<\s*([a-zA-Z][\w:-]*)\b[^>]*>/g, (match, tag: string) =>
    HTML_INLINE_TAGS.has(tag.toLowerCase()) ? match : " ",
  );

  // Strip formatting tags (preserve inner text)
  for (const { open, close } of HTML_TAG_REGEXES) {
    open.lastIndex = 0;
    close.lastIndex = 0;
    result = result.replace(open, "");
    result = result.replace(close, "");
  }

  result = result.replace(/[ \t\f\v]*\n[ \t\f\v]*/g, "\n");
  result = result.replace(/[ \t\f\v]{2,}/g, " ");
  return collapseExcessiveNewlines(result).trim();
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

/**
 * Curated default list of tag names whose inner CONTENT is structured
 * scaffolding (HUD blocks, status lines, dice rolls, platform embeds,
 * tracker output, OOC notes, tool call records, etc.) and must be removed
 * wholesale rather than letting their inner text pollute prose-based
 * extraction. Lowercase. NOT included: loom_record / loom_ledger /
 * loom_state / loom_memory / loom_context — those carry authored narrative
 * continuity that downstream evaluators legitimately need.
 */
const DEFAULT_SCAFFOLD_TAGS = [
  "status", "hud", "scene", "meta", "system", "banner",
  "embed", "field",
  "discord", "channel", "server", "guild",
  "dice", "roll", "d20", "dieroll", "throw",
  "timestamp", "time", "clock", "date",
  "tracker", "inventory", "stats", "vitals", "health", "hp", "mp",
  "notes", "note",
  "ooc",
  "tool_call", "tool_response", "tool_use", "tool_result", "tool_invocation",
];

/**
 * Strip an explicit list of tag names along with their inner content.
 *
 * Used for HUD/status/embed-style scaffolding that wraps structured data
 * the cortex should not treat as prose. Handles paired tags, self-closing
 * tags, and unclosed opening tags at end of content (interrupted generation).
 *
 * Tag names are matched case-insensitively. Non-identifier characters in the
 * supplied names are silently discarded.
 */
export function stripScaffoldTagBlocks(content: string, tagNames: string[]): string {
  const cleaned = tagNames
    .map((t) => (t || "").replace(/[^a-zA-Z0-9_]/g, ""))
    .filter((t) => t.length > 0);
  if (cleaned.length === 0) return content;
  const pattern = `(?:${cleaned.join("|")})`;
  let result = content;
  result = result.replace(new RegExp(`<\\s*(${pattern})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi"), " ");
  result = result.replace(new RegExp(`<\\s*${pattern}\\b[^>]*\\/\\s*>`, "gi"), " ");
  result = result.replace(new RegExp(`<\\s*${pattern}\\b[^>]*>[\\s\\S]*$`, "gi"), "");
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
  /**
   * Additional scaffolding tag names (beyond DEFAULT_SCAFFOLD_TAGS) whose
   * inner content should be stripped wholesale. Lowercase, no angle brackets.
   * Used to support user-defined HUD / status / tracker tags without code
   * changes.
   */
  extraScaffoldTags?: string[];
}

/**
 * Aggressively strip every XML/HTML tag along with its inner content.
 *
 * Authored prose for the cortex is expected to be top-level text — anything
 * wrapped in tags is treated as scaffolding, UI markup, or a visual element
 * that should not pollute extraction. Self-closing tags are stripped tag-only
 * (no content existed). `<br>` is preserved as a newline. Unclosed opening
 * tags at end of content (truncated generation) and orphan closing tags are
 * also removed.
 *
 * Runs multiple passes so nested same-name tags collapse outward (lazy match
 * handles innermost first).
 */
export function stripAllXmlTagsAndContent(content: string): string {
  let result = content;
  // Convert <br> to newlines BEFORE the strip pass (it's a void tag that
  // semantically equates to whitespace, not a wrapper).
  result = result.replace(/<\s*br\s*\/?>/gi, "\n");

  let prev: string;
  let iterations = 0;
  do {
    prev = result;
    // Paired tags with inner content. Lazy match collapses innermost first.
    result = result.replace(
      /<\s*([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/g,
      " ",
    );
    iterations++;
  } while (result !== prev && iterations < 8);

  // Self-closing tags (with or without trailing slash); content N/A.
  result = result.replace(/<\s*[a-zA-Z][\w:-]*\b[^>]*\/\s*>/g, " ");
  // Unclosed opening tag at end of content (interrupted generation).
  result = result.replace(/<\s*[a-zA-Z][\w:-]*\b[^>]*>[\s\S]*$/, "");
  // Orphan closing tags left over from mismatched markup.
  result = result.replace(/<\s*\/\s*[a-zA-Z][\w:-]*\s*>/g, " ");

  return result;
}

/** Within a preserved font block, strip any nested tag markers but keep their
 *  text so inline emphasis (`<b>important</b>`) inside authored colored prose
 *  passes through as plain text. The outer font tag itself is untouched. */
function cleanFontBlockInner(fontBlock: string): string {
  const m = fontBlock.match(/^(<\s*(font|span)\b[^>]*>)([\s\S]*?)(<\s*\/\s*\2\s*>)$/i);
  if (!m) return fontBlock;
  const [, open, , inner, close] = m;
  return open + stripAllHtmlTagsPreserveContent(inner) + close;
}

/**
 * Strip non-prose markup so Memory Cortex evaluators (entity / relationship /
 * salience extraction, sidecar LLM prompts) only see narrative text.
 *
 * Removes `<details>`, lumia_ooc + other meta loom tags, reasoning blocks,
 * scaffold tags (status / hud / embed / dice / tool_call / etc.), and — as of
 * the strict-prose pass — every remaining XML/HTML tag along with its inner
 * content. Authored prose for the cortex is top-level text; anything wrapped
 * in a tag is treated as a visual element that doesn't belong in extraction.
 *
 * When `options.keepFontTags` is true, `<font color="...">` and
 * `<span style="color: ...">` blocks are stashed before the aggressive strip
 * and restored after, so font-color attribution still has tags to read.
 * Inline emphasis tags INSIDE those preserved blocks (e.g. `<b>` inside a
 * font block) are stripped tag-only with their text preserved — emphasis
 * inside authored colored prose still flows as natural text.
 */
export function stripNonProseTags(content: string, options?: StripNonProseOptions): string {
  let result = content;

  result = result.replace(/\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/gi, " ");
  result = result.replace(/\s*<(think|thinking|reasoning)>[\s\S]*$/gi, "");

  result = stripDetailsBlocks(result);
  result = stripLoomTags(result);
  result = stripScaffoldTagBlocks(result, [
    ...DEFAULT_SCAFFOLD_TAGS,
    ...(options?.extraScaffoldTags ?? []),
  ]);

  if (options?.keepFontTags) {
    // Pair-stash whole color blocks (with their inner formatting tags
    // collapsed to plain text) so the aggressive strip below can't touch
    // them, and so any structural wrappers AROUND them still get destroyed.
    const stash: string[] = [];
    const stashPair = (re: RegExp) => {
      result = result.replace(re, (match) => {
        stash.push(cleanFontBlockInner(match));
        return `\x00FT${stash.length - 1}\x00`;
      });
    };
    stashPair(/<font\b[^>]*>[\s\S]*?<\/font\s*>/gi);
    stashPair(/<span\s+style\s*=\s*["'][^"']*color\s*:[^"']*["'][^>]*>[\s\S]*?<\/span\s*>/gi);

    result = stripAllXmlTagsAndContent(result);

    result = result.replace(/\x00FT(\d+)\x00/g, (_, idx) => stash[Number(idx)]);
  } else {
    // Even when not preserving font tags, the inner colored prose is still
    // authored narrative text and must flow through. Replace each font /
    // colored-span block with its inner text (with nested formatting tags
    // also collapsed) BEFORE the aggressive strip wipes it out.
    result = result.replace(/<font\b[^>]*>([\s\S]*?)<\/font\s*>/gi, (_, inner) =>
      stripAllHtmlTagsPreserveContent(inner));
    result = result.replace(
      /<span\s+style\s*=\s*["'][^"']*color\s*:[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/gi,
      (_, inner) => stripAllHtmlTagsPreserveContent(inner),
    );

    result = stripAllXmlTagsAndContent(result);
  }

  // Aggressive strip leaves runs of spaces where stripped blocks used to live.
  // Collapse horizontal whitespace runs to a single space and trim around
  // newlines so structural breaks survive but accidental gaps don't.
  result = result.replace(/[ \t\f\v]+/g, " ");
  result = result.replace(/ ?\n ?/g, "\n");
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
  result = stripScaffoldTagBlocks(result, DEFAULT_SCAFFOLD_TAGS);
  result = stripAllHtmlTagsPreserveContent(result);

  result = result.replace(/[ \t\f\v]+/g, " ");
  result = result.replace(/ ?\n ?/g, "\n");
  result = collapseExcessiveNewlines(result);
  return result.trim();
}
