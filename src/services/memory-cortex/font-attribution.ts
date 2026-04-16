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
 * Attribution strategy (layered, with paragraph-level context):
 *   1. Chunk prefix: [CHARACTER | Name] or [USER | Name] tells us message owner
 *   2. Existing color map: if we've seen this hex before with high confidence, reuse
 *   3. Third-person name + verb in colored block: "Melina sighed" → Melina
 *   4. Pre-attribution: 'Melina said, "Hello"' → Melina (speech)
 *   5. Dialogue attribution: '"Hello," said Melina' → Melina (speech)
 *   6. Proximity scan: character name within ~200 chars of the font tag → likely owner
 *   7. Paragraph focal character: if a paragraph is "about" a character, colored blocks inherit
 *   8. First-person pronouns: "I drew my blade" → message owner
 *   9. Propagation pass: unattributed blocks inherit from confident neighbors in same paragraph
 *
 * Usage type detection within a colored block:
 *   - Contains "..." quotes → speech
 *   - Contains *...* asterisk narration → thought
 *   - Otherwise → narration
 */

import { getDb } from "../../db/connection";

// ─── Types ─────────────────────────────────────────────────────

export type ColorUsageType = "speech" | "thought" | "narration" | "unknown";

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
}

export interface ColorAttribution {
  hexColor: string;
  entityName: string | null;
  usageType: ColorUsageType;
  confidence: number;
}

// ─── Font Tag Extraction ───────────────────────────────────────

