/**
 * Memory Cortex — Font/dialogue color attribution.
 *
 * Extracts HTML font color tags from chunk content, attributes them to
 * characters using linguistic analysis, and stores the mappings for
 * prompt injection ("Melina uses #abc123 for speech, #fec987 for thoughts").
 *
 * The extraction runs BEFORE entity heuristics, so colors are harvested
 * and then stripped — the rest of the pipeline sees clean text.
 *
 * Attribution uses explicit local speech/thought attribution, name + action
 * patterns, paragraph focus and the current message owner. Existing mappings
 * are a fallback only and never count as fresh supporting observations.
 *
 * Usage type detection within a colored block:
 *   - Inside configured/italic thought wrappers → thought, including quoted thoughts
 *   - Other quoted text → speech
 *   - Otherwise → narration
 */

import { getDb } from "../../db/connection";

// ─── Types ─────────────────────────────────────────────────────

export type ColorUsageType = "speech" | "thought" | "narration" | "unknown";

/** Changes to detection/persistence require rebuilding previously warmed chunks. */
export const FONT_ATTRIBUTION_VERSION = 3;

export interface FontColorMapping {
  id: string;
  chatId: string;
  entityId: string | null;
  hexColor: string;
  usageType: ColorUsageType;
  confidence: number;
  sampleCount: number;
  sampleExcerpt: string | null;
}

export interface ExtractedColorBlock {
  hexColor: string;
  content: string;
  fullMatch: string;
  usageType: ColorUsageType;
  /** Character offset in the original content string where this block starts */
  offset: number;
  /** Index of the paragraph (split by double-newline) containing this block */
  paragraphIndex: number;
  /** Original colored container when a mixed block is split into channels. */
  sourceMarkup?: string;
}

export interface ColorAttribution {
  hexColor: string;
  entityName: string | null;
  usageType: ColorUsageType;
  confidence: number;
  /** Source markup and local context, supplied to the candidate reviewer. */
  evidence?: string[];
  /** Reusing a stored mapping is not a new, independent observation. */
  fromHistory?: boolean;
}

export interface ThoughtDelimiters {
  prefix: string;
  suffix: string;
}

// ─── Font Tag Extraction ───────────────────────────────────────

