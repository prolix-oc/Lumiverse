/**
 * Font color attribution heuristic test suite.
 *
 * Tests the pure linguistic analysis functions (no DB) against a worst-case
 * 8-paragraph multi-character narrative with font colors for speech, thoughts,
 * and prose across 4 characters.
 *
 * Run: bun test src/services/memory-cortex/font-attribution.test.ts
 */

import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  extractColorBlocks,
  stripFontTags,
  stripThoughtDelimiters,
  attributeColorBlock,
  extractMessageOwner,
  detectParagraphFocalCharacter,
  processChunkFontColors,
  formatColorMapForPrompt,
  getColorMap,
  type ExtractedColorBlock,
} from "./font-attribution";

// ─── Test Characters ──────────────────────────────────────────

const KNOWN_NAMES = ["Melina", "Kael", "Seraphine", "Voss"];
const THOUGHT_DELIMITERS = { prefix: "<thinking>", suffix: "</thinking>" };

// Character color assignments in this test narrative:
//   Melina:    #E6E6FA (speech), #D8BFD8 (narration/thought)
//   Kael:      #87CEEB (speech), #4682B4 (narration/thought)
//   Seraphine: #98FB98 (speech), #3CB371 (narration/thought)
//   Voss:      #FFD700 (speech), #DAA520 (narration/thought)

// ─── Worst-Case 8-Paragraph Narrative ─────────────────────────

const WORST_CASE_NARRATIVE = `[CHARACTER | Melina]
<font color=#D8BFD8>Melina stepped through the broken archway, her boots crunching on scattered glass. The air tasted of rust and old magic.</font> <font color=#E6E6FA>"We shouldn't be here,"</font> <font color=#D8BFD8>she whispered, one hand resting on the pommel of her blade.</font>

<font color=#87CEEB>"And yet here we are,"</font> <font color=#4682B4>Kael replied from the shadows, his voice carrying the dry amusement that never quite reached his eyes. He leaned against a crumbling pillar, arms crossed, watching the others file in.</font>

<font color=#3CB371>The healer moved silently, her robes barely brushing the floor. Seraphine's gaze swept the chamber — noting the collapsed ceiling, the faded murals, the dark stains on the stone.</font> <font color=#98FB98>"There's residual energy here. Something powerful died in this place."</font>

<font color=#FFD700>"Died, or was killed,"</font> <font color=#DAA520>Voss corrected, dropping his pack with a heavy thud. The mercenary crouched beside a scorch mark, tracing it with one calloused finger.</font> <font color=#FFD700>"These burns are deliberate. Someone cornered whatever lived here."</font>

<font color=#D8BFD8>The swordswoman's jaw tightened. She could feel it too — the wrongness in the air, like a note held too long.</font> <font color=#E6E6FA>"Kael, can you read the wards? I need to know if anything's still active."</font>

<font color=#4682B4>He pushed off the pillar with a sigh, fingers already tracing luminous patterns in the air.</font> <font color=#87CEEB>"Give me a moment."</font> <font color=#4682B4>The runes flickered to life around his hands, casting blue light across his scarred face. His brow furrowed.</font> <font color=#87CEEB>"The outer wards are dead. But there's something deeper — layered. Old school binding work."</font>

<font color=#3CB371>Seraphine knelt beside Voss, examining the scorch marks with a clinical eye.</font> <font color=#98FB98>"These aren't from combat magic,"</font> <font color=#3CB371>she murmured, pulling a vial from her satchel.</font> <font color=#98FB98>"The pattern is ritualistic. Whoever did this was performing a summoning — or a banishment."</font>

<font color=#DAA520>The mercenary exchanged a look with Melina across the chamber. Neither spoke, but the understanding passed between them — they'd seen this kind of aftermath before, in the Ashenvale ruins.</font> <font color=#FFD700>"We should secure the exits,"</font> <font color=#DAA520>Voss said quietly, rising to his feet and drawing his axe.</font> <font color=#FFD700>"Whatever was bound here might not be gone."</font>`;