// Matches <font color="...">content</font> and <span style="color: ...">content</span>
// Also handles UNQUOTED attributes: <font color=#E6E6FA> (common in RP formatting)
const FONT_TAG_QUOTED = /<font\s+color\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/font>/gi;
const FONT_TAG_UNQUOTED = /<font\s+color\s*=\s*([#\w]+)[^>]*>([\s\S]*?)<\/font>/gi;
const SPAN_COLOR_PATTERN = /<span\s+style\s*=\s*["'][^"']*color\s*:\s*([^;"']+)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;

/**
 * Extract all font-colored blocks from content.
 * Returns the blocks with normalized hex colors, detected usage type,
 * character offset, and paragraph index.
 */
export function extractColorBlocks(content: string): ExtractedColorBlock[] {
  const blocks: ExtractedColorBlock[] = [];

  // Pre-compute paragraph boundaries (split on double newline or paragraph-style breaks)
  const paragraphBoundaries = buildParagraphBoundaries(content);

  const seenOffsets = new Set<number>(); // Prevent double-matching quoted + unquoted
  for (const pattern of [FONT_TAG_QUOTED, FONT_TAG_UNQUOTED, SPAN_COLOR_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (seenOffsets.has(match.index)) continue; // Skip double-match
      seenOffsets.add(match.index);

      const rawColor = match[1].trim();
      const innerContent = match[2];
      const hexColor = normalizeColor(rawColor);
      if (!hexColor) continue;

      blocks.push({
        hexColor,
        content: innerContent,
        fullMatch: match[0],
        usageType: detectUsageType(innerContent),
        offset: match.index,
        paragraphIndex: findParagraphIndex(match.index, paragraphBoundaries),
      });
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
  return boundaries;
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
  let result = content;
  // Quoted: <font color="...">
  result = result.replace(/<font\s+color\s*=\s*["'][^"']*["'][^>]*>([\s\S]*?)<\/font>/gi, "$1");
  // Unquoted: <font color=#hex>
  result = result.replace(/<font\s+color\s*=\s*[#\w]+[^>]*>([\s\S]*?)<\/font>/gi, "$1");
  // Orphaned closing tags
  result = result.replace(/<\/font>/gi, "");
  // Span color
  result = result.replace(/<span\s+style\s*=\s*["'][^"']*color\s*:\s*[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi, "$1");
  return result;
}

// ─── Color Normalization ───────────────────────────────────────

function normalizeColor(raw: string): string | null {
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
  if (NAMED[trimmed]) return NAMED[trimmed];

  return null;
}

// ─── Usage Type Detection ──────────────────────────────────────

function detectUsageType(coloredContent: string): ColorUsageType {
  const trimmed = coloredContent.trim();
  // Quoted dialogue: "Hello" or "Hello," she said
  if (/[""\u201C][^""\u201D]+[""\u201D]/.test(trimmed)) return "speech";
  // Asterisk-wrapped narration: *she hesitated*
  if (/^\*[^*]+\*$/.test(trimmed) || /^\*/.test(trimmed)) return "thought";
  // Italic HTML
  if (/<[ie]m>/i.test(trimmed)) return "thought";
  return "narration";
}

// ─── Linguistic Attribution ────────────────────────────────────

// First-person pronouns — strong signal that the colored text belongs to the message owner
const FIRST_PERSON = /\b(I|I'm|I've|I'll|I'd|me|my|mine|myself)\b/;

// Third-person name + verb adjacency within colored text
// Comprehensive list covering movement, speech, expression, combat, and general actions
const CHAR_VERB_INLINE = /\b(said|spoke|whispered|laughed|nodded|walked|stood|looked|smiled|sighed|muttered|replied|asked|turned|shook|grinned|snapped|murmured|growled|hissed|chuckled|exclaimed|called|breathed|moaned|screamed|cried|shouted|yelled|gasped|purred|demanded|insisted|admitted|announced|declared|stated|added|continued|began|started|finished|paused|hesitated|conceded|offered|suggested|warned|promised|threatened|pleaded|begged|commanded|ordered|instructed|stepped|moved|reached|pushed|pulled|knelt|crouched|leaned|dropped|drew|raised|lowered|crossed|traced|examined|watched|stared|glanced|noticed|studied|corrected|approached|entered|emerged|retreated|rose|sat|fell|stumbled|ran|charged|dodged|blocked|struck|grabbed|released|held|carried|placed|set|lifted|caught|threw|opened|closed|kicked|pressed|gripped|touched|pointed|gestured|waved|shrugged|bowed|flinched|winced|froze|trembled|shivered|blushed|frowned|scowled|squinted|blinked|swallowed|coughed|hummed|sang|paced|circled|spun|twisted|swung|slashed|parried|lunged|ducked|knelt|sprawled|collapsed|arched|flexed|tightened|relaxed|exhaled|inhaled)\b/i;

// Pre-attribution: "Name said/whispered/etc, '...'" or "Name: '...'"
const PRE_ATTR_PATTERN = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:said|spoke|whispered|asked|replied|muttered|murmured|growled|hissed|called|exclaimed|breathed|moaned|screamed|cried|shouted|yelled|gasped|purred|demanded|snapped|declared)\s*,?\s*[""\u201C]/;

// Post-attribution: '"...", said/whispered Name' or '"..." Name said'
const POST_ATTR_PATTERN = /[""\u201D]\s*(?:,\s*)?(?:said|asked|replied|whispered|murmured|exclaimed|muttered|growled|hissed|called|breathed|moaned|screamed|cried|shouted|gasped|purred|snapped|demanded|declared)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/;
const POST_ATTR_NAME_VERB = /[""\u201D]\s*(?:,\s*)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:said|asked|replied|whispered|murmured|exclaimed|muttered|growled|hissed|called|breathed|moaned|screamed|cried|shouted|gasped|purred|snapped|demanded|declared)/;

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
  const plainText = stripFontTags(paragraphText);
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
  const plainWindow = stripFontTags(window);

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
): { entityName: string | null; confidence: number } {
  const text = block.content;

  // Strategy 1: Third-person name + verb directly in the colored text
  // "Melina sighed" → Melina, high confidence
  // Skip names that appear only in vocative (addressed) position: "Kael, can you..."
  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Name + verb: "Melina sighed"
    if (new RegExp(`${escaped}\\s+${CHAR_VERB_INLINE.source}`, "i").test(text)) {
      return { entityName: name, confidence: 0.9 };
    }
    // Verb + name: "said Melina"
    if (new RegExp(`${CHAR_VERB_INLINE.source}\\s+${escaped}`, "i").test(text)) {
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

  // Strategy 4: Paragraph focal character — BEFORE proximity.
  // Focal character uses paragraph-wide analysis (name frequency, name+verb, lead-off position)
  // which is more reliable than raw proximity distance when multiple names appear.
  if (focalCharacter) {
    return { entityName: focalCharacter.name, confidence: focalCharacter.confidence };
  }

  // Strategy 5: Proximity scan — only fires when no focal character was found.
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

  // Strategy 6: First-person pronouns → attribute to message owner
  // "I drew my blade" in a message from [CHARACTER | Melina] → Melina
  // In multi-character content, "I"/"me" could be ANY character speaking,
  // so confidence is lower to let color consistency override if available.
  if (FIRST_PERSON.test(text) && messageOwner) {
    const fpConfidence = multiCharacterContent ? 0.45 : 0.7;
    return { entityName: messageOwner, confidence: fpConfidence };
  }

  // Strategy 7: Message owner fallback (reduced confidence in multi-character content)
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
export function lookupColor(chatId: string, hexColor: string): FontColorMapping | null {
  const row = getDb()
    .query("SELECT * FROM memory_font_colors WHERE chat_id = ? AND hex_color = ? AND confidence >= 0.5 ORDER BY confidence DESC LIMIT 1")
    .get(chatId, hexColor) as any;

  if (!row) return null;
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
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Check for existing mapping with same color + entity
  const existing = db
    .query("SELECT * FROM memory_font_colors WHERE chat_id = ? AND hex_color = ? AND entity_id IS ?")
    .get(chatId, hexColor, entityId) as any;

  if (existing) {
    // Reinforce: increase count and confidence
    const newCount = existing.sample_count + 1;
    // Confidence approaches 1.0 asymptotically: 0.5 + 0.5 * (1 - 1/(count+1))
    const newConfidence = Math.min(0.95, 0.4 + 0.55 * (1 - 1 / (newCount + 1)));

    db.query(
      `UPDATE memory_font_colors SET
        sample_count = ?, confidence = ?, usage_type = ?,
        sample_excerpt = COALESCE(?, sample_excerpt),
        updated_at = ?
       WHERE id = ?`,
    ).run(newCount, newConfidence, usageType, sampleExcerpt, now, existing.id);
  } else {
    // Check if this color is attributed to a DIFFERENT entity
    const conflict = db
      .query("SELECT * FROM memory_font_colors WHERE chat_id = ? AND hex_color = ? AND entity_id IS NOT ?")
      .get(chatId, hexColor, entityId) as any;

    if (conflict && conflict.confidence > 0.7) {
      // High-confidence conflict — don't overwrite, this might be a POV switch in group chat
      // Only override if we accumulate enough counter-evidence
      return;
    }

    // New mapping or low-confidence override
    if (conflict) {
      db.query("DELETE FROM memory_font_colors WHERE id = ?").run(conflict.id);
    }

    db.query(
      `INSERT INTO memory_font_colors
        (id, chat_id, entity_id, hex_color, usage_type, confidence, sample_count, sample_excerpt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0.4, 1, ?, ?, ?)`,
    ).run(crypto.randomUUID(), chatId, entityId, hexColor, usageType, sampleExcerpt, now, now);
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
  const result: Array<{ text: string; startOffset: number }> = [];
  const parts = content.split(/\n\s*\n/);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    result.push({ text: parts[i], startOffset: offset });
    // Account for the delimiter we split on (approximate — at minimum 2 chars \n\n)
    offset += parts[i].length;
    if (i < parts.length - 1) {
      // Find the actual delimiter length in the original content
      const remaining = content.slice(offset);
      const delimMatch = remaining.match(/^\n\s*\n/);
      offset += delimMatch ? delimMatch[0].length : 2;
    }
  }
  return result;
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
): { strippedContent: string; attributions: ColorAttribution[] } {
  const blocks = extractColorBlocks(content);
  if (blocks.length === 0) {
    return { strippedContent: content, attributions: [] };
  }

  // ── Phase 0: Context analysis ──
  // Extract message owner from chunk prefix
  const lines = content.split("\n");
  let currentOwner: string | null = null;
  for (const line of lines) {
    const owner = extractMessageOwner(line);
    if (owner) currentOwner = owner;
  }

  // Detect multi-character content (reduces message-owner fallback confidence)
  const multiChar = isMultiCharacterContent(content, knownEntityNames);

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
    // Check existing high-confidence mapping first
    const existing = lookupColor(chatId, block.hexColor);
    if (existing && existing.entityId) {
      recordColorAttribution(chatId, block.hexColor, existing.entityId, block.usageType, block.content.slice(0, 80));
      const entityName = knownEntityNames.find((n) => entityIdByName.get(n.toLowerCase()) === existing.entityId);
      blockResults.push({
        block,
        attribution: {
          hexColor: block.hexColor,
          entityName: entityName || null,
          usageType: existing.usageType,
          confidence: existing.confidence,
        },
        fromExisting: true,
      });
      continue;
    }

    // Fresh attribution via linguistic analysis with paragraph context + proximity
    const focal = focalByParagraph.get(block.paragraphIndex) || null;
    const para = paragraphs[block.paragraphIndex];
    const paraBounds = para
      ? { start: para.startOffset, end: para.startOffset + para.text.length }
      : undefined;
    const attr = attributeColorBlock(block, currentOwner, knownEntityNames, content, focal, multiChar, paraBounds);

    blockResults.push({
      block,
      attribution: {
        hexColor: block.hexColor,
        entityName: attr.entityName,
        usageType: block.usageType,
        confidence: attr.confidence,
      },
      fromExisting: false,
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

  // Build color→entity map from confident attributions
  for (const result of blockResults) {
    if (!result.attribution.entityName || result.attribution.confidence < 0.6) continue;
    const key = result.block.hexColor;
    const existing = colorToEntity.get(key);
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

    const established = colorToEntity.get(result.block.hexColor);
    if (established && (!result.attribution.entityName || established.confidence > result.attribution.confidence)) {
      // Color consistency confidence: slightly below the source, capped at 0.7
      result.attribution.entityName = established.entityName;
      result.attribution.confidence = Math.min(established.confidence - 0.1, 0.7);
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
    for (let j = 0; j < blockResults.length; j++) {
      if (j === i) continue;
      const neighbor = blockResults[j];
      if (neighbor.block.paragraphIndex !== paragraphIdx) continue;
      if (!neighbor.attribution.entityName || neighbor.attribution.confidence < 0.65) continue;

      // Same-color blocks are an even stronger signal
      const sameColor = neighbor.block.hexColor === result.block.hexColor;
      const effectiveConf = sameColor
        ? neighbor.attribution.confidence
        : neighbor.attribution.confidence - 0.1;

      if (!bestNeighbor || effectiveConf > bestNeighbor.confidence) {
        bestNeighbor = { entityName: neighbor.attribution.entityName, confidence: effectiveConf };
      }
    }

    if (bestNeighbor && (!result.attribution.entityName || bestNeighbor.confidence > result.attribution.confidence)) {
      result.attribution.entityName = bestNeighbor.entityName;
      result.attribution.confidence = Math.min(bestNeighbor.confidence, 0.75);
    }
  }

  // ── Phase 4: Record and collect results ──
  const attributions: ColorAttribution[] = [];
  for (const result of blockResults) {
    if (result.fromExisting) {
      attributions.push(result.attribution);
      continue;
    }

    if (result.attribution.entityName) {
      const entityId = entityIdByName.get(result.attribution.entityName.toLowerCase()) || null;
      recordColorAttribution(chatId, result.block.hexColor, entityId, result.block.usageType, result.block.content.slice(0, 80));
    }
    attributions.push(result.attribution);
  }

  const strippedContent = stripFontTags(content);
  return { strippedContent, attributions };
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
  const mappings = getColorMap(chatId);
  if (mappings.length === 0) return "";

  // Group by entity, then by usage type
  const byEntity = new Map<string, Map<string, string>>();
  const db = getDb();

  for (const m of mappings) {
    if (!m.entityId || m.confidence < 0.5) continue;

    // Resolve entity name
    const entityRow = db.query("SELECT name FROM memory_entities WHERE id = ?").get(m.entityId) as any;
    if (!entityRow) continue;

    const name = entityRow.name;
    if (!byEntity.has(name)) byEntity.set(name, new Map());
    const usageMap = byEntity.get(name)!;
    const label = USAGE_LABELS[m.usageType as ColorUsageType] || m.usageType;
    // Keep the highest-confidence mapping per usage type
    if (!usageMap.has(label)) {
      usageMap.set(label, m.hexColor);
    }
  }

  if (byEntity.size === 0) return "";

  const sections: string[] = ["[Character Colors]"];
  for (const [name, usageMap] of byEntity) {
    const lines: string[] = [`\n**${name}:**`];
    for (const [label, hex] of usageMap) {
      lines.push(`- ${label}: ${hex}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n");
}