// Matches <font color="...">content</font> and <span style="color: ...">content</span>
// Also handles UNQUOTED attributes: <font color=#E6E6FA> (common in RP formatting)
const FONT_TAG_QUOTED = /<font\b[^>]*?\bcolor\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/font\s*>/gi;
const FONT_TAG_UNQUOTED = /<font\b[^>]*?\bcolor\s*=\s*([#\w]+)[^>]*>([\s\S]*?)<\/font\s*>/gi;
const SPAN_COLOR_PATTERN = /<span\b[^>]*?\bstyle\s*=\s*["'][^"']*(?<![-\w])color\s*:\s*([^;"']+)[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/gi;

interface UsageRange { start: number; end: number; usage: "thought" | "speech" }

/** Keep source offsets while hiding attribute quotes and escaped Markdown markers. */
function usageRanges(content: string, delimiters?: ThoughtDelimiters): UsageRange[] {
  const visible = content.replace(/<[^>]*>/g, (tag) => " ".repeat(tag.length))
    .replace(/\\[*_"\\]/g, (escaped) => " ".repeat(escaped.length));
  const ranges: UsageRange[] = [];
  const collect = (source: string, pattern: RegExp, usage: UsageRange["usage"]) => {
    for (const match of source.matchAll(pattern)) ranges.push({ start: match.index!, end: match.index! + match[0].length, usage });
  };
  // Single emphasis is the RP thought channel; bold emphasis alone is not.
  collect(visible, /(?<!\*)\*(?!\*)[^*]+\*(?!\*)/g, "thought");
  collect(visible, /(?<![\p{L}\p{N}_])_(?!_)[^_]+_(?![\p{L}\p{N}_])/gu, "thought");
  collect(content, /<(i|em)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "thought");
  if (delimiters?.prefix.trim() && delimiters?.suffix.trim()) {
    collect(content, new RegExp(`${escapeRegex(delimiters.prefix.trim())}[\\s\\S]*?(?:${escapeRegex(delimiters.suffix.trim())}|$)`, "gi"), "thought");
  }
  collect(visible, /"[^"\n]*(?:\n(?!\s*\n)[^"\n]*)*"|“[^”]+”/g, "speech");
  return ranges;
}

/**
 * Extract all font-colored blocks from content.
 * Returns the blocks with normalized hex colors, detected usage type,
 * character offset, and paragraph index.
 */
export function extractColorBlocks(content: string, thoughtDelimiters?: ThoughtDelimiters): ExtractedColorBlock[] {
  const blocks: ExtractedColorBlock[] = [];

  // Pre-compute paragraph boundaries (split on double newline or paragraph-style breaks)
  const paragraphBoundaries = buildParagraphBoundaries(content);
  const ranges = usageRanges(content, thoughtDelimiters);

  const seenOffsets = new Set<number>(); // Prevent double-matching quoted + unquoted
  for (const pattern of [FONT_TAG_QUOTED, FONT_TAG_UNQUOTED, SPAN_COLOR_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (seenOffsets.has(match.index)) continue; // Skip double-match
      seenOffsets.add(match.index);

      const rawColor = match[1].trim();
      const innerContent = match[2];
      const hexColor = normalizeFontColor(rawColor);
      if (!hexColor) continue;
      const innerStart = match.index + match[0].indexOf(">") + 1;
      const innerEnd = innerStart + innerContent.length;
      // Split a shared color into its actual usage channels. Wrappers may sit
      // inside OR outside the color tag; a thought wrapper wins over quotes.
      const boundaries = [...new Set([innerStart, innerEnd, ...ranges.flatMap((range) =>
        [range.start, range.end].filter((offset) => offset > innerStart && offset < innerEnd))])].sort((a, b) => a - b);
      const segments: Array<{ content: string; usageType: ColorUsageType; start: number }> = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i], end = boundaries[i + 1];
        const covering = ranges.filter((range) => range.start <= start && range.end >= end);
        const usageType = covering.some((range) => range.usage === "thought") ? "thought"
          : covering.some((range) => range.usage === "speech") ? "speech" : "narration";
        const text = content.slice(start, end);
        const prior = segments.at(-1);
        if (prior?.usageType === usageType) prior.content += text;
        else segments.push({ content: text, usageType, start });
      }
      for (const segment of segments) {
        if (!/[\p{L}\p{N}]/u.test(segment.content.replace(/<[^>]*>/g, ""))) continue;
        const offset = segments.length === 1 ? match.index : segment.start;
        blocks.push({ hexColor, content: segment.content, usageType: segment.usageType,
          fullMatch: segments.length === 1 ? match[0] : segment.content, sourceMarkup: match[0], offset,
          paragraphIndex: findParagraphIndex(offset, paragraphBoundaries) });
      }
    }
  }

  // Sort by offset so we process blocks in document order
  blocks.sort((a, b) => a.offset - b.offset);

  return blocks;
}

/**
 * Build a sorted array of paragraph start offsets from the content.
 * Paragraphs are delimited by double newlines (with optional whitespace between).
 */
function buildParagraphBoundaries(content: string): number[] {
  const boundaries: number[] = [0];
  const paragraphBreak = /\n\s*\n/g;
  let m;
  while ((m = paragraphBreak.exec(content)) !== null) {
    // The next paragraph starts after the whitespace gap
    boundaries.push(m.index + m[0].length);
  }
  for (const match of content.matchAll(/^\[(?:CHARACTER|USER)\s*\|[^\]]+\]/gmi)) boundaries.push(match.index!);
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

/** Find which paragraph index a character offset falls into. */
function findParagraphIndex(offset: number, boundaries: number[]): number {
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (offset >= boundaries[i]) return i;
  }
  return 0;
}

/**
 * Strip all font/span color tags from content, preserving inner text.
 * Call this AFTER extractColorBlocks to clean content for the entity pipeline.
 */
export function stripFontTags(content: string): string {
  return content.replace(/<\/?font\b[^>]*>/gi, "")
    .replace(SPAN_COLOR_PATTERN, "$2");
}

// ─── Color Normalization ───────────────────────────────────────

export function normalizeFontColor(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();

  // Already hex: #abc or #aabbcc
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed.match(/^#(.)(.)(.)$/)!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;

  // rgb(r, g, b)
  const rgbMatch = trimmed.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    if (rgbMatch.slice(1).some((n) => Number(n) > 255)) return null;
    const hex = [rgbMatch[1], rgbMatch[2], rgbMatch[3]]
      .map((n) => parseInt(n, 10).toString(16).padStart(2, "0"))
      .join("");
    return `#${hex}`;
  }

  // Named colors (common subset)
  const NAMED: Record<string, string> = {
    white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000",
    blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff",
    orange: "#ffa500", pink: "#ffc0cb", purple: "#800080", gray: "#808080",
    grey: "#808080", gold: "#ffd700", silver: "#c0c0c0", crimson: "#dc143c",
  };
  if (Object.hasOwn(NAMED, trimmed)) return NAMED[trimmed];

  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripThoughtDelimiters(content: string, delimiters?: ThoughtDelimiters): string {
  if (!content || !delimiters?.prefix || !delimiters?.suffix) return content;

  const prefix = delimiters.prefix.trim();
  const suffix = delimiters.suffix.trim();
  if (!prefix || !suffix) return content;

  const escapedPrefix = escapeRegex(prefix);
  const escapedSuffix = escapeRegex(suffix);
  let result = content.replace(new RegExp(`${escapedPrefix}([\\s\\S]*?)${escapedSuffix}`, "gi"), "$1");
  result = result.replace(new RegExp(`${escapedPrefix}([\\s\\S]*)$`, "gi"), "$1");
  return result;
}

// ─── Linguistic Attribution ────────────────────────────────────

// First-person pronouns — strong signal that the colored text belongs to the message owner
const FIRST_PERSON = /\b(I|I'm|I've|I'll|I'd|me|my|mine|myself)\b/i;

// Third-person name + verb adjacency within colored text
// Comprehensive list covering movement, speech, expression, combat, and general actions
const CHAR_VERB_INLINE = /\b(said|spoke|whispered|laughed|nodded|walked|stood|looked|smiled|sighed|muttered|replied|asked|turned|shook|grinned|snapped|murmured|growled|hissed|chuckled|exclaimed|called|breathed|moaned|screamed|cried|shouted|yelled|gasped|purred|demanded|insisted|admitted|announced|declared|stated|added|continued|began|started|finished|paused|hesitated|conceded|offered|suggested|warned|promised|threatened|pleaded|begged|commanded|ordered|instructed|stepped|moved|reached|pushed|pulled|knelt|crouched|leaned|dropped|drew|raised|lowered|crossed|traced|examined|watched|stared|glanced|noticed|studied|corrected|approached|entered|emerged|retreated|rose|sat|fell|stumbled|ran|charged|dodged|blocked|struck|grabbed|released|held|carried|placed|set|lifted|caught|threw|opened|closed|kicked|pressed|gripped|touched|pointed|gestured|waved|shrugged|bowed|flinched|winced|froze|trembled|shivered|blushed|frowned|scowled|squinted|blinked|swallowed|coughed|hummed|sang|paced|circled|spun|twisted|swung|slashed|parried|lunged|ducked|knelt|sprawled|collapsed|arched|flexed|tightened|relaxed|exhaled|inhaled)\b/i;

// Pre-attribution: "Name said/whispered/etc, '...'" or "Name: '...'"
const PRE_ATTR_PATTERN = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:said|spoke|whispered|asked|replied|muttered|murmured|growled|hissed|called|exclaimed|breathed|moaned|screamed|cried|shouted|yelled|gasped|purred|demanded|snapped|declared)\s*,?\s*[""\u201C]/;

// Post-attribution: '"...", said/whispered Name' or '"..." Name said'
const POST_ATTR_PATTERN = /[""\u201D]\s*(?:,\s*)?(?:said|asked|replied|whispered|murmured|exclaimed|muttered|growled|hissed|called|breathed|moaned|screamed|cried|shouted|gasped|purred|snapped|demanded|declared)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/;
const POST_ATTR_NAME_VERB = /[""\u201D]\s*(?:,\s*)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:said|asked|replied|whispered|murmured|exclaimed|muttered|growled|hissed|called|breathed|moaned|screamed|cried|shouted|gasped|purred|snapped|demanded|declared)/;
const DIALOGUE_ATTR_VERBS = "(?:said|spoke|whispered|asked|replied|muttered|murmured|growled|hissed|called|exclaimed|breathed|moaned|screamed|cried|shouted|yelled|gasped|purred|demanded|snapped|declared|warned|ordered|promised|added|answered|admitted)";

function findSurroundingDialogueAttribution(
  block: ExtractedColorBlock,
  rawContent: string,
  knownNames: string[],
  paragraphBounds?: { start: number; end: number },
): { entityName: string; confidence: number } | null {
  if (block.usageType !== "speech" && block.usageType !== "thought") return null;

  const before = paragraphBounds
    ? rawContent.slice(paragraphBounds.start, block.offset)
    : rawContent.slice(0, block.offset);
  const after = paragraphBounds
    ? rawContent.slice(block.offset + block.fullMatch.length, paragraphBounds.end)
    : rawContent.slice(block.offset + block.fullMatch.length);

  const plainBefore = stripFontTags(before).replace(/<[^>]*>/g, "").replace(/[*_]+/g, "");
  const plainAfter = stripFontTags(after).replace(/<[^>]*>/g, "").replace(/[*_]+/g, "");
  const verbs = block.usageType === "thought"
    ? "(?:thought|wondered|reflected|mused|realized|remembered|considered|reasoned|wished|hoped|feared|told herself|told himself|told themselves)"
    : DIALOGUE_ATTR_VERBS;

  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\s+${verbs}\\s*[:,]?\\s*["“]?\\s*$`, "i").test(plainBefore)) {
      return { entityName: name, confidence: 0.92 };
    }
    if (new RegExp(`\\b${verbs}\\s+${escaped}\\s*[:,]?\\s*$`, "i").test(plainBefore)) {
      return { entityName: name, confidence: 0.9 };
    }
    if (new RegExp(`^\\s*["”]?\\s*(?:[,.!?]\\s*)?${escaped}\\s+${verbs}\\b`, "i").test(plainAfter)) {
      return { entityName: name, confidence: 0.92 };
    }
    if (new RegExp(`^\\s*["”]?\\s*(?:[,.!?]\\s*)?${verbs}\\s+${escaped}\\b`, "i").test(plainAfter)) {
      return { entityName: name, confidence: 0.9 };
    }
  }

  return null;
}

