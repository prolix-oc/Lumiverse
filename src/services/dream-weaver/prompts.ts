// Dream Weaver Prompts

import type { DreamWeaverSession, DW_DRAFT_V1 } from "../../types/dream-weaver";

const BANNED_NAMES = [
  "Elara", "Alaric", "Kaelen", "Seraphina", "Thorne", "Lyra", "Zephyr",
  "Aria", "Cassian", "Rowan", "Ember", "Asher", "Luna", "Orion",
  "Raven", "Phoenix", "Sage", "Willow", "Jasper", "Ivy", "Silas",
  "Aurora", "Draven", "Celeste", "Kieran", "Nyx", "Soren", "Vesper",
  "Caspian", "Elowen", "Finnian", "Isolde", "Lucian", "Mira", "Rhys",
  "Astrid", "Dorian", "Freya", "Gideon", "Hazel", "Iris", "Jace",
  "Kira", "Leif", "Nova", "Ophelia", "Quinn", "Rune", "Stella"
];

const ANTI_SLOP_RULES = `## Quality Standards

Before generating, ask yourself:
- Is this name something a real person would have, or does it sound like AI slop?
- Are these descriptions specific and grounded, or generic fantasy clichés?
- Does this personality show real behavioral patterns, or just vague traits?
- Does the first message start with actual character action, or just scene-setting?

Common AI slop patterns to avoid:
- Fantasy names that sound "mystical" but meaningless: ${BANNED_NAMES.slice(0, 20).join(", ")}, etc.
- Overused descriptors: "orbs" for eyes, "cascade" for hair, "alabaster" skin
- Personality clichés: "cold exterior hiding warm heart", "mysterious past"
- Empty openings: weather descriptions with no character presence

Write like a skilled human author would: specific, grounded, with real behavioral texture.`;


const APPEARANCE_TEMPLATE = `**Body measurements:**
- **Height:** <value or N/A>
- **Cup size:** <value or N/A>
- **Bust circumference:** <value or N/A>
- **Band (underbust) circumference:** <value or N/A>
- **Waist circumference:** <value or N/A>
- **Hip circumference:** <value or N/A>
- **Thigh circumference:** <value or N/A>
- **Shoe/feet size:** <value or N/A>
**Birthday:** <value or N/A>
**Species:** <value>
**Skin tone:** <value>
**Hair:** <value>
**Eyes:** <value>

### Description and Background
<detailed lore>`;

export const DREAM_WEAVER_SYSTEM_PROMPT = `You are Dream Weaver, a character package authoring system.

${ANTI_SLOP_RULES}

## Output Format

Return ONLY valid JSON. No markdown, no explanations.

{
  "format": "DW_DRAFT_V1",
  "version": 1,
  "kind": "character" | "scenario",
  "meta": {
    "title": "string",
    "summary": "1-2 sentences",
    "tags": ["array"],
    "content_rating": "sfw" | "nsfw"
  },
  "card": {
    "name": "string",
    "appearance": "string",
    "appearance_data": {},
    "description": "string",
    "personality": "string",
    "scenario": "string",
    "first_mes": "string",
    "system_prompt": "string",
    "post_history_instructions": "string"
  },
  "voice_guidance": {
    "compiled": "how character speaks",
    "rules": {
      "baseline": ["speech patterns"],
      "rhythm": ["pacing"],
      "diction": ["word choice"],
      "quirks": ["verbal tics"],
      "hard_nos": ["never says/does"]
    }
  },
  "alternate_fields": {
    "description": [{"id": "alt1", "label": "Name", "content": "text"}],
    "personality": [{"id": "alt1", "label": "Name", "content": "text"}],
    "scenario": [{"id": "alt1", "label": "Name", "content": "text"}]
  },
  "greetings": [
    {"id": "g1", "label": "Main", "content": "text"},
    {"id": "g2", "label": "Alt", "content": "text"}
  ],
  "lorebooks": [],
  "npc_definitions": [],
  "regex_scripts": []
}

## Card Type
- Person described → "character"
- Place/situation → "scenario"

## Appearance
Character: Use this format:
${APPEARANCE_TEMPLATE}

Scenario: Leave blank ""

## Fields
**description**: Dense, sectional. Identity, background, context.
**personality**: Behavioral patterns, habits, contradictions.
**scenario**: Current situation, tension, relationship to {{user}}.
**first_mes**: Begin with action/dialogue. 3-5 paragraphs.
**voice_guidance**: HOW they speak, not examples.
**alternates**: 2-3 meaningful variants (not cosmetic).
**greetings**: 2-3 different entry points.

## Package Boundary Rules
- Generate the core card package only.
- leave \`lorebooks\` and \`npc_definitions\` as empty arrays during the initial dream weave.
- World content is generated later by the dedicated World flow.
- Leave \`regex_scripts\` as an empty array unless the dream explicitly asks for bundled regex behavior.

Generate now.`;

