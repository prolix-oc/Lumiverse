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
 * Attribution strategy (layered):
 *   1. Chunk prefix: [CHARACTER | Name] or [USER | Name] tells us message owner
 *   2. Existing color map: if we've seen this hex before with high confidence, reuse
 *   3. Third-person name + verb in colored block: "Melina sighed" → Melina
 *   4. First-person pronouns: "I drew my blade" → message owner
 *   5. Dialogue attribution: '"Hello," said Melina' → Melina (speech)
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
 * Returns the blocks with normalized hex colors and detected usage type.
 */
export function extractColorBlocks(content: string): ExtractedColorBlock[] {
  const blocks: ExtractedColorBlock[] = [];

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
      });
    }
  }

  return blocks;
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
const CHAR_VERB_INLINE = /\b(said|spoke|whispered|laughed|nodded|walked|stood|looked|smiled|sighed|muttered|replied|asked|turned|shook|grinned|snapped|murmured|growled|hissed|chuckled|exclaimed)\b/i;

/**
 * Attempt to attribute a colored block to a character name.
 *
 * @param block - The extracted color block
 * @param messageOwner - Name from chunk prefix [CHARACTER|USER | Name] if available
 * @param knownNames - All known character/entity names in this chat
 * @returns The attributed character name, or null if uncertain
 */
export function attributeColorBlock(
  block: ExtractedColorBlock,
  messageOwner: string | null,
  knownNames: string[],
): { entityName: string | null; confidence: number } {
  const text = block.content;

  // Strategy 1: Third-person name + verb directly in the colored text
  // "Melina sighed" → Melina, high confidence
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

  // Strategy 2: Dialogue attribution near the colored block
  // '"Hello," said Melina' — check for name in attribution after quotes
  const attrMatch = text.match(/[""\u201D]\s*(?:,\s*)?(?:said|asked|replied|whispered|murmured|exclaimed)\s+([A-Z][a-z]+)/);
  if (attrMatch) {
    const attrName = attrMatch[1];
    const matched = knownNames.find((n) => n.toLowerCase() === attrName.toLowerCase());
    if (matched) return { entityName: matched, confidence: 0.85 };
  }

  // Strategy 3: First-person pronouns → attribute to message owner
  // "I drew my blade" in a message from [CHARACTER | Melina] → Melina
  if (FIRST_PERSON.test(text) && messageOwner) {
    return { entityName: messageOwner, confidence: 0.7 };
  }

  // Strategy 4: Message owner fallback
  // If we know who owns the message and the colored text is substantial, it's likely theirs
  if (messageOwner && text.trim().length > 10) {
    return { entityName: messageOwner, confidence: 0.5 };
  }

  return { entityName: null, confidence: 0 };
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

// ─── Ingestion Pipeline Entry Point ────────────────────────────

/**
 * Process a chunk's font colors: extract, attribute, record, and return stripped content.
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

  const attributions: ColorAttribution[] = [];

  // Split content into lines to extract message owners from chunk format
  const lines = content.split("\n");
  let currentOwner: string | null = null;

  for (const line of lines) {
    const owner = extractMessageOwner(line);
    if (owner) currentOwner = owner;
  }

  for (const block of blocks) {
    // Check existing high-confidence mapping first
    const existing = lookupColor(chatId, block.hexColor);
    if (existing && existing.entityId) {
      // Already attributed with confidence — just reinforce
      recordColorAttribution(chatId, block.hexColor, existing.entityId, block.usageType, block.content.slice(0, 80));
      // Resolve entity name for prompt injection
      const entityName = knownEntityNames.find((n) => entityIdByName.get(n.toLowerCase()) === existing.entityId);
      attributions.push({
        hexColor: block.hexColor,
        entityName: entityName || null,
        usageType: existing.usageType,
        confidence: existing.confidence,
      });
      continue;
    }

    // Fresh attribution via linguistic analysis
    const attr = attributeColorBlock(block, currentOwner, knownEntityNames);
    if (attr.entityName) {
      const entityId = entityIdByName.get(attr.entityName.toLowerCase()) || null;
      recordColorAttribution(chatId, block.hexColor, entityId, block.usageType, block.content.slice(0, 80));
      attributions.push({
        hexColor: block.hexColor,
        entityName: attr.entityName,
        usageType: block.usageType,
        confidence: attr.confidence,
      });
    }
  }

  const strippedContent = stripFontTags(content);
  return { strippedContent, attributions };
}

// ─── Prompt Injection Formatting ───────────────────────────────

/**
 * Format the color map for a chat into a compact prompt-injectable string.
 * Output example:
 *   [Character Colors]
 *   - Melina: #ff9999 for narration, #99ff99 for speech
 *   - Prolix: #abc123 for speech, #fec987 for thought
 */
export function formatColorMapForPrompt(chatId: string): string {
  const mappings = getColorMap(chatId);
  if (mappings.length === 0) return "";

  // Group by entity
  const byEntity = new Map<string, Array<{ hex: string; usage: string }>>();
  const db = getDb();

  for (const m of mappings) {
    if (!m.entityId || m.confidence < 0.5) continue;

    // Resolve entity name
    const entityRow = db.query("SELECT name FROM memory_entities WHERE id = ?").get(m.entityId) as any;
    if (!entityRow) continue;

    const name = entityRow.name;
    if (!byEntity.has(name)) byEntity.set(name, []);
    byEntity.get(name)!.push({ hex: m.hexColor, usage: m.usageType });
  }

  if (byEntity.size === 0) return "";

  const lines: string[] = ["[Character Colors]"];
  for (const [name, colors] of byEntity) {
    const colorStrs = colors.map((c) => `${c.hex} for ${c.usage}`);
    lines.push(`- ${name}: ${colorStrs.join(", ")}`);
  }

  return lines.join("\n");
}