/**
 * Determine the "focal character" of a paragraph — the character the paragraph
 * is primarily about, based on name + verb patterns in the plain text.
 *
 * In narrative RP, paragraphs almost always center on one character:
 *   "Melina stepped forward, her eyes gleaming. She drew her blade..."
 *
 * Returns null if no clear focal character can be determined.
 */
export function detectParagraphFocalCharacter(
  paragraphText: string,
  knownNames: string[],
): { name: string; confidence: number } | null {
  // Strip font tags to analyze plain narrative text
  const plainText = stripFontTags(paragraphText).replace(/"[^"]*"|“[^”]*”/g, " ");
  if (!plainText.trim()) return null;

  // Score each known name by how strongly they appear in this paragraph
  const scores: Array<{ name: string; score: number }> = [];

  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let score = 0;

    // Check if this name only appears in vocative (addressed) position
    // "Kael, can you read the wards?" — Kael is addressed, not acting
    const nameRegex = new RegExp(`\\b${escaped}\\b`, "gi");
    const allMatches = [...plainText.matchAll(nameRegex)];
    if (allMatches.length > 0) {
      const isOnlyVocative = allMatches.every((m) => {
        const afterName = plainText.slice(m.index! + m[0].length).trimStart();
        // Vocative: followed by comma + question/command word
        return /^[,!]\s*(?:can|could|will|would|do|don't|please|help|tell|listen|look|stop|wait|come|go|the|I\b)/i.test(afterName);
      });
      if (isOnlyVocative) {
        // Vocative-only names get a penalty — they're being addressed, not acting
        score -= 2;
      }
    }

    // Name at the very start of the paragraph (strongest signal for focal character)
    if (new RegExp(`^\\s*(?:\\[.*?\\]\\s*)?${escaped}\\b`, "i").test(plainText)) {
      score += 3;
    }

    // Name + action verb anywhere in paragraph
    if (new RegExp(`${escaped}\\s+${CHAR_VERB_INLINE.source}`, "i").test(plainText)) {
      score += 2;
    }
    if (new RegExp(`${CHAR_VERB_INLINE.source}\\s+${escaped}`, "i").test(plainText)) {
      score += 2;
    }

    // Name mentioned at all (weaker signal)
    const nameOccurrences = allMatches.length;
    if (nameOccurrences > 0) {
      score += Math.min(nameOccurrences, 3); // Cap at 3 to avoid name-spam skewing
    }

    // Possessive: "Name's" — indicates the paragraph describes their actions/possessions
    if (new RegExp(`${escaped}'s\\b`, "i").test(plainText)) {
      score += 1;
    }

    if (score > 0) scores.push({ name, score });
  }

  if (scores.length === 0) return null;

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  // Only return a focal character if there's a clear winner
  // (at least 2 points ahead of the runner-up, or only one candidate)
  if (scores.length === 1 || best.score - scores[1].score >= 2) {
    // Map score to confidence: 1-2 → 0.6, 3-4 → 0.7, 5+ → 0.8
    const confidence = best.score >= 5 ? 0.8 : best.score >= 3 ? 0.7 : 0.6;
    return { name: best.name, confidence };
  }

  return null;
}