export const REWRITE_SYSTEM_PROMPT = `Rewrite the section based on user feedback.

Return ONLY the rewritten content as plain text, not JSON.`;

export const WORLD_GENERATION_SYSTEM_PROMPT = `You are Dream Weaver's World Builder module.

${ANTI_SLOP_RULES}

## Output Format

Return ONLY valid JSON. No markdown, no explanations.

{
  "lorebooks": [
    {
      "id": "uuid",
      "name": "World Book Name",
      "entries": [
        { "id": "uuid", "keywords": ["keyword1"], "content": "world detail" }
      ]
    }
  ],
  "npc_definitions": [
    {
      "id": "uuid",
      "name": "NPC Name",
      "role": "short role label",
      "description": "who they are — background, motivations, what makes them distinct",
      "appearance": "physical appearance, clothing, distinguishing features",
      "personality": "behavioral patterns, habits, quirks — how they act, not just adjectives",
      "voice": "how they speak — cadence, diction, verbal tics, speech patterns",
      "relationship_to_card": "their specific dynamic with the main character",
      "keyword_triggers": ["keyword1", "keyword2"],
      "importance": "major" | "minor"
    }
  ],
  "regex_scripts": [
    {
      "id": "uuid",
      "name": "Script Name",
      "description": "What this script does",
      "find_regex": "regex pattern",
      "replace_string": "replacement text",
      "flags": "gi",
      "target": "response"
    }
  ]
}

## NPC Depth Guidelines
- Every NPC must have ALL fields filled out. Do not leave any field empty.
- **description**: Go beyond role summaries. Include backstory, goals, and what drives them.
- **appearance**: Concrete physical details — build, coloring, clothing style, notable features.
- **personality**: Specific behavioral patterns, not generic traits. How do they react under pressure? What are their habits?
- **voice**: How they actually talk — sentence length, formality, slang, verbal tics, accent markers if any.
- **relationship_to_card**: The specific dynamic, not just "ally" or "rival". What's the history? What tension exists?
- **keyword_triggers**: 2-4 terms that would naturally appear in conversation about or with this NPC.
- **importance**: "major" for recurring/pivotal NPCs, "minor" for atmospheric/supporting cast.

## Regex Script Guidelines
Regex scripts transform AI-generated text to enforce character voice and setting consistency.
Generate scripts that are useful for the character's unique traits, for example:
- **Accent/dialect patterns**: r->w for speech impediments, dropping g's from "-ing" words, etc.
- **Action formatting**: wrapping actions in asterisks, italicizing environmental descriptions
- **Term substitution**: replacing modern words with setting-appropriate vocabulary
- **Speech quirks**: adding verbal tics, stuttering patterns, or catchphrases
Only generate regex_scripts when the character has distinctive speech patterns, dialect, or setting-specific language that benefits from automated text transformation. If the character speaks normally, return an empty array.
- **target**: "response" for AI output, "prompt" for user input processing, "display" for visual display changes
- **flags**: usually "gi" (global, case-insensitive). Use "g" if case matters.
- Keep patterns precise — avoid overly broad regex that could corrupt normal text.

## Scope Rules
- Generate only lorebooks, npc_definitions, and regex_scripts.
- Do not return card fields.
- Do not return alternate_fields.
- Do not return greetings.
- Ground the world package in the current Soul draft first and the dream text second.
`;

