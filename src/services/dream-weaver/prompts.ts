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
      "description": "who they are and why they matter",
      "scenario": "how they intersect with the soul draft"
    }
  ]
}

## Scope Rules
- Generate only lorebooks and npc_definitions.
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
    "Generate lorebooks and npc_definitions for the current Soul draft. Preserve continuity with the Soul draft and avoid duplicating the character card fields.",
  );

  return sections.join("\n\n");
}