/**
 * Scan the raw content around a color block's position for nearby character names.
 * PARAGRAPH-SCOPED: only searches within the same paragraph (up to double-newline boundaries),
 * then applies a radius constraint within that paragraph.
 *
 * Returns the closest matching character name, or null.
 */
function proximityNameScan(
  rawContent: string,
  blockOffset: number,
  blockLength: number,
  knownNames: string[],
  paragraphBounds?: { start: number; end: number },
  radius: number = 200,
): { name: string; distance: number } | null {
  // Determine paragraph boundaries: use provided bounds, or find them from content
  let paraStart: number;
  let paraEnd: number;

  if (paragraphBounds) {
    paraStart = paragraphBounds.start;
    paraEnd = paragraphBounds.end;
  } else {
    // Find paragraph boundaries around the block
    const before = rawContent.lastIndexOf("\n\n", blockOffset);
    paraStart = before === -1 ? 0 : before + 2;
    const after = rawContent.indexOf("\n\n", blockOffset + blockLength);
    paraEnd = after === -1 ? rawContent.length : after;
  }

  // Apply radius within the paragraph
  const windowStart = Math.max(paraStart, blockOffset - radius);
  const windowEnd = Math.min(paraEnd, blockOffset + blockLength + radius);
  const window = rawContent.slice(windowStart, windowEnd);

  // Strip font tags from the window so we only match names in plain text context
  const plainWindow = stripFontTags(window).replace(/"[^"]*"|“[^”]*”/g, (quoted) => " ".repeat(quoted.length));

  let bestMatch: { name: string; distance: number } | null = null;

  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`\\b${escaped}\\b`, "gi");
    let m;
    while ((m = namePattern.exec(plainWindow)) !== null) {
      // Calculate approximate distance from block center
      const namePos = windowStart + m.index;
      const blockCenter = blockOffset + blockLength / 2;
      const distance = Math.abs(namePos - blockCenter);
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { name, distance };
      }
    }
  }

  return bestMatch;
}

/**
 * Attempt to attribute a colored block to a character name.
 * Uses a layered strategy with paragraph context and proximity scanning.
 *
 * @param block - The extracted color block
 * @param messageOwner - Name from chunk prefix [CHARACTER|USER | Name] if available
 * @param knownNames - All known character/entity names in this chat
 * @param rawContent - The full raw content string (for proximity scanning)
 * @param focalCharacter - The paragraph's focal character (if detected)
 * @param multiCharacterContent - Whether the content contains multiple character names
 * @param paragraphBounds - Start/end offsets of the paragraph containing this block
 * @returns The attributed character name and confidence
 */