export function buildWorldGenerationPrompt(
  session: Pick<DreamWeaverSession, "dream_text" | "tone" | "constraints" | "dislikes">,
  draft: Pick<DW_DRAFT_V1, "meta" | "card" | "voice_guidance">,
): string {
  const sections = [
    "## Dream Context",
    session.dream_text,
    "## Soul Context",
    [
      `Name: ${draft.card.name}`,
      `Summary: ${draft.meta?.summary ?? ""}`,
      `Description: ${draft.card.description}`,
      `Personality: ${draft.card.personality}`,
      `Scenario: ${draft.card.scenario}`,
      `Appearance: ${draft.card.appearance}`,
      `Voice Guidance: ${draft.voice_guidance?.compiled ?? ""}`,
    ].join("\n"),
  ];

  if (session.tone) {
    sections.push("## Tone", session.tone);
  }

  if (session.constraints) {
    sections.push("## Constraints", session.constraints);
  }

  if (session.dislikes) {
    sections.push("## Hard No's", session.dislikes);
  }

  sections.push(
    "## Requested Output",
    "Generate lorebooks, npc_definitions, and regex_scripts for the current Soul draft. Preserve continuity with the Soul draft and avoid duplicating the character card fields. Only include regex_scripts if the character has distinctive speech patterns or setting-specific language worth automating.",
  );

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Extend (additive generation)
// ---------------------------------------------------------------------------

export type ExtendTarget =
  | "greetings"
  | "alternate_fields.description"
  | "alternate_fields.personality"
  | "alternate_fields.scenario"
  | "lorebook_entries"
  | "npc_definitions";

export const EXTEND_SYSTEM_PROMPT = `You are Dream Weaver's Extension module. You generate additional entries for an existing character package. Your output is ADDITIVE — it extends the current draft without replacing or duplicating anything already present.

${ANTI_SLOP_RULES}

Return ONLY valid JSON. No markdown, no code fences, no explanations.

CRITICAL: Your entire response must be a single, complete, parseable JSON object. Do NOT let any string value exceed ~300 words — keep entries focused and dense rather than sprawling. Ensure every opened brace, bracket, and quote is properly closed.`;

function summarizeExistingGreetings(draft: DW_DRAFT_V1): string {
  if (!draft.greetings?.length) return "None yet.";
  return draft.greetings
    .map((g, i) => `${i + 1}. "${g.label}": ${g.content.slice(0, 150)}${g.content.length > 150 ? "..." : ""}`)
    .join("\n");
}

function summarizeExistingAlternates(
  draft: DW_DRAFT_V1,
  fieldType: string,
): string {
  const alts = (draft.alternate_fields as Record<string, Array<{ label: string; content: string }>>)[fieldType];
  if (!alts?.length) return "None yet.";
  return alts
    .map((a, i) => `${i + 1}. "${a.label}": ${a.content.slice(0, 150)}${a.content.length > 150 ? "..." : ""}`)
    .join("\n");
}

function summarizeExistingLorebooks(draft: DW_DRAFT_V1): string {
  if (!draft.lorebooks?.length) return "None yet.";
  return draft.lorebooks
    .map((book: any) => {
      const entryCount = book.entries?.length ?? 0;
      const keywords = (book.entries || [])
        .flatMap((e: any) => e.keywords || [])
        .slice(0, 12);
      return `- "${book.name}" (${entryCount} entries, keywords: ${keywords.join(", ")})`;
    })
    .join("\n");
}

function summarizeExistingNpcs(draft: DW_DRAFT_V1): string {
  if (!draft.npc_definitions?.length) return "None yet.";
  return draft.npc_definitions
    .map((npc: any) => {
      const parts = [`- "${npc.name}" (${npc.role || "no role"}, ${npc.importance || "minor"})`];
      if (npc.description) parts.push(`  Description: ${npc.description.slice(0, 100)}${npc.description.length > 100 ? "..." : ""}`);
      if (npc.relationship_to_card) parts.push(`  Relationship: ${npc.relationship_to_card.slice(0, 80)}${npc.relationship_to_card.length > 80 ? "..." : ""}`);
      return parts.join("\n");
    })
    .join("\n");
}

function buildCharacterContext(draft: DW_DRAFT_V1): string {
  return [
    `Name: ${draft.card.name}`,
    `Kind: ${draft.kind}`,
    `Description: ${draft.card.description.slice(0, 400)}`,
    `Personality: ${draft.card.personality.slice(0, 400)}`,
    `Scenario: ${draft.card.scenario.slice(0, 400)}`,
    `Voice: ${draft.voice_guidance?.compiled?.slice(0, 250) ?? ""}`,
  ].join("\n");
}

export function buildExtendPrompt(
  draft: DW_DRAFT_V1,
  target: ExtendTarget,
  count: number,
  instruction?: string,
  bookId?: string,
): string {
  const sections: string[] = [
    "## Character Context",
    buildCharacterContext(draft),
  ];

  if (instruction?.trim()) {
    sections.push("## User Instruction", instruction.trim());
  }

  switch (target) {
    case "greetings":
      sections.push(
        "## Existing Greetings",
        summarizeExistingGreetings(draft),
        "## Task",
        `Generate ${count} new greeting(s). Each greeting must be a distinct entry point — different mood, setting, or situation. Do NOT duplicate existing greetings. Each greeting should begin with action or dialogue, 3-5 paragraphs.`,
        "## Output Format",
        `{ "greetings": [{ "id": "unique-string", "label": "Short label", "content": "Full greeting text" }] }`,
      );
      break;

    case "alternate_fields.description":
    case "alternate_fields.personality":
    case "alternate_fields.scenario": {
      const fieldType = target.split(".")[1];
      sections.push(
        `## Base ${fieldType}`,
        (draft.card[fieldType as keyof typeof draft.card] as string | undefined)?.slice(0, 600) || "(empty)",
        `## Existing ${fieldType} Alternates`,
        summarizeExistingAlternates(draft, fieldType),
        "## Task",
        `Generate ${count} new alternate(s) for the "${fieldType}" field. Each alternate must present a meaningfully different angle — not cosmetic rewording. Do NOT duplicate existing alternates.`,
        "## Output Format",
        `{ "alternates": [{ "id": "unique-string", "label": "Short descriptive label", "content": "Full alternate content" }] }`,
      );
      break;
    }

    case "lorebook_entries": {
      if (bookId) {
        // Per-book mode: generate additional entries for a specific existing book
        const book = draft.lorebooks.find((b: any) => b.id === bookId);
        const bookName = book?.name ?? "the world book";
        const existingEntries: string = book?.entries?.length
          ? (book.entries as any[])
              .map((e: any) => `- [${(e.keywords ?? []).join(", ")}]: ${String(e.content ?? "").slice(0, 120)}`)
              .join("\n")
          : "(none yet)";
        sections.push(
          `## Target World Book: "${bookName}"`,
          "## Existing Entries in This Book",
          existingEntries,
          "## All World Books (for context)",
          summarizeExistingLorebooks(draft),
          "## Task",
          `Generate ${count} new entr${count === 1 ? "y" : "ies"} for the "${bookName}" world book. Each entry must cover a distinct aspect not already present in the existing entries above. Use tight keyword triggers and dense, lore-rich content.`,
          "## Output Format",
          `{ "entries": [{ "id": "unique-string", "keywords": ["keyword1", "keyword2"], "content": "World detail" }] }`,
        );
      } else {
        sections.push(
          "## Existing World Books",
          summarizeExistingLorebooks(draft),
          "## Task",
          `Generate ${count} new world book(s) with entries. Cover new aspects of the world not already present. Each book should have a clear theme and 3-5 entries with keyword triggers.`,
          "## Output Format",
          `{ "lorebooks": [{ "id": "unique-string", "name": "Book Name", "entries": [{ "id": "unique-string", "keywords": ["keyword1", "keyword2"], "content": "World detail" }] }] }`,
        );
      }
      break;
    }

    case "npc_definitions":
      sections.push(
        "## Existing NPCs",
        summarizeExistingNpcs(draft),
        "## Task",
        `Generate ${count} new NPC definition(s). Each NPC must fill a different narrative role and have a clear relationship to ${draft.card.name}. Do NOT duplicate existing NPCs. Every field must be filled — no empty strings.`,
        "## Output Format",
        [
          `{ "npc_definitions": [{`,
          `  "id": "unique-string",`,
          `  "name": "NPC Name",`,
          `  "role": "short role label",`,
          `  "description": "backstory, motivations, what makes them distinct",`,
          `  "appearance": "physical appearance, clothing, distinguishing features",`,
          `  "personality": "behavioral patterns, habits, quirks",`,
          `  "voice": "speech patterns, cadence, diction, verbal tics",`,
          `  "relationship_to_card": "specific dynamic with ${draft.card.name}",`,
          `  "keyword_triggers": ["trigger1", "trigger2"],`,
          `  "importance": "major" | "minor"`,
          `}] }`,
        ].join("\n"),
      );
      break;
  }

  sections.push("Generate now.");
  return sections.join("\n\n");
}