const THOUGHT_AND_SPEECH_NARRATIVE = `[CHARACTER | Melina]
<font color=#C8A2C8><thinking>If the seal was fraying, Melina needed to keep the others calm.</thinking></font> <font color=#E6E6FA>"Stay close to me,"</font> <font color=#D8BFD8>Melina said, lifting her lantern toward the first arch.</font>

<font color=#5F9EA0><thinking>Kael counted the dormant glyphs and hated how many had been carved by a patient hand.</thinking></font> <font color=#87CEEB>"None of these runes are recent,"</font> <font color=#4682B4>Kael warned, crouching beside the dust-lined wall.</font>

<font color=#90EE90><thinking>Seraphine listened for the rhythm of the chamber and felt a pulse answering beneath the stone.</thinking></font> <font color=#98FB98>"There's a heartbeat under the floor,"</font> <font color=#3CB371>Seraphine murmured as her fingers hovered over the cracks.</font>

<font color=#F0E68C><thinking>Voss measured every doorway by escape routes first, because old ruins loved to become graves.</thinking></font> <font color=#FFD700>"Then we choose the exit before we choose the fight,"</font> <font color=#DAA520>Voss replied, shifting his grip on the axe.</font>

<font color=#C8A2C8><thinking>The stale air pressed against her lungs, but Melina would not let fear show on her face.</thinking></font> <font color=#E6E6FA>"Mark the safe path and call it loud,"</font> <font color=#D8BFD8>Melina ordered without taking her eyes off the dark passage.</font>

<font color=#5F9EA0><thinking>If the binding collapsed now, Kael would have only one spell worth trusting.</thinking></font> <font color=#87CEEB>"I can hold the breach for a minute, maybe two,"</font> <font color=#4682B4>he said after tracing the nearest fracture with one gloved thumb.</font>

<font color=#90EE90><thinking>Seraphine knew the others heard bravery, but she heard exhaustion creeping into every breath.</thinking></font> <font color=#98FB98>"When this is over, all of you are drinking the entire recovery draught,"</font> <font color=#3CB371>the healer said, almost smiling despite the tension.</font>

<font color=#F0E68C><thinking>Voss trusted the plan more than the ruin, and the ruin had earned none of his patience.</thinking></font> <font color=#FFD700>"On your signal, I shut the doors and make this chamber ours,"</font> <font color=#DAA520>Voss promised as the final ward flickered awake.</font>`;

function initFontColorTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE memory_font_colors (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    entity_id TEXT,
    hex_color TEXT NOT NULL,
    usage_type TEXT DEFAULT 'unknown',
    confidence REAL DEFAULT 0.0,
    sample_count INTEGER DEFAULT 0,
    sample_excerpt TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE memory_entities (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL
  )`);
}

beforeEach(() => {
  initFontColorTestDb();
});

afterEach(() => {
  closeDatabase();
});

// ─── Helper: Create a block for testing attributeColorBlock ───

function makeBlock(
  hexColor: string,
  content: string,
  offset: number = 0,
  paragraphIndex: number = 0,
): ExtractedColorBlock {
  const usageType = /[""\u201C][^""\u201D]+[""\u201D]/.test(content.trim())
    ? "speech" as const
    : /^\*/.test(content.trim()) || /<[ie]m>/i.test(content.trim())
      ? "thought" as const
      : "narration" as const;

  return {
    hexColor,
    content,
    fullMatch: `<font color=${hexColor}>${content}</font>`,
    usageType,
    offset,
    paragraphIndex,
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe("extractColorBlocks", () => {
  test("extracts all color blocks from the worst-case narrative", () => {
    const blocks = extractColorBlocks(WORST_CASE_NARRATIVE);
    // Count: each paragraph has 2-4 colored blocks
    expect(blocks.length).toBeGreaterThanOrEqual(20);
  });

  test("assigns correct paragraph indices", () => {
    const blocks = extractColorBlocks(WORST_CASE_NARRATIVE);
    // First paragraph blocks should all be paragraph 0
    const p0Blocks = blocks.filter((b) => b.paragraphIndex === 0);
    expect(p0Blocks.length).toBe(3); // Melina's narration, speech, narration

    // Each subsequent paragraph should increment
    const uniqueParagraphs = new Set(blocks.map((b) => b.paragraphIndex));
    expect(uniqueParagraphs.size).toBe(8); // 8 paragraphs
  });

  test("preserves document order via offset sorting", () => {
    const blocks = extractColorBlocks(WORST_CASE_NARRATIVE);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].offset).toBeGreaterThan(blocks[i - 1].offset);
    }
  });

  test("detects usage types correctly", () => {
    const blocks = extractColorBlocks(WORST_CASE_NARRATIVE);
    const speeches = blocks.filter((b) => b.usageType === "speech");
    const narrations = blocks.filter((b) => b.usageType === "narration");

    // Should have both speech and narration blocks
    expect(speeches.length).toBeGreaterThanOrEqual(8);
    expect(narrations.length).toBeGreaterThanOrEqual(10);
  });

  test("detects thought blocks using configured delimiters", () => {
    const content = '<font color=#C8A2C8><thinking>I cannot let them see me hesitate.</thinking></font>';
    const blocks = extractColorBlocks(content, THOUGHT_DELIMITERS);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].usageType).toBe("thought");
  });

  test("detects thought blocks wrapped in asterisks", () => {
    const content = '<font color=#C8A2C8>*I cannot let them see me hesitate.*</font>';
    const blocks = extractColorBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].usageType).toBe("thought");
  });
});

describe("stripFontTags", () => {
  test("removes all font tags while preserving content", () => {
    const input = '<font color=#E6E6FA>"Hello,"</font> she said.';
    const stripped = stripFontTags(input);
    expect(stripped).toBe('"Hello," she said.');
  });

  test("handles non-nested content", () => {
    const input = '<font color="#abc">first</font> and <font color="#def">second</font>';
    const stripped = stripFontTags(input);
    expect(stripped).not.toContain("<font");
    expect(stripped).toBe("first and second");
  });

  test("strips configured thought delimiters while preserving inner text", () => {
    const input = '<thinking>Hold the line.</thinking>';
    expect(stripThoughtDelimiters(input, THOUGHT_DELIMITERS)).toBe("Hold the line.");
  });
});

describe("extractMessageOwner", () => {
  test("extracts CHARACTER owner", () => {
    expect(extractMessageOwner("[CHARACTER | Melina]: Hello")).toBe("Melina");
  });

  test("extracts USER owner", () => {
    expect(extractMessageOwner("[USER | Prolix]: Hey")).toBe("Prolix");
  });

  test("returns null for non-prefixed lines", () => {
    expect(extractMessageOwner("Just some text")).toBeNull();
  });
});

describe("detectParagraphFocalCharacter", () => {
  test("detects focal character from name at paragraph start", () => {
    const text = "Melina stepped forward, drawing her blade. The moonlight gleamed off the steel.";
    const focal = detectParagraphFocalCharacter(text, KNOWN_NAMES);
    expect(focal).not.toBeNull();
    expect(focal!.name).toBe("Melina");
  });

  test("detects focal character from name + verb in paragraph", () => {
    const text = "The shadows parted as Kael stepped forward. He raised one hand, fingers tracing runes.";
    const focal = detectParagraphFocalCharacter(text, KNOWN_NAMES);
    expect(focal).not.toBeNull();
    expect(focal!.name).toBe("Kael");
  });

  test("picks character at start when two are otherwise equal", () => {
    // "Melina" starts the paragraph, giving her a +3 lead-off bonus.
    // This is correct — in RP narration, the paragraph-leading character is focal.
    const text = "Melina looked at Kael. Kael looked at Melina. They stared.";
    const focal = detectParagraphFocalCharacter(text, KNOWN_NAMES);
    expect(focal).not.toBeNull();
    expect(focal!.name).toBe("Melina");
  });

  test("returns null when characters are equally present with no lead-off", () => {
    // Neither character starts the paragraph, and both have equal verb+mention presence
    const text = "The two warriors faced each other. Kael raised his sword while Melina raised her shield.";
    const focal = detectParagraphFocalCharacter(text, KNOWN_NAMES);
    // Kael and Melina both have name+verb and 1 mention each, no lead-off → tie
    expect(focal).toBeNull();
  });

  test("detects focal character with possessive", () => {
    const text = "The healer moved silently. Seraphine's gaze swept the chamber, noting the damage.";
    const focal = detectParagraphFocalCharacter(text, KNOWN_NAMES);
    expect(focal).not.toBeNull();
    expect(focal!.name).toBe("Seraphine");
  });

  test("handles font tags in paragraph text (strips before analysis)", () => {
    const text = '<font color=#abc>Voss dropped his pack.</font> <font color=#def>"Stay alert,"</font> he said.';
    const focal = detectParagraphFocalCharacter(text, KNOWN_NAMES);
    expect(focal).not.toBeNull();
    expect(focal!.name).toBe("Voss");
  });
});

describe("attributeColorBlock — direct name+verb in block", () => {
  test("attributes 'Melina stepped through...' to Melina", () => {
    const block = makeBlock("#D8BFD8", "Melina stepped through the broken archway, her boots crunching on scattered glass.");
    const result = attributeColorBlock(block, null, KNOWN_NAMES);
    expect(result.entityName).toBe("Melina");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("attributes 'Kael replied from the shadows' to Kael", () => {
    const block = makeBlock("#4682B4", "Kael replied from the shadows, his voice carrying dry amusement.");
    const result = attributeColorBlock(block, null, KNOWN_NAMES);
    expect(result.entityName).toBe("Kael");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("attributes 'Voss corrected' to Voss", () => {
    const block = makeBlock("#DAA520", "Voss corrected, dropping his pack with a heavy thud.");
    const result = attributeColorBlock(block, null, KNOWN_NAMES);
    expect(result.entityName).toBe("Voss");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("attributeColorBlock — dialogue attribution patterns", () => {
  test("pre-attribution: 'Melina whispered, \"text\"' ", () => {
    const block = makeBlock("#E6E6FA", 'Melina whispered, "We shouldn\'t be here."');
    const result = attributeColorBlock(block, null, KNOWN_NAMES);
    expect(result.entityName).toBe("Melina");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test("post-attribution: '\"text,\" said Kael'", () => {
    const block = makeBlock("#87CEEB", '"And yet here we are," said Kael.');
    const result = attributeColorBlock(block, null, KNOWN_NAMES);
    expect(result.entityName).toBe("Kael");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test("post-attribution name-verb: '\"text,\" Seraphine murmured'", () => {
    const block = makeBlock("#98FB98", '"The pattern is ritualistic," Seraphine murmured.');
    const result = attributeColorBlock(block, null, KNOWN_NAMES);
    expect(result.entityName).toBe("Seraphine");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe("attributeColorBlock — proximity and context", () => {
  test("proximity: unnamed block near character name in raw content", () => {
    // "Melina reached out." is plain text, followed by a color block with no name
    const rawContent = 'Melina reached out. <font color=#D8BFD8>Her hand trembled as she touched the wall.</font>';
    const block = makeBlock("#D8BFD8", "Her hand trembled as she touched the wall.", 20, 0);
    const result = attributeColorBlock(block, null, KNOWN_NAMES, rawContent);
    expect(result.entityName).toBe("Melina");
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });

  test("paragraph focal character: unnamed prose in character's paragraph", () => {
    const block = makeBlock("#D8BFD8", "The swordswoman's jaw tightened. She could feel the wrongness.", 0, 4);
    const focal = { name: "Melina", confidence: 0.7 };
    const result = attributeColorBlock(block, null, KNOWN_NAMES, "", focal);
    expect(result.entityName).toBe("Melina");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("first-person pronouns attributed to message owner", () => {
    const block = makeBlock("#E6E6FA", '"I need to know if anything\'s still active."', 0, 0);
    const result = attributeColorBlock(block, "Melina", KNOWN_NAMES);
    expect(result.entityName).toBe("Melina");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe("attributeColorBlock — multi-character awareness", () => {
  test("message owner fallback has lower confidence in multi-char content", () => {
    const block = makeBlock("#D8BFD8", "The air shimmered with ancient power, casting long shadows.", 0, 0);
    // Multi-character = true → fallback confidence should be lower
    const result = attributeColorBlock(block, "Melina", KNOWN_NAMES, "", null, true);
    expect(result.confidence).toBeLessThanOrEqual(0.4);
  });

  test("message owner fallback has normal confidence in single-char content", () => {
    const block = makeBlock("#D8BFD8", "The air shimmered with ancient power, casting long shadows.", 0, 0);
    const result = attributeColorBlock(block, "Melina", KNOWN_NAMES, "", null, false);
    expect(result.confidence).toBe(0.5);
  });
});

describe("full narrative attribution — worst case scenario", () => {
  // This test processes the entire 8-paragraph narrative simulating the
  // full pipeline: primary attribution → intra-paragraph propagation →
  // cross-paragraph color consistency. Tests against 4 characters.

  test("all blocks in the worst-case narrative are correctly attributed", () => {
    const blocks = extractColorBlocks(WORST_CASE_NARRATIVE);

    // Expected attributions by hex color
    const EXPECTED: Record<string, string> = {
      "#e6e6fa": "Melina",  // Melina speech
      "#d8bfd8": "Melina",  // Melina narration/thought
      "#87ceeb": "Kael",    // Kael speech
      "#4682b4": "Kael",    // Kael narration/thought
      "#98fb98": "Seraphine", // Seraphine speech
      "#3cb371": "Seraphine", // Seraphine narration/thought
      "#ffd700": "Voss",    // Voss speech
      "#daa520": "Voss",    // Voss narration/thought
    };

    // ── Simulate the full processChunkFontColors pipeline ──

    // Phase 0: Context
    const multiChar = true;
    const messageOwner = "Melina";

    // Phase 1: Paragraph focal characters
    const paragraphs = WORST_CASE_NARRATIVE.split(/\n\s*\n/);
    const focalByParagraph = new Map<number, { name: string; confidence: number }>();
    for (let i = 0; i < paragraphs.length; i++) {
      const focal = detectParagraphFocalCharacter(paragraphs[i], KNOWN_NAMES);
      if (focal) focalByParagraph.set(i, focal);
    }

    // Phase 2: Primary attribution
    type BlockResult = {
      block: ExtractedColorBlock;
      entityName: string | null;
      confidence: number;
    };
    const blockResults: BlockResult[] = [];

    for (const block of blocks) {
      const focal = focalByParagraph.get(block.paragraphIndex) || null;
      const attr = attributeColorBlock(block, messageOwner, KNOWN_NAMES, WORST_CASE_NARRATIVE, focal, multiChar);
      blockResults.push({
        block,
        entityName: attr.entityName,
        confidence: attr.confidence,
      });
    }

    // Phase 3a: Cross-paragraph color consistency (runs FIRST)
    // Established color→character mappings override weak fallbacks
    const colorToEntity = new Map<string, { entityName: string; confidence: number }>();
    for (const r of blockResults) {
      if (!r.entityName || r.confidence < 0.6) continue;
      const existing = colorToEntity.get(r.block.hexColor);
      if (!existing || r.confidence > existing.confidence) {
        colorToEntity.set(r.block.hexColor, { entityName: r.entityName, confidence: r.confidence });
      }
    }
    for (const r of blockResults) {
      if (r.entityName && r.confidence >= 0.6) continue;
      const established = colorToEntity.get(r.block.hexColor);
      if (established && (!r.entityName || established.confidence > r.confidence)) {
        r.entityName = established.entityName;
        r.confidence = Math.min(established.confidence - 0.1, 0.7);
      }
    }

    // Phase 3b: Intra-paragraph propagation
    for (let i = 0; i < blockResults.length; i++) {
      const result = blockResults[i];
      if (result.entityName && result.confidence >= 0.6) continue;

      const paragraphIdx = result.block.paragraphIndex;
      let bestNeighbor: { entityName: string; confidence: number } | null = null;

      for (let j = 0; j < blockResults.length; j++) {
        if (j === i) continue;
        const neighbor = blockResults[j];
        if (neighbor.block.paragraphIndex !== paragraphIdx) continue;
        if (!neighbor.entityName || neighbor.confidence < 0.65) continue;

        const sameColor = neighbor.block.hexColor === result.block.hexColor;
        const effectiveConf = sameColor ? neighbor.confidence : neighbor.confidence - 0.1;
        if (!bestNeighbor || effectiveConf > bestNeighbor.confidence) {
          bestNeighbor = { entityName: neighbor.entityName, confidence: effectiveConf };
        }
      }

      if (bestNeighbor && (!result.entityName || bestNeighbor.confidence > result.confidence)) {
        result.entityName = bestNeighbor.entityName;
        result.confidence = Math.min(bestNeighbor.confidence, 0.75);
      }
    }

    // ── Score and report ──
    const results: Array<{
      paragraph: number;
      hex: string;
      expected: string;
      got: string | null;
      confidence: number;
      snippet: string;
    }> = [];

    let totalCorrect = 0;
    let totalBlocks = 0;

    for (const r of blockResults) {
      const expected = EXPECTED[r.block.hexColor] || "unknown";
      const correct = r.entityName === expected;
      if (correct) totalCorrect++;
      totalBlocks++;

      results.push({
        paragraph: r.block.paragraphIndex,
        hex: r.block.hexColor,
        expected,
        got: r.entityName,
        confidence: r.confidence,
        snippet: r.block.content.slice(0, 60),
      });
    }

    console.log("\n═══ WORST-CASE NARRATIVE ATTRIBUTION RESULTS ═══");
    console.log(`Score: ${totalCorrect}/${totalBlocks} (${((totalCorrect / totalBlocks) * 100).toFixed(1)}%)\n`);

    for (const r of results) {
      const status = r.got === r.expected ? "OK" : "MISS";
      const conf = r.confidence.toFixed(2);
      console.log(
        `  [${status}] P${r.paragraph} ${r.hex} → ${r.got || "NULL"} (expected ${r.expected}, conf=${conf})`,
      );
      if (status === "MISS") {
        console.log(`         "${r.snippet}..."`);
      }
    }
    console.log("");

    // Target: at least 90% correct in worst-case multi-character narrative
    const accuracy = totalCorrect / totalBlocks;
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });
});

describe("edge cases", () => {
  test("empty content returns no blocks", () => {
    const blocks = extractColorBlocks("");
    expect(blocks).toHaveLength(0);
  });

  test("content with no font tags returns no blocks", () => {
    const blocks = extractColorBlocks("Just plain text with no colors.");
    expect(blocks).toHaveLength(0);
  });

  test("span style colors are extracted", () => {
    const content = '<span style="color: #ff0000">Red text</span>';
    const blocks = extractColorBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hexColor).toBe("#ff0000");
  });

  test("named colors are normalized", () => {
    const content = '<font color="crimson">Blood red</font>';
    const blocks = extractColorBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hexColor).toBe("#dc143c");
  });

  test("short hex colors (#abc) are expanded", () => {
    const content = "<font color=#abc>Short hex</font>";
    const blocks = extractColorBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hexColor).toBe("#aabbcc");
  });

  test("block with only short text does not trigger message owner fallback", () => {
    const block = makeBlock("#abc123", "Hi.", 0, 0);
    const result = attributeColorBlock(block, "Melina", KNOWN_NAMES);
    // "Hi." is only 3 chars, below the 10-char threshold
    expect(result.entityName).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe("processChunkFontColors", () => {
  test("tracks configured thought and speech colors for all 4 characters", () => {
    const chatId = "chat-font-colors";
    const entityIdByName = new Map<string, string>();
    const entityNameById = new Map<string, string>();
    const db = getDb();

    for (const name of KNOWN_NAMES) {
      const id = `entity-${name.toLowerCase()}`;
      entityIdByName.set(name.toLowerCase(), id);
      entityNameById.set(id, name);
      db.query("INSERT INTO memory_entities (id, chat_id, name) VALUES (?, ?, ?)").run(id, chatId, name);
    }

    processChunkFontColors(
      chatId,
      THOUGHT_AND_SPEECH_NARRATIVE,
      KNOWN_NAMES,
      entityIdByName,
      THOUGHT_DELIMITERS,
    );

    const mappings = getColorMap(chatId);
    expect(mappings.length).toBeGreaterThanOrEqual(8);

    const byEntity = new Map<string, Set<string>>();
    for (const mapping of mappings) {
      const name = mapping.entityId ? entityNameById.get(mapping.entityId) : undefined;
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byEntity.has(key)) byEntity.set(key, new Set());
      byEntity.get(key)!.add(mapping.usageType);
    }

    for (const name of KNOWN_NAMES) {
      const usageTypes = byEntity.get(name.toLowerCase()) || new Set<string>();
      expect(usageTypes.has("speech")).toBe(true);
      expect(usageTypes.has("thought")).toBe(true);
    }

    const prompt = formatColorMapForPrompt(chatId);
    expect(prompt).toContain("**Melina:**");
    expect(prompt).toContain("- Speech: #e6e6fa");
    expect(prompt).toContain("- Thoughts: #c8a2c8");
    expect(prompt).toContain("**Kael:**");
    expect(prompt).toContain("- Speech: #87ceeb");
    expect(prompt).toContain("- Thoughts: #5f9ea0");
    expect(prompt).toContain("**Seraphine:**");
    expect(prompt).toContain("- Speech: #98fb98");
    expect(prompt).toContain("- Thoughts: #90ee90");
    expect(prompt).toContain("**Voss:**");
    expect(prompt).toContain("- Speech: #ffd700");
    expect(prompt).toContain("- Thoughts: #f0e68c");
  });

  test("tracks asterisk-wrapped thought colors", () => {
    const chatId = "chat-asterisk-thoughts";
    const db = getDb();
    const melinaId = "entity-melina";
    const entityIdByName = new Map([["melina", melinaId]]);

    db.query("INSERT INTO memory_entities (id, chat_id, name) VALUES (?, ?, ?)").run(melinaId, chatId, "Melina");

    const content = '[CHARACTER | Melina]\n<font color=#C8A2C8>*I cannot let them see me hesitate.*</font> <font color=#E6E6FA>"Stay behind me,"</font> <font color=#D8BFD8>Melina said, drawing steel.</font>';

    processChunkFontColors(chatId, content, ["Melina"], entityIdByName);
    processChunkFontColors(chatId, content, ["Melina"], entityIdByName);

    const prompt = formatColorMapForPrompt(chatId);
    expect(prompt).toContain("**Melina:**");
    expect(prompt).toContain("- Thoughts: #c8a2c8");
    expect(prompt).toContain("- Speech: #e6e6fa");
  });
});