export function attributeColorBlock(
  block: ExtractedColorBlock,
  messageOwner: string | null,
  knownNames: string[],
  rawContent: string = "",
  focalCharacter: { name: string; confidence: number } | null = null,
  multiCharacterContent: boolean = false,
  paragraphBounds?: { start: number; end: number },
  firstPersonNarrator: boolean = false,
): { entityName: string | null; confidence: number } {
  const text = block.content;
  // Explicit speaker/thinker attribution outranks a character merely
  // described inside their words ("Kael walked away," Melina said).
  if (rawContent) {
    const surrounding = findSurroundingDialogueAttribution(block, rawContent, knownNames, paragraphBounds);
    if (surrounding) return surrounding;
  }
  // First-person narration establishes a viewpoint even when the author also
  // writes other characters. A standalone "My ..." thought must not lose its
  // owner merely because another paragraph mentions an NPC or an addressee.
  if (block.usageType === "thought" && FIRST_PERSON.test(text) && messageOwner && firstPersonNarrator) {
    const outsideBlock = paragraphBounds
      ? rawContent.slice(paragraphBounds.start, block.offset)
        + rawContent.slice(block.offset + block.fullMatch.length, paragraphBounds.end)
      : "";
    const localFocus = detectParagraphFocalCharacter(outsideBlock, knownNames);
    if (!localFocus || localFocus.name.toLowerCase() === messageOwner.toLowerCase()) {
      return { entityName: messageOwner, confidence: 0.8 };
    }
  }
  // A character described inside someone else's quotation is not the speaker.
  const actingText = text.replace(/"[^"]*"|“[^”]*”/g, " ");

  // Strategy 1: Third-person name + verb directly in the colored text
  // "Melina sighed" → Melina, high confidence
  // Skip names that appear only in vocative (addressed) position: "Kael, can you..."
  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Name + verb: "Melina sighed"
    if (new RegExp(`\\b${escaped}\\s+${CHAR_VERB_INLINE.source}`, "i").test(actingText)) {
      return { entityName: name, confidence: 0.9 };
    }
    // Verb + name: "said Melina"
    if (new RegExp(`${CHAR_VERB_INLINE.source}\\s+${escaped}\\b`, "i").test(actingText)) {
      return { entityName: name, confidence: 0.9 };
    }
  }

  // Strategy 2: Pre-attribution — "Melina said, 'Hello'" or "Melina whispered, 'I know'"
  const preMatch = text.match(PRE_ATTR_PATTERN);
  if (preMatch) {
    const matched = knownNames.find((n) => n.toLowerCase() === preMatch[1].toLowerCase());
    if (matched) return { entityName: matched, confidence: 0.88 };
  }

  // Strategy 3: Post-attribution — '"Hello," said Melina' or '"Hello," Melina said'
  const postMatch = text.match(POST_ATTR_PATTERN);
  if (postMatch) {
    const matched = knownNames.find((n) => n.toLowerCase() === postMatch[1].toLowerCase());
    if (matched) return { entityName: matched, confidence: 0.85 };
  }
  const postNameVerb = text.match(POST_ATTR_NAME_VERB);
  if (postNameVerb) {
    const matched = knownNames.find((n) => n.toLowerCase() === postNameVerb[1].toLowerCase());
    if (matched) return { entityName: matched, confidence: 0.85 };
  }

  // Strategy 5: Paragraph focal character — BEFORE proximity.
  // Focal character uses paragraph-wide analysis (name frequency, name+verb, lead-off position)
  // which is more reliable than raw proximity distance when multiple names appear.
  if (focalCharacter) {
    return { entityName: focalCharacter.name, confidence: focalCharacter.confidence };
  }

  // Strategy 6: Proximity scan — only fires when no focal character was found.
  // PARAGRAPH-SCOPED to avoid cross-paragraph bleed.
  // Filters out names that appear only in vocative (addressed) position.
  if (rawContent) {
    const proximity = proximityNameScan(rawContent, block.offset, block.fullMatch.length, knownNames, paragraphBounds);
    if (proximity) {
      // Check vocative status in the PARAGRAPH context (not just this block).
      // "Kael, can you read the wards?" in another block still means Kael is addressed, not acting.
      // Derive paragraph text from bounds or from raw content paragraph boundaries.
      let paragraphText: string;
      if (paragraphBounds) {
        paragraphText = rawContent.slice(paragraphBounds.start, paragraphBounds.end);
      } else {
        // Fall back to finding paragraph from double-newline boundaries
        const before = rawContent.lastIndexOf("\n\n", block.offset);
        const paraStart = before === -1 ? 0 : before + 2;
        const after = rawContent.indexOf("\n\n", block.offset + block.fullMatch.length);
        const paraEnd = after === -1 ? rawContent.length : after;
        paragraphText = rawContent.slice(paraStart, paraEnd);
      }
      const plainParagraph = stripFontTags(paragraphText);
      const isVocative = isNameVocativeOnly(plainParagraph, proximity.name);
      if (!isVocative) {
        if (proximity.distance < 100) {
          return { entityName: proximity.name, confidence: 0.78 };
        }
        if (proximity.distance < 200) {
          return { entityName: proximity.name, confidence: 0.65 };
        }
      }
    }
  }

  // Strategy 7: First-person pronouns → attribute to message owner
  // "I drew my blade" in a message from [CHARACTER | Melina] → Melina
  // In multi-character content, "I"/"me" could be ANY character speaking,
  // so confidence is lower to let color consistency override if available.
  if (FIRST_PERSON.test(text) && messageOwner) {
    const fpConfidence = multiCharacterContent ? 0.45 : 0.7;
    return { entityName: messageOwner, confidence: fpConfidence };
  }

  // Strategy 8: Message owner fallback (reduced confidence in multi-character content)
  if (messageOwner && text.trim().length > 10) {
    const fallbackConfidence = multiCharacterContent ? 0.35 : 0.5;
    return { entityName: messageOwner, confidence: fallbackConfidence };
  }

  return { entityName: null, confidence: 0 };
}

/**
 * Check if a character name appears only in vocative (addressed) position in text.
 * Vocative: "Kael, can you read the wards?" — Kael is being spoken TO, not acting.
 *
 * Patterns detected:
 *   - "Name," or "Name!" at sentence/block start
 *   - "Name, [question/command word]" (can, could, will, would, do, please, etc.)
 *   - "Oh Name" / "Dear Name"
 */
function isNameVocativeOnly(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check if name appears with a subject verb (name IS acting) — if so, NOT vocative
  if (new RegExp(`${escaped}\\s+${CHAR_VERB_INLINE.source}`, "i").test(text)) return false;
  if (new RegExp(`${CHAR_VERB_INLINE.source}\\s+${escaped}`, "i").test(text)) return false;

  // Vocative patterns: "Name, can/could/will/would/do/please/..."
  const vocativePattern = new RegExp(
    `${escaped}\\s*[,!]\\s*(?:can|could|will|would|do|don't|please|help|tell|listen|look|stop|wait|come|go)`,
    "i",
  );
  if (vocativePattern.test(text)) return true;

  // "Oh/Dear/Hey Name" — vocative address
  if (new RegExp(`\\b(?:oh|dear|hey|listen)\\s+${escaped}`, "i").test(text)) return true;

  // Name followed by comma at start of text: "Kael, the wards are..."
  if (new RegExp(`^\\s*${escaped}\\s*,`, "i").test(text)) return true;

  return false;
}

// ─── Message Owner Extraction ──────────────────────────────────

/**
 * Extract the message owner name from chunk format prefix.
 * "[CHARACTER | Melina]: content" → "Melina"
 * "[USER | Prolix]: content" → "Prolix"
 */
export function extractMessageOwner(chunkLine: string): string | null {
  const match = chunkLine.match(/^\[(?:CHARACTER|USER)\s*\|\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

// ─── Database Operations ───────────────────────────────────────

/**
 * Get all font color mappings for a chat.
 */
export function getColorMap(chatId: string): FontColorMapping[] {
  const rows = getDb()
    .query("SELECT * FROM memory_font_colors WHERE chat_id = ? ORDER BY confidence DESC")
    .all(chatId) as any[];

  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    entityId: r.entity_id,
    hexColor: r.hex_color,
    usageType: r.usage_type as ColorUsageType,
    confidence: r.confidence,
    sampleCount: r.sample_count,
    sampleExcerpt: r.sample_excerpt,
  }));
}

/**
 * Look up which entity owns a specific hex color.
 */
export function lookupColor(chatId: string, hexColor: string, usageType?: ColorUsageType): FontColorMapping | null {
  const rows = getDb()
    .query(`SELECT * FROM memory_font_colors WHERE chat_id = ? AND hex_color = ? AND confidence >= 0.6
      ${usageType ? "AND usage_type = ?" : ""} ORDER BY confidence DESC, sample_count DESC, id`)
    .all(...(usageType ? [chatId, hexColor, usageType] : [chatId, hexColor])) as any[];
  const row = rows[0];

  if (!row) return null;
  // Shared colors are formatting, not unique character identifiers.
  if (rows.some((other) => other.entity_id !== row.entity_id)) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    entityId: row.entity_id,
    hexColor: row.hex_color,
    usageType: row.usage_type as ColorUsageType,
    confidence: row.confidence,
    sampleCount: row.sample_count,
    sampleExcerpt: row.sample_excerpt,
  };
}

/**
 * Record or reinforce a color→entity attribution.
 * Confidence increases with each consistent observation.
 */
export function recordColorAttribution(
  chatId: string,
  hexColor: string,
  entityId: string | null,
  usageType: ColorUsageType,
  sampleExcerpt: string | null,
  evidenceConfidence = 0.7,
): void {
  const normalized = normalizeFontColor(hexColor);
  if (!normalized || !entityId || !Number.isFinite(evidenceConfidence) || evidenceConfidence < 0.6) return;
  hexColor = normalized;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // A character may use the same color for speech AND thoughts. Never let a
  // later observation overwrite the other channel (or another character).
  const existing = db
    .query("SELECT * FROM memory_font_colors WHERE chat_id = ? AND hex_color = ? AND entity_id = ? AND usage_type = ? ORDER BY confidence DESC, sample_count DESC, id LIMIT 1")
    .get(chatId, hexColor, entityId, usageType) as any;

  if (existing) {
    // Reinforce: increase count and confidence
    const newCount = existing.sample_count + 1;
    // Repetition cannot turn weak evidence into certainty; preserve manual
    // confidence overrides while bounding automatic reinforcement.
    const newConfidence = Math.max(existing.confidence, Math.min(0.95, evidenceConfidence + 0.05 * (1 - 1 / newCount)));

    db.query(
      `UPDATE memory_font_colors SET
        sample_count = ?, confidence = ?,
        sample_excerpt = COALESCE(?, sample_excerpt),
        updated_at = ?
       WHERE id = ?`,
    ).run(newCount, newConfidence, sampleExcerpt, now, existing.id);
  } else {
    db.query(
      `INSERT INTO memory_font_colors
        (id, chat_id, entity_id, hex_color, usage_type, confidence, sample_count, sample_excerpt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(crypto.randomUUID(), chatId, entityId, hexColor, usageType, Math.min(0.9, evidenceConfidence), sampleExcerpt, now, now);
  }
}

/**
 * Delete all font color mappings for a chat (used in rebuild).
 */
export function deleteColorMapForChat(chatId: string): void {
  getDb().query("DELETE FROM memory_font_colors WHERE chat_id = ?").run(chatId);
}

// ─── Paragraph Extraction ─────────────────────────────────────

/**
 * Split content into paragraphs (double-newline delimited) and return
 * both the text and the start offset of each paragraph.
 */
function splitParagraphs(content: string): Array<{ text: string; startOffset: number }> {
  return buildParagraphBoundaries(content).map((startOffset, index, offsets) => ({
    text: content.slice(startOffset, offsets[index + 1] ?? content.length), startOffset,
  }));
}

/**
 * Detect whether content contains references to multiple known character names.
 * Used to reduce message-owner fallback confidence in multi-character scenes.
 */
function isMultiCharacterContent(content: string, knownNames: string[]): boolean {
  const plainText = stripFontTags(content);
  let nameCount = 0;
  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(plainText)) {
      nameCount++;
      if (nameCount >= 2) return true;
    }
  }
  return false;
}

// ─── Ingestion Pipeline Entry Point ────────────────────────────

/**
 * Process a chunk's font colors: extract, attribute, record, and return stripped content.
 *
 * Uses paragraph-level context, proximity scanning, and a propagation pass
 * to maximize attribution accuracy in multi-character narrative content.
 *
 * @param chatId - The chat this chunk belongs to
 * @param content - Raw chunk content (may contain font tags)
 * @param knownEntityNames - Names of known entities in this chat
 * @param entityIdByName - Lookup map: entity name → entity ID
 * @returns Object with stripped content and any color data for prompt injection
 */
export function processChunkFontColors(
  chatId: string,
  content: string,
  knownEntityNames: string[],
  entityIdByName: Map<string, string>,
  thoughtDelimiters?: ThoughtDelimiters,
  persist = true,
): { strippedContent: string; attributions: ColorAttribution[] } {
  const seenNames = new Set<string>();
  knownEntityNames = knownEntityNames.filter((name) => {
    const key = name.toLowerCase();
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  const blocks = extractColorBlocks(content, thoughtDelimiters);
  if (blocks.length === 0) {
    return { strippedContent: stripThoughtDelimiters(content, thoughtDelimiters), attributions: [] };
  }

  // ── Phase 0: Context analysis ──
  // Chunk hydration can contain several message owners. Each block belongs
  // to its preceding prefix, rather than the final message in the chunk.
  const owners = [...content.matchAll(/^\[(?:CHARACTER|USER)\s*\|\s*([^\]]+)\]/gmi)]
    .map((match) => ({ offset: match.index!, name: match[1].trim() }));

  const messageContexts = owners.map((owner, index) => {
    const message = content.slice(owner.offset, owners[index + 1]?.offset ?? content.length);
    // Quoted words and thoughts cannot establish who narrates the message.
    // Inspect only the surrounding authored narration for first-person cues.
    const narrative = usageRanges(message, thoughtDelimiters).sort((a, b) => b.start - a.start)
      .reduce((text, range) => text.slice(0, range.start) + " ".repeat(range.end - range.start) + text.slice(range.end), message)
      .replace(/^\[(?:CHARACTER|USER)\s*\|[^\]]+\]:?/i, "");
    return { ...owner, multiChar: isMultiCharacterContent(message, knownEntityNames),
      firstPersonNarrator: FIRST_PERSON.test(stripFontTags(narrative).replace(/<[^>]*>/g, "")) };
  });

  // ── Phase 1: Compute paragraph focal characters ──
  const paragraphs = splitParagraphs(content);
  const focalByParagraph = new Map<number, { name: string; confidence: number }>();
  for (let i = 0; i < paragraphs.length; i++) {
    const focal = detectParagraphFocalCharacter(paragraphs[i].text, knownEntityNames);
    if (focal) focalByParagraph.set(i, focal);
  }

  // ── Phase 2: Primary attribution pass ──
  // Track attributions alongside their block index for the propagation pass
  const blockResults: Array<{
    block: ExtractedColorBlock;
    attribution: ColorAttribution;
    fromExisting: boolean;
  }> = [];

  for (const block of blocks) {
    // Fresh attribution via linguistic analysis with paragraph context + proximity
    const messageContext = messageContexts.findLast((owner) => owner.offset <= block.offset);
    const currentOwner = messageContext?.name ?? null;
    const focal = focalByParagraph.get(block.paragraphIndex) || null;
    const para = paragraphs[block.paragraphIndex];
    const paraBounds = para
      ? { start: para.startOffset, end: para.startOffset + para.text.length }
      : undefined;
    const attr = attributeColorBlock(block, currentOwner, knownEntityNames, content, focal,
      messageContext?.multiChar ?? isMultiCharacterContent(content, knownEntityNames), paraBounds, messageContext?.firstPersonNarrator);

    // Direct passage evidence takes precedence over old mappings. Historical
    // reuse keeps the newly detected channel and cannot reinforce itself.
    const existing = attr.confidence < 0.6 ? lookupColor(chatId, block.hexColor, block.usageType) : null;
    const existingName = existing?.entityId
      ? knownEntityNames.find((name) => entityIdByName.get(name.toLowerCase()) === existing.entityId) : null;

    blockResults.push({
      block,
      attribution: {
        hexColor: block.hexColor,
        entityName: existingName ?? attr.entityName,
        usageType: block.usageType,
        confidence: existingName ? Math.min(existing!.confidence, 0.7) : attr.confidence,
        evidence: [content.slice(Math.max(paraBounds?.start ?? 0, block.offset - 250),
          Math.min(paraBounds?.end ?? content.length, block.offset + block.fullMatch.length + 250))],
        fromHistory: !!existingName,
      },
      fromExisting: !!existingName,
    });
  }

  // ── Phase 3a: Cross-paragraph color consistency ──
  // Run BEFORE intra-paragraph propagation so that established color→character
  // mappings from confident paragraphs override weak fallbacks (e.g., first-person
  // "me" → message owner) before those fallbacks can propagate within a paragraph.
  //
  // Handles pronoun-only paragraphs where a character's color was established
  // earlier (e.g., Kael's #4682B4 from P1 reappears in P5 with no names).
  const colorToEntity = new Map<string, { entityName: string; confidence: number }>();
  const sharedColors = new Set<string>();

  // Build color→entity map from confident attributions
  for (const result of blockResults) {
    if (result.fromExisting || !result.attribution.entityName || result.attribution.confidence < 0.6) continue;
    const key = `${result.block.hexColor}:${result.block.usageType}`;
    const existing = colorToEntity.get(key);
    if (existing && existing.entityName !== result.attribution.entityName) sharedColors.add(key);
    if (!existing || result.attribution.confidence > existing.confidence) {
      colorToEntity.set(key, {
        entityName: result.attribution.entityName,
        confidence: result.attribution.confidence,
      });
    }
  }

  // Apply color consistency to low-confidence blocks
  for (const result of blockResults) {
    if (result.fromExisting) continue;
    if (result.attribution.entityName && result.attribution.confidence >= 0.6) continue;

    const key = `${result.block.hexColor}:${result.block.usageType}`;
    const established = sharedColors.has(key) ? undefined : colorToEntity.get(key);
    if (established && (!result.attribution.entityName || established.confidence > result.attribution.confidence)) {
      // Color consistency confidence: slightly below the source, capped at 0.7
      result.attribution.entityName = established.entityName;
      result.attribution.confidence = Math.min(established.confidence - 0.1, 0.7);
      result.attribution.fromHistory = false;
    }
  }

  // ── Phase 3b: Intra-paragraph propagation ──
  // Unattributed or low-confidence blocks inherit from confident neighbors
  // in the same paragraph. This handles cases like:
  //   <font color=#abc>Melina drew her sword.</font> <font color=#abc>The blade gleamed.</font>
  // Where the second block has no name but is clearly about Melina.
  for (let i = 0; i < blockResults.length; i++) {
    const result = blockResults[i];
    if (result.fromExisting) continue;
    if (result.attribution.entityName && result.attribution.confidence >= 0.6) continue;

    const paragraphIdx = result.block.paragraphIndex;

    // Find the best-attributed block in the same paragraph
    let bestNeighbor: { entityName: string; confidence: number } | null = null;
    const neighborOwners = new Set<string>();
    for (let j = 0; j < blockResults.length; j++) {
      if (j === i) continue;
      const neighbor = blockResults[j];
      if (neighbor.block.paragraphIndex !== paragraphIdx) continue;
      if (neighbor.fromExisting) continue;
      if (!neighbor.attribution.entityName || neighbor.attribution.confidence < 0.65) continue;
      neighborOwners.add(neighbor.attribution.entityName);

      // Same-color blocks are an even stronger signal
      const sameColor = neighbor.block.hexColor === result.block.hexColor;
      const effectiveConf = sameColor
        ? neighbor.attribution.confidence
        : neighbor.attribution.confidence - 0.1;

      if (!bestNeighbor || effectiveConf > bestNeighbor.confidence) {
        bestNeighbor = { entityName: neighbor.attribution.entityName, confidence: effectiveConf };
      }
    }

    if (neighborOwners.size === 1 && bestNeighbor && (!result.attribution.entityName || bestNeighbor.confidence > result.attribution.confidence)) {
      result.attribution.entityName = bestNeighbor.entityName;
      result.attribution.confidence = Math.min(bestNeighbor.confidence, 0.75);
    }
  }

  // ── Phase 4: Record and collect results ──
  const attributions = blockResults.map((result) => result.attribution);
  if (persist) {
    for (const attr of mergeColorAttributions(content, attributions, [], thoughtDelimiters)) {
      const entityId = entityIdByName.get(attr.entityName!.toLowerCase()) ?? null;
      recordColorAttribution(chatId, attr.hexColor, entityId, attr.usageType, attr.evidence?.[0]?.slice(0, 500) ?? null, attr.confidence);
    }
  }

  const strippedContent = stripThoughtDelimiters(stripFontTags(content), thoughtDelimiters).replace(/<\/?(?:i|em)\b[^>]*>/gi, "");
  return { strippedContent, attributions };
}

/** Only observed color/channel pairs can be proposed; one observation per owner
 * and channel per chunk prevents heuristic + sidecar double reinforcement. */
export function mergeColorAttributions(
  content: string,
  heuristic: ColorAttribution[],
  sidecar: Array<{ hexColor: string; characterName: string; usageType: ColorUsageType }>,
  thoughtDelimiters?: ThoughtDelimiters,
  canonicalize: (name: string) => string = (name) => name,
): ColorAttribution[] {
  const blocks = extractColorBlocks(content, thoughtDelimiters);
  const proposals = new Map<string, ColorAttribution>();
  for (const attr of [...heuristic, ...sidecar.map((color): ColorAttribution => ({ ...color, entityName: color.characterName, confidence: 0.8 }))]) {
    const hexColor = normalizeFontColor(attr.hexColor);
    const observed = blocks.filter((block) => block.hexColor === hexColor && block.usageType === attr.usageType);
    if (!hexColor || !attr.entityName || attr.fromHistory || attr.confidence < 0.6 || !observed.length) continue;
    const entityName = canonicalize(attr.entityName);
    const key = `${hexColor}:${attr.usageType}:${entityName.toLowerCase()}`;
    const prior = proposals.get(key);
    proposals.set(key, { hexColor, usageType: attr.usageType, entityName, confidence: Math.max(prior?.confidence ?? 0, attr.confidence),
      evidence: [...new Set([...(prior?.evidence ?? []), ...(attr.evidence ?? []), ...observed.map((block) => block.sourceMarkup ?? block.fullMatch)])] });
  }
  return [...proposals.values()];
}

// ─── Prompt Injection Formatting ───────────────────────────────

// Usage type display labels
const USAGE_LABELS: Record<ColorUsageType, string> = {
  speech: "Speech",
  thought: "Thoughts",
  narration: "Narration",
  unknown: "Other",
};

/**
 * Format the color map for a chat into a prompt-injectable string.
 * Groups colors by entity with per-usage-type lines for clarity.
 *
 * Output example:
 *   [Character Colors]
 *
 *   **Melina:**
 *   - Speech: #ff9999
 *   - Narration: #99ff99
 *
 *   **Kael:**
 *   - Speech: #abc123
 *   - Thoughts: #fec987
 */
export function formatColorMapForPrompt(chatId: string): string {
  const mappings = getColorMap(chatId).sort((a, b) => b.confidence - a.confidence || b.sampleCount - a.sampleCount || a.hexColor.localeCompare(b.hexColor));
  if (mappings.length === 0) return "";

  // Group by entity, keeping only the highest-confidence speech/thought color.
  const byEntity = new Map<string, Map<string, { hex: string; confidence: number }>>();
  const db = getDb();

  for (const m of mappings) {
    if (!m.entityId || m.confidence < 0.5) continue;
    if (m.usageType !== "speech" && m.usageType !== "thought") continue;

    // Resolve entity name
    const entityRow = db.query("SELECT name FROM memory_entities WHERE id = ?").get(m.entityId) as any;
    if (!entityRow) continue;

    const name = entityRow.name;
    if (!byEntity.has(name)) byEntity.set(name, new Map());
    const usageMap = byEntity.get(name)!;
    const label = USAGE_LABELS[m.usageType as ColorUsageType] || m.usageType;
    const existing = usageMap.get(label);
    if (!existing || m.confidence > existing.confidence) {
      usageMap.set(label, { hex: m.hexColor, confidence: m.confidence });
    }
  }

  if (byEntity.size === 0) return "";

  const sections: string[] = ["[Character Colors]"];
  for (const [name, usageMap] of byEntity) {
    const lines: string[] = [`\n**${name}:**`];
    for (const label of ["Speech", "Thoughts"]) {
      const entry = usageMap.get(label);
      if (entry) lines.push(`- ${label}: ${entry.hex}`);
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  return sections.length > 1 ? sections.join("\n") : "";
}
