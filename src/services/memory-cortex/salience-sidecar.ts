/**
 * Memory Cortex — Sidecar-enhanced salience scoring.
 *
 * Uses a sidecar LLM connection to perform deep narrative analysis:
 * importance scoring, emotional tagging, entity extraction, relationship
 * inference, and status change detection — all in a single structured call.
 *
 * This is Tier 2 functionality: opt-in, async, never blocks generation.
 */

import type { SidecarExtractionResult, SidecarFontColor, DiscoveredAlias, EmotionalTag, NarrativeFlag, StatusChange, ExtractedEntity, ExtractedRelationship, SidecarGradedHeuristics } from "./types";
import { scoreChunkHeuristic } from "./salience-heuristic";

// ─── Tool-Based Structured Extraction ──────────────────────────
// Native tool/function calling — every provider supports this natively.
// Each extraction aspect is a separate tool. The LLM calls ALL tools.
// Results come back as tool_calls with guaranteed JSON args.

import type { ToolDefinition } from "../../llm/types";
import { isPlausibleAlias, sanitizeAlias } from "./alias-validation";

// ─── Entity Blocklist ──────────────────────────────────────────
// Meta-references that LLMs hallucinate as entities. Filtered in post-processing.

const ENTITY_BLOCKLIST = new Set([
  "user", "you", "your", "ai", "ai character", "ai assistant", "player", "human",
  "narrator", "character", "assistant", "system", "bot", "ooc", "gm",
  "roleplay", "rp", "npc", "game master", "dungeon master",
  "the user", "the player", "the narrator", "the character",
  "the ai", "the assistant", "the system", "the human",
  "i", "me", "my", "myself", "we", "us", "they", "them",
]);

// ─── System Prompt ─────────────────────────────────────────────

const EXTRACTION_ENGINE_INTRO = `You are a deterministic extraction engine for a roleplay memory system.`;

// Shared evidence rules. Both the single-passage tool prompt and the batch
// JSON prompt append their own first line, so this stays mode neutral.
const EXTRACTION_GLOBAL_RULES = `GLOBAL RULES
- Use ONLY evidence from the exact passage.
- Do NOT use genre knowledge, outside world knowledge, or likely guesses.
- Do NOT invent names, relationships, motives, symbolism, themes, or implications.
- If a detail is ambiguous, weakly implied, or unsupported, omit it.
- Prefer omission over contamination. Missing data is acceptable; wrong data is harmful.`;

// Entity, alias, relationship, scoring and font color rules, shared verbatim by
// both extraction paths so behavior stays identical regardless of batching.
const EXTRACTION_RULES = `ENTITY RULES
An entity is a proper name for a SPECIFIC, RECURRING character, place, item, faction, event, or named concept the story will refer back to. Throwaway descriptive labels, running gags, and one-off riffs are NOT entities, even when title-cased.

Do NOT extract any of the following, regardless of capitalization:
- Common words capitalized only because of sentence-start, formatting, or emphasis (including ALL-CAPS shouting).
- Verbs, adjectives, adverbs, interjections, or sentence fragments.
- Onomatopoeia and non-word vocalizations — clusters that represent a sound rather than name a thing or person.
- Verb phrases (a transitive verb followed by its object), even when title-cased — these describe an action, not a recurring named entity.
- Compound descriptive phrases whose HEAD word is a common English noun and the remainder is generic — these are running labels or jokes (modifier + common-noun head + optional generic given name), not separate entities. If you mentally remove the head common noun and the result is still a recognizable canonical name, treat the whole phrase as a nickname/alias of that canonical, not a new entity.
- Common-noun objects even when title-cased, unless the passage explicitly elevates them with a proper title (e.g. naming a specific weapon, vessel, or artifact).
- External real-world games, brands, apps, platforms, social networks, or trademarks, unless the story's setting itself IS that thing.
- Meta-references used by every roleplay system: User, You, AI, Player, Narrator, Character, Assistant, System, Bot, Human, NPC, OOC.
- Pronouns and pronoun-only references.
- Tracker/header scaffolding such as timestamps, weather labels, status readouts, HUD labels, emoji wrappers, or repeated metadata blocks (unless they contain a real proper name that recurs outside the scaffold).

Prefer "no entity" over "wrong entity". When in doubt, omit.

KNOWN ENTITY RULE
When known entities are supplied with aliases, ALWAYS use the canonical name in output, never the alias. For truly new entities, use the exact proper name from the passage.

CANONICAL ALIAS RULE
When a <canonical_aliases> block is present in the user message, treat it as authoritative — it comes from character/persona definitions, not heuristic guessing.
- If the passage uses an alias from the left side, emit the canonical name on the right side everywhere (extract_entities, extract_relationships, status_changes, color_attributions).
- Never emit an entity whose name is one of the aliases on the left side.
- In arbiter mode, any heuristic candidate matching a left-side alias MUST appear in transformed_heuristic_entities mapping the alias to its canonical name.

ALIAS RULE
A nickname, diminutive, affectionate variant, descriptive riff, or shortened/extended form of a known character's name is an ALIAS, not a new entity. Report it via discovered_aliases pointing at the canonical name; do NOT also create a separate entity for it.

Sufficient evidence for a discovered_alias is ANY ONE of:
- Explicit declaration patterns: "call me X", "known as X", "X, nicknamed Y", "X (Y)".
- A short form clearly derived from a known canonical (shares its root, initial syllables, or stem) used to refer to that character in context.
- A compound nickname that CONTAINS a recognizable diminutive or part of a known canonical's name. Modifiers, adjectives, jokes, or descriptors prefixed/appended onto a recognizable shortened form do NOT create a new entity — the whole phrase is one alias of the canonical character.
- A first-name-only or last-name-only reference that unambiguously resolves to a known full-name canonical in the chat.
- Possessive or addressed forms ("my X", "hey X", "X's …") where the recipient is unambiguously a known character.

When you detect an alias:
1. Do NOT include the alias as its own entry in entities_present.
2. DO include it in discovered_aliases with canonical_name = the known canonical, alias = the surface form, and brief evidence from the passage.
3. In arbiter mode:
   - If the alias appears in heuristic_entities, emit it in transformed_heuristic_entities (from = alias, to = canonical).
   - If it appears in batch_existing_entities, emit it in rejected_existing_entities so the bad standalone entry gets cleaned up.

Do NOT report aliases on superficial similarity alone (no shared substring, no shared role, no addressing, no clear in-passage referent). When unsure, omit.

RELATIONSHIP RULES
- Both source and target must be proper names present in the passage.
- Only record a relationship when the passage directly supports an enduring or role-like connection, or explicitly states the relationship.
- Do NOT create a relationship just because two named entities appear in the same scene, speak once, stand near each other, or are mentioned together.
- Do NOT infer hidden history, likely alliances, family ties, or romance unless the passage itself supports it.
- If the passage shows only a transient interaction with no stable relationship signal, return no relationship for that pair.

SCORING RULES
- Importance is about lasting narrative consequence, not prose intensity.
- Score high for durable changes: deaths, betrayals, discoveries, promises, arrivals, departures, confessions, transformations, status shifts, major gains/losses.
- Score low for filler, routine banter, scene dressing, repeated habits, or atmospheric prose with no lasting consequence.
- key_facts must be concrete, verifiable statements traceable to the passage. Prefer durable developments over filler.
- Do NOT put impressions, themes, personality judgments, or unsupported interpretations in key_facts.

FONT COLOR RULES
- Only report colors that are actually present in HTML color tags in the passage.
- Map each color to the named character directly supported by the passage.
- If the owner of a color is unclear, omit that attribution instead of guessing.`;

const EXTRACTION_SYSTEM_PROMPT = `${EXTRACTION_ENGINE_INTRO}

Convert ONE passage into structured data by calling ALL FOUR tools exactly once.
Return empty arrays when a tool has nothing to report.

${EXTRACTION_GLOBAL_RULES}
- Treat each tool independently. A relationship or fact must be supported by the passage itself.

TOOL CHECKLIST
1. score_salience
2. extract_entities
3. extract_relationships
4. extract_font_colors

${EXTRACTION_RULES}`;

// Arbiter mode: passage analysis PLUS a verdict on heuristic / existing-graph candidates.
const ARBITER_EXTRACTION_SYSTEM_PROMPT = `${EXTRACTION_ENGINE_INTRO}

Convert ONE passage into structured data AND judge the candidate records supplied
by the caller. Call ALL FIVE tools exactly once. Return empty arrays when a tool
has nothing to report.

${EXTRACTION_GLOBAL_RULES}
- Treat each tool independently. A relationship or fact must be supported by the passage itself.
- For grade_heuristic_candidates: judge ONLY the candidates listed in the user message. Do not invent new ones to reject. Confirm by omission — silence means the candidate is acceptable.
  - Reject a heuristic candidate when it falls into any category from the ENTITY RULES "Do NOT extract" list, or when it isn't actually present in the passage.
  - Transform a heuristic candidate when it refers to a real known entity but uses a different surface form (alias, diminutive, partial name, or sentence-start capitalization). Pair the alias-rule outcomes with transform entries here.
- For rejected_existing_entities: flag a pre-existing graph entity whenever it falls into any category from the ENTITY RULES "Do NOT extract" list, OR when it is an alias of a known canonical character that should never have been persisted as a standalone entity. Importance disagreement alone is NOT grounds for rejection — only structural / categorical mistakes are.

TOOL CHECKLIST
1. score_salience
2. extract_entities
3. extract_relationships
4. extract_font_colors
5. grade_heuristic_candidates

${EXTRACTION_RULES}`;

// ─── Tool Definitions ──────────────────────────────────────────

const TOOL_SALIENCE: ToolDefinition = {
  name: "score_salience",
  description: "Score lasting narrative consequence only. Return factual emotional_tones, narrative_flags, and key_facts that are directly supported by the passage. Use empty arrays for anything absent.",
  parameters: {
    type: "object",
    properties: {
      importance: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        description: "Narrative importance based on lasting consequences. 0=mundane filler, 2=routine interaction, 4=notable but forgettable, 6=significant development, 8=major plot point, 10=story-defining moment (death, betrayal, transformation)",
      },
      emotional_tones: {
        type: "array",
        items: { type: "string", enum: ["grief", "joy", "tension", "dread", "intimacy", "betrayal", "revelation", "resolve", "humor", "melancholy", "awe", "fury"] },
        description: "Up to 3 emotional tones clearly expressed in the passage. Do not tag tone based only on dramatic writing style.",
      },
      narrative_flags: {
        type: "array",
        items: { type: "string", enum: ["first_meeting", "death", "promise", "confession", "departure", "transformation", "battle", "discovery", "reunion", "loss"] },
        description: "Story events that explicitly occur in this passage. Empty array if none.",
      },
      key_facts: {
        type: "array",
        items: { type: "string" },
        description: "Concrete, verifiable facts from the passage. Prefer durable developments over filler. Good: 'Melina promised to return', 'The sword was broken', 'They arrived at Dustwell'. Bad: 'The mood was intense', 'Kael seemed suspicious'. Empty array if nothing durable happened.",
      },
    },
    required: ["importance", "emotional_tones", "narrative_flags", "key_facts"],
  },
};

const TOOL_ENTITIES: ToolDefinition = {
  name: "extract_entities",
  description: "Extract only proper-name entities that appear in the passage. Reject capitalized common words, pronouns, meta references, and formatting noise. Use canonical known names when provided. Return empty arrays when nothing qualifies.",
  parameters: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The entity's proper name exactly as it appears in the text." },
            type: {
              type: "string",
              enum: ["character", "location", "item", "faction", "event", "concept"],
              description: "character=named person/creature, location=named place/address, item=named object/weapon/vehicle, faction=named group/org, event=named historical occurrence, concept=named doctrine/prophecy. Use concept rarely; prefer more concrete types when supported.",
            },
            role: {
              type: "string",
              enum: ["subject", "object", "present", "referenced"],
              description: "subject=acts in scene, object=acted upon, present=in scene but passive, referenced=mentioned but absent.",
            },
          },
          required: ["name", "type"],
        },
        description: "Proper-name entities found in the passage. Empty array if none.",
      },
      discovered_aliases: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonical_name: { type: "string", description: "The known/full/primary name of the entity (must match a known entity or be the longer form)." },
            alias: { type: "string", description: "The nickname, shortened name, title, or alternate form discovered in this passage." },
            evidence: { type: "string", description: "Required brief quote or context showing the alias connection, e.g. 'Call me Mel'. Do not report an alias without explicit evidence." },
          },
          required: ["canonical_name", "alias", "evidence"],
        },
        description: "Aliases only when the passage explicitly reveals that two names refer to the same entity. Empty array if none.",
      },
      status_changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Proper name of the entity whose status changed." },
            change: {
              type: "string",
              enum: ["injured", "healed", "died", "transformed", "betrayed", "allied", "departed", "arrived"],
              description: "What explicitly happened to this entity in the passage.",
            },
            detail: { type: "string", description: "Brief factual description of the change, not interpretation." },
          },
          required: ["entity", "change"],
        },
        description: "Status changes that explicitly occurred in this passage. Empty array if none.",
      },
    },
    required: ["entities", "discovered_aliases", "status_changes"],
  },
};

const TOOL_RELATIONSHIPS: ToolDefinition = {
  name: "extract_relationships",
  description: "Extract only directly supported relationships between named entities in the passage. Do not infer relationships from co-presence alone. Return an empty array if no stable or explicit relationship is supported.",
  parameters: {
    type: "object",
    properties: {
      relationships: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string", description: "Proper name of the first entity (must appear in passage)." },
            target: { type: "string", description: "Proper name of the second entity (must appear in passage)." },
            type: {
              type: "string",
              enum: ["ally", "enemy", "lover", "parent", "child", "sibling", "mentor", "rival", "owns", "member_of", "located_in", "fears", "serves", "custom"],
              description: "The relationship directly supported by the passage. Use custom when the connection is explicit but does not fit another enum.",
            },
            label: { type: "string", description: "Short factual descriptor, e.g. 'childhood friends', 'captain of', 'sworn enemies'. Do not use poetic language." },
            sentiment: { type: "number", minimum: -1, maximum: 1, description: "Emotional valence of the relationship as shown in the passage: -1.0 hostile, 0 neutral/unclear, 1.0 warm." },
          },
          required: ["source", "target", "type"],
        },
        description: "Relationships directly supported by the passage. Empty array if none.",
      },
    },
    required: ["relationships"],
  },
};

const TOOL_FONT_COLORS: ToolDefinition = {
  name: "extract_font_colors",
  description: "Map HTML color tags to named characters only when the passage supports the attribution. Return an empty array if no color tags are present or the owner is unclear.",
  parameters: {
    type: "object",
    properties: {
      color_attributions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            hex_color: { type: "string", description: "The hex color value, e.g. '#ff9999' or '#E6E6FA'." },
            character_name: { type: "string", description: "Canonical proper name of the character who uses this color." },
            usage_type: {
              type: "string",
              enum: ["speech", "thought", "narration"],
              description: "speech=quoted dialogue, thought=internal/italic text, narration=descriptive text.",
            },
          },
          required: ["hex_color", "character_name", "usage_type"],
        },
        description: "Color-to-character mappings found in the passage. Empty array if none.",
      },
    },
    required: ["color_attributions"],
  },
};

const TOOL_GRADE_HEURISTIC_CANDIDATES: ToolDefinition = {
  name: "grade_heuristic_candidates",
  description: "Judge the candidate records supplied in the user message against the passage. Reject candidates that are not real proper-name entities or are not actually supported by the passage. Be especially aggressive about rejecting common English words that are only capitalized due to sentence position, dialogue formatting, or emphasis — these are the most frequent false positives. Transform candidates that refer to a real entity but use the wrong form. Confirmation is by omission — silence means the candidate is acceptable. Use empty arrays when nothing needs flagging.",
  parameters: {
    type: "object",
    properties: {
      rejected_heuristic_entities: {
        type: "array",
        items: { type: "string" },
        description: "Exact names from the heuristic_entities candidate list that should NOT be persisted. Reject: verbs, adjectives, adverbs, abstract nouns (Beauty, Darkness, Silence, Power, Magic, Chaos, Destiny, Fate, Honor, Vengeance, Shadow, Truth, Nothing), common English words only capitalized because of sentence position or shouted dialogue or emphasis formatting, meta-references, and names not actually present in the passage. Examples: 'Beautiful' (adjective), 'Darkness' (abstract noun), 'Important' (adjective), 'Ancient' (adjective), 'Suddenly' (adverb), 'Nothing' (pronoun), 'Perhaps' (adverb). Match the candidate name verbatim.",
      },
      transformed_heuristic_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "The candidate name verbatim from the heuristic_entities list." },
            to: { type: "string", description: "The canonical proper name this candidate actually refers to." },
          },
          required: ["from", "to"],
        },
        description: "Candidates that refer to a real entity but use the wrong name. Example: heuristic captured 'Marlowe' but the passage establishes 'Detective Marlowe' — transform from='Marlowe' to='Detective Marlowe'. Only use when the canonical form is supported by the passage.",
      },
      rejected_heuristic_relationships: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string" },
            target: { type: "string" },
            type: { type: "string" },
          },
          required: ["source", "target", "type"],
        },
        description: "Exact triples from the heuristic_relationships list that are NOT supported by the passage (co-occurrence without a real connection, contradicted by the text, or involving rejected entities). Match source/target/type verbatim.",
      },
      rejected_existing_entities: {
        type: "array",
        items: { type: "string" },
        description: "Names from the existing_graph_entities list that are not real proper-name entities (verbs, adjectives, abstract nouns like Darkness/Beauty/Power/Shadow/Silence/Chaos, adverbs, pronouns, sentence fragments, meta-references that were incorrectly persisted in a prior chunk). Be conservative — only reject obvious mistakes, not entities you simply find unimportant.",
      },
    },
    required: [
      "rejected_heuristic_entities",
      "transformed_heuristic_entities",
      "rejected_heuristic_relationships",
      "rejected_existing_entities",
    ],
  },
};

const EXTRACTION_TOOLS: ToolDefinition[] = [TOOL_SALIENCE, TOOL_ENTITIES, TOOL_RELATIONSHIPS, TOOL_FONT_COLORS];
const ARBITER_EXTRACTION_TOOLS: ToolDefinition[] = [...EXTRACTION_TOOLS, TOOL_GRADE_HEURISTIC_CANDIDATES];

/**
 * Build the tool-forcing parameters for each provider.
 * Anthropic: tool_choice { type: "any" } — must use at least one tool
 * OpenAI/compat: tool_choice "required" — must use tools
 * Google: toolConfig { functionCallingConfig: { mode: "ANY" } }
 */
const GOOGLE_PROVIDERS = new Set(["google", "google_vertex"]);

export function getToolChoiceParams(provider: string): Record<string, any> {
  if (GOOGLE_PROVIDERS.has(provider)) {
    return { toolConfig: { functionCallingConfig: { mode: "ANY" } } };
  }
  // Anthropic accepts tool_choice at body level; OpenAI/compat also accept it
  // Both use different formats but the passthrough sends it as-is
  if (provider === "anthropic") {
    return { tool_choice: { type: "any" } };
  }
  // OpenAI and compatibles
  return { tool_choice: "required" };
}

/**
 * Parse tool call results from a generation response into our extraction format.
 * Applies blocklist filtering to reject meta-entity hallucinations.
 */
export function parseToolCallResults(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
): SidecarExtractionResult {
  let importance = 5;
  let emotionalTags: string[] = [];
  let narrativeFlags: string[] = [];
  let keyFacts: string[] = [];
  let entities: Array<{ name: string; type: string; role?: string }> = [];
  let statusChanges: Array<{ entity: string; change: string; detail: string }> = [];
  let relationships: Array<{ source: string; target: string; type: string; label: string; sentiment: number }> = [];
  let fontColors: SidecarFontColor[] = [];
  let discoveredAliases: DiscoveredAlias[] = [];
  let gradedHeuristics: SidecarGradedHeuristics | undefined;

  for (const call of toolCalls) {
    const args = call.args as any;
    switch (call.name) {
      case "score_salience":
        importance = typeof args.importance === "number" ? args.importance : 5;
        emotionalTags = validateEmotionalTags(args.emotional_tones);
        narrativeFlags = validateNarrativeFlags(args.narrative_flags);
        keyFacts = validateKeyFacts(args.key_facts);
        break;
      case "extract_entities":
        entities = validateEntities(args.entities);
        statusChanges = validateStatusChanges(args.status_changes);
        discoveredAliases = validateDiscoveredAliases(args.discovered_aliases);
        break;
      case "extract_relationships":
        relationships = validateRelationships(args.relationships);
        break;
      case "extract_font_colors":
        fontColors = validateFontColors(args.color_attributions);
        break;
      case "grade_heuristic_candidates":
        gradedHeuristics = validateGradedHeuristics(args);
        break;
    }
  }

  // Post-processing: filter blocklisted meta-entities that slipped through
  entities = entities.filter((e) => !ENTITY_BLOCKLIST.has(e.name.toLowerCase().trim()));
  relationships = relationships.filter(
    (r) => !ENTITY_BLOCKLIST.has(r.source.toLowerCase().trim()) && !ENTITY_BLOCKLIST.has(r.target.toLowerCase().trim()),
  );
  statusChanges = statusChanges.filter((s) => !ENTITY_BLOCKLIST.has(s.entity.toLowerCase().trim()));
  // Filter blocklisted names from discovered aliases
  discoveredAliases = discoveredAliases.filter(
    (a) => !ENTITY_BLOCKLIST.has(a.canonicalName.toLowerCase().trim()) && !ENTITY_BLOCKLIST.has(a.alias.toLowerCase().trim()),
  );

  return {
    score: Math.max(0, Math.min(1, importance / 10)),
    emotionalTags: emotionalTags as any[],
    narrativeFlags: narrativeFlags as any[],
    statusChanges,
    keyFacts,
    entitiesPresent: entities as any[],
    relationshipsShown: relationships as any[],
    fontColors,
    discoveredAliases,
    gradedHeuristics,
  };
}

/** Get the extraction tools array (for passing to generate calls) */
export function getExtractionTools(): ToolDefinition[] {
  return EXTRACTION_TOOLS;
}

function validateGradedHeuristics(args: any): SidecarGradedHeuristics {
  const rejectedEntities = Array.isArray(args?.rejected_heuristic_entities)
    ? args.rejected_heuristic_entities.filter((s: any) => typeof s === "string" && s.trim().length > 0).map((s: string) => s.trim())
    : [];
  const transformed = Array.isArray(args?.transformed_heuristic_entities)
    ? args.transformed_heuristic_entities
        .filter((t: any) => t && typeof t.from === "string" && typeof t.to === "string"
          && t.from.trim().length > 0 && t.to.trim().length > 0
          && t.from.trim().toLowerCase() !== t.to.trim().toLowerCase())
        .map((t: any) => ({ from: t.from.trim(), to: t.to.trim() }))
    : [];
  const rejectedRels = Array.isArray(args?.rejected_heuristic_relationships)
    ? args.rejected_heuristic_relationships
        .filter((r: any) => r && typeof r.source === "string" && typeof r.target === "string" && typeof r.type === "string")
        .map((r: any) => ({ source: r.source.trim(), target: r.target.trim(), type: r.type.trim() }))
    : [];
  const rejectedExisting = Array.isArray(args?.rejected_existing_entities)
    ? args.rejected_existing_entities.filter((s: any) => typeof s === "string" && s.trim().length > 0).map((s: string) => s.trim())
    : [];

  return {
    rejectedHeuristicEntities: rejectedEntities,
    transformedHeuristicEntities: transformed,
    rejectedHeuristicRelationships: rejectedRels,
    rejectedExistingEntities: rejectedExisting,
  };
}

// Legacy export kept for compatibility — now returns empty (tools handle everything)
export function getExtractionStructuredParams(_provider: string, _batch: boolean): Record<string, any> {
  return {};
}

// ─── Adapter Type ──────────────────────────────────────────────

export type SidecarGenerateFn = (opts: {
  connectionId: string;
  messages: Array<{ role: string; content: string }>;
  parameters: Record<string, any>;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}) => Promise<{
  content: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}>;

// ─── Alias Resolution ─────────────────────────────────────────
// Post-processes sidecar results to map nicknames/aliases back to canonical names.
// This is a safety net — the prompt instructs the LLM to use canonical names,
// but models don't always follow instructions.

function resolveAliasesInResult(
  result: SidecarExtractionResult,
  knownEntities: Array<{ name: string; type: string; aliases: string[] }>,
): SidecarExtractionResult {
  // Build alias → canonical name lookup
  const aliasMap = new Map<string, string>();
  for (const e of knownEntities) {
    aliasMap.set(e.name.toLowerCase(), e.name);
    for (const alias of e.aliases) {
      aliasMap.set(alias.toLowerCase(), e.name);
    }
  }

  // Also incorporate newly discovered aliases from THIS extraction —
  // so relationships using a brand-new nickname resolve to the canonical entity
  // even before the alias is persisted to the database.
  for (const da of result.discoveredAliases) {
    const canonicalResolved = aliasMap.get(da.canonicalName.toLowerCase()) || da.canonicalName;
    if (da.alias && !aliasMap.has(da.alias.toLowerCase())) {
      aliasMap.set(da.alias.toLowerCase(), canonicalResolved);
    }
  }

  const resolve = (name: string) => aliasMap.get(name.toLowerCase()) || name;

  // Resolve entity names and deduplicate (merge alias variants into canonical form)
  const seenEntities = new Map<string, (typeof result.entitiesPresent)[0]>();
  for (const entity of result.entitiesPresent) {
    const resolved = resolve(entity.name);
    const key = resolved.toLowerCase();
    if (!seenEntities.has(key)) {
      seenEntities.set(key, { ...entity, name: resolved });
    }
    // If duplicate, keep the one with the more specific role (subject > present)
    else if (entity.role === "subject") {
      seenEntities.set(key, { ...entity, name: resolved });
    }
  }

  // Resolve relationship endpoints and filter self-references
  const seenRelations = new Set<string>();
  const relationships = result.relationshipsShown
    .map((r) => ({ ...r, source: resolve(r.source), target: resolve(r.target) }))
    .filter((r) => {
      // Drop self-referencing relationships (same entity after alias resolution)
      if (r.source.toLowerCase() === r.target.toLowerCase()) return false;
      // Deduplicate same pair+type
      const key = `${r.source.toLowerCase()}→${r.target.toLowerCase()}:${r.type}`;
      if (seenRelations.has(key)) return false;
      seenRelations.add(key);
      return true;
    });

  // Resolve status changes and font colors
  const statusChanges = result.statusChanges.map((s) => ({ ...s, entity: resolve(s.entity) }));
  const fontColors = result.fontColors.map((fc) => ({ ...fc, characterName: resolve(fc.characterName) }));

  // Resolve discovered aliases — map canonical names through alias resolution too
  const discoveredAliases = result.discoveredAliases.map((a) => ({
    ...a,
    canonicalName: resolve(a.canonicalName),
  })).filter((a) => a.canonicalName.toLowerCase() !== a.alias.toLowerCase());

  return {
    ...result,
    entitiesPresent: [...seenEntities.values()],
    relationshipsShown: relationships,
    statusChanges,
    fontColors,
    discoveredAliases,
  };
}

// ─── Extraction ────────────────────────────────────────────────

// Known entity/character hint block shared by single and batch prompts.
function buildEntityHint(options?: {
  characterNames?: string[];
  knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
}): string {
  if (options?.knownEntities?.length) {
    const lines = options.knownEntities
      .slice(0, 50) // Cap to avoid prompt bloat
      .map((e) => {
        const aliasStr = e.aliases.length > 0 ? ` (aka ${e.aliases.join(", ")})` : "";
        return `- ${e.name} [${e.type}]${aliasStr}`;
      });
    return `\n\n<known_entities>\nUse these canonical names when they match the passage. Never output an alias when a canonical name is listed here.\n${lines.join("\n")}\n</known_entities>`;
  }
  if (options?.characterNames?.length) {
    return `\n\n<known_characters>\n${options.characterNames.join(", ")}\n</known_characters>\nUse these names exactly if they appear.`;
  }
  return "";
}

// Validate a parsed JSON extraction object into a SidecarExtractionResult.
function buildResultFromJsonObject(
  json: any,
  options?: {
    characterNames?: string[];
    knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
  },
): SidecarExtractionResult {
  const entities = validateEntities(json.entities_present).filter(
    (e) => !ENTITY_BLOCKLIST.has(e.name.toLowerCase().trim()),
  );
  const relationships = validateRelationships(json.relationships_shown).filter(
    (r) =>
      !ENTITY_BLOCKLIST.has(r.source.toLowerCase().trim()) &&
      !ENTITY_BLOCKLIST.has(r.target.toLowerCase().trim()),
  );

  let result: SidecarExtractionResult = {
    score: Math.max(0, Math.min(1, (json.importance ?? 5) / 10)),
    emotionalTags: validateEmotionalTags(json.emotional_tones),
    narrativeFlags: validateNarrativeFlags(json.narrative_flags),
    statusChanges: validateStatusChanges(json.status_changes),
    keyFacts: validateKeyFacts(json.key_facts),
    entitiesPresent: entities,
    relationshipsShown: relationships,
    fontColors: validateFontColors(json.color_attributions),
    discoveredAliases: validateDiscoveredAliases(json.discovered_aliases),
    gradedHeuristics: json.grading ? validateGradedHeuristics(json.grading) : undefined,
  };
  if (options?.knownEntities?.length) {
    result = resolveAliasesInResult(result, options.knownEntities);
  }
  return result;
}

/**
 * Run sidecar-enhanced extraction on a chunk of narrative text.
 * Uses tool calling for structured output — every provider supports this natively.
 *
 * @param content - The passage text (may include font tags for color extraction)
 * @param generateRawFn - Sidecar LLM call function
 * @param sidecarConnectionId - Connection profile ID
 * @param options - Character names and/or full entity context with aliases
 */
export async function extractWithSidecar(
  content: string,
  generateRawFn: SidecarGenerateFn,
  sidecarConnectionId: string,
  options?: {
    characterNames?: string[];
    knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
    /** When provided, the sidecar is asked to judge these candidates and grading
     *  is returned in the result's gradedHeuristics field. */
    arbiter?: {
      heuristicEntities: Array<{ name: string; type: string }>;
      heuristicRelationships: Array<{ source: string; target: string; type: string }>;
      existingGraphEntities: string[];
    };
    /** Sampling parameters forwarded to the underlying LLM call. Caller is
     *  responsible for passing the user-configured sidecar temperature/top_p/
     *  max_tokens here. Defaults to a low-temperature extraction profile when
     *  omitted. */
    samplingParameters?: Record<string, unknown>;
    /** alias → canonical name mappings sourced from character / persona /
     *  world-book descriptions. Rendered as a <canonical_aliases> block in the
     *  prompt so the sidecar can resolve unpersisted aliases (e.g. "D" →
     *  "Darran" when only the persona description establishes it) without
     *  needing the canonical entity to already exist in the graph. */
    descriptionAliases?: Array<{ alias: string; canonicalName: string }>;
    /** Synchronous token counter for the user-prompt content. Used only for
     *  diagnostic logging; falls back to char/4 estimation when omitted. */
    tokenCounter?: (text: string) => number;
    /** Logging label for "where this request came from" (e.g. "live",
     *  "rebuild:batch-12"). Appears in dispatch/response log lines. */
    logTag?: string;
    /** Throw on failure instead of returning null. Required for retry callers
     *  that need to distinguish a real error (timeout, network, malformed
     *  response) from a successful "the passage had nothing to extract" result. */
    throwOnFailure?: boolean;
    signal?: AbortSignal;
  },
): Promise<SidecarExtractionResult | null> {
  const arbiter = options?.arbiter;
  const arbiterActive = !!arbiter
    && (arbiter.heuristicEntities.length > 0
      || arbiter.heuristicRelationships.length > 0
      || arbiter.existingGraphEntities.length > 0);

  try {
    // Build entity context for the prompt — prefer full entities with aliases over bare names
    const entityHint = buildEntityHint(options);
    const arbiterBlock = arbiterActive ? buildArbiterBlock(arbiter!) : "";

    const tools = arbiterActive ? ARBITER_EXTRACTION_TOOLS : EXTRACTION_TOOLS;
    const systemPrompt = arbiterActive ? ARBITER_EXTRACTION_SYSTEM_PROMPT : EXTRACTION_SYSTEM_PROMPT;
    const toolListing = arbiterActive
      ? "score_salience, extract_entities, extract_relationships, extract_font_colors, and grade_heuristic_candidates"
      : "score_salience, extract_entities, extract_relationships, and extract_font_colors";

    const aliasBlock = buildAliasReconciliationBlock(options?.descriptionAliases);
    const userContent = `Analyze the exact roleplay passage below. Call ${toolListing} exactly once each. Use only the text below as evidence. Use empty arrays when nothing qualifies.${entityHint}${aliasBlock}${arbiterBlock}\n\n<passage>\n${content}\n</passage>`;
    const tag = options?.logTag ?? "single";
    logSidecarDispatch(tag, {
      chunks: 1,
      arbiter: arbiterActive,
      userContent,
      connectionId: sidecarConnectionId,
      tokenCounter: options?.tokenCounter,
    });
    const sentAt = Date.now();

    const response = await generateRawFn({
      connectionId: sidecarConnectionId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      parameters: options?.samplingParameters ?? { temperature: 0.1 },
      tools,
      signal: options?.signal,
    });
    logSidecarResponse(tag, { ms: Date.now() - sentAt, hasToolCalls: !!response.tool_calls?.length });

    // Tool calls: parse structured results from tool_calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      let result = parseToolCallResults(response.tool_calls);
      // Resolve any remaining aliases to canonical names (safety net if LLM used alias)
      if (options?.knownEntities?.length) {
        result = resolveAliasesInResult(result, options.knownEntities);
      }
      return result;
    }

    // Fallback: try parsing the text content as JSON (some providers inline it)
    const json = extractJson(response.content);
    if (!json) {
      if (options?.throwOnFailure) {
        throw new Error("sidecar response had no tool_calls and no parseable JSON");
      }
      return null;
    }

    return buildResultFromJsonObject(json, options);
  } catch (err) {
    if (options?.throwOnFailure) throw err;
    console.warn("[memory-cortex] Sidecar extraction failed, falling back to heuristic:", err);
    return null;
  }
}

function buildAliasReconciliationBlock(
  aliases: Array<{ alias: string; canonicalName: string }> | undefined,
): string {
  if (!aliases || aliases.length === 0) return "";
  // De-dupe by alias; cap at 100 entries to keep prompts bounded.
  const seen = new Map<string, string>();
  for (const { alias, canonicalName } of aliases) {
    const a = (alias ?? "").trim();
    const c = (canonicalName ?? "").trim();
    if (!a || !c || a.toLowerCase() === c.toLowerCase()) continue;
    const key = a.toLowerCase();
    if (!seen.has(key)) seen.set(key, c);
  }
  if (seen.size === 0) return "";
  const lines = [...seen.entries()]
    .slice(0, 100)
    .map(([alias, canonical]) => `- ${alias} → ${canonical}`)
    .join("\n");
  return `\n\n<canonical_aliases>
Persona, character, and world-book definitions establish these alias→canonical name mappings. They take priority over guesses:
- When the passage uses an alias on the left, use the canonical name on the right in your output (extract_entities, extract_relationships, status_changes, font color attributions).
- Never emit an entity whose name is one of these aliases. The canonical name is always the correct identifier.
- In arbiter mode, if a heuristic candidate's name is one of these aliases, you MUST emit a transformed_heuristic_entities entry mapping from the alias to the canonical name.
${lines}
</canonical_aliases>`;
}

function buildArbiterBlock(arbiter: NonNullable<Parameters<typeof extractWithSidecar>[3]>["arbiter"]): string {
  if (!arbiter) return "";
  const sections: string[] = [];
  if (arbiter.heuristicEntities.length > 0) {
    const lines = arbiter.heuristicEntities.slice(0, 60).map((e) => `- ${e.name} [${e.type}]`).join("\n");
    sections.push(`<heuristic_entities>\n${lines}\n</heuristic_entities>`);
  }
  if (arbiter.heuristicRelationships.length > 0) {
    const lines = arbiter.heuristicRelationships.slice(0, 60).map((r) => `- ${r.source} —[${r.type}]→ ${r.target}`).join("\n");
    sections.push(`<heuristic_relationships>\n${lines}\n</heuristic_relationships>`);
  }
  if (arbiter.existingGraphEntities.length > 0) {
    const lines = arbiter.existingGraphEntities.slice(0, 100).map((n) => `- ${n}`).join("\n");
    sections.push(`<existing_graph_entities>\n${lines}\n</existing_graph_entities>`);
  }
  if (sections.length === 0) return "";
  return `\n\nGRADE THESE CANDIDATES via grade_heuristic_candidates:\n${sections.join("\n\n")}`;
}

/**
 * Score a chunk with sidecar, falling back to heuristic on failure.
 */
export async function scoreChunkWithSidecar(
  content: string,
  generateRawFn: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
  }) => Promise<{ content: string }>,
  sidecarConnectionId: string,
): Promise<SidecarExtractionResult> {
  const result = await extractWithSidecar(content, generateRawFn, sidecarConnectionId);
  if (result) return result;

  // Fallback to heuristic
  const heuristic = scoreChunkHeuristic(content);
  return {
    score: heuristic.score,
    emotionalTags: heuristic.emotionalTags,
    narrativeFlags: heuristic.narrativeFlags,
    statusChanges: heuristic.statusChanges,
    keyFacts: [],
    entitiesPresent: [],
    relationshipsShown: [],
    fontColors: [],
    discoveredAliases: [],
  };
}

const BATCH_EXTRACTION_SYSTEM_PROMPT = `${EXTRACTION_ENGINE_INTRO}

You will receive several roleplay passages, each wrapped in <passage index="N"> tags.
Analyze EACH passage independently and convert it into structured data.

OUTPUT FORMAT
Return ONLY a single JSON object, no prose, no markdown fences, no commentary:
{"results":[{"index":<the passage's index>,"importance":<integer 0-10>,"emotional_tones":[],"narrative_flags":[],"key_facts":[],"entities_present":[{"name":"","type":"character|location|item|faction|event|concept","role":"subject|object|present|referenced"}],"relationships_shown":[{"source":"","target":"","type":"ally|enemy|lover|parent|child|sibling|mentor|rival|owns|member_of|located_in|fears|serves|custom","label":"","sentiment":0}],"status_changes":[{"entity":"","change":"injured|healed|died|transformed|betrayed|allied|departed|arrived","detail":""}],"color_attributions":[{"hex_color":"#rrggbb","character_name":"","usage_type":"speech|thought|narration"}],"discovered_aliases":[{"canonical_name":"","alias":"","evidence":""}]}]}
- Emit exactly one results entry per passage, with "index" equal to that passage's index attribute.
- Use empty arrays for any field with nothing to report.

${EXTRACTION_GLOBAL_RULES}
- Score and extract each passage in isolation. Do NOT carry information between passages.

${EXTRACTION_RULES}`;

// Arbiter variant of the batch system prompt: each passage may include
// candidate records to grade. The output gains a "grading" field per result.
const BATCH_ARBITER_SYSTEM_PROMPT = `${EXTRACTION_ENGINE_INTRO}

You will receive several roleplay passages, each wrapped in <passage index="N"> tags.
Some passages are followed by an <arbiter index="N"> block listing candidate
records to judge. Analyze EACH passage independently AND, when its arbiter
block is present, grade those candidates.

OUTPUT FORMAT
Return ONLY a single JSON object, no prose, no markdown fences, no commentary:
{"results":[{"index":<the passage's index>,"importance":<integer 0-10>,"emotional_tones":[],"narrative_flags":[],"key_facts":[],"entities_present":[{"name":"","type":"character|location|item|faction|event|concept","role":"subject|object|present|referenced"}],"relationships_shown":[{"source":"","target":"","type":"ally|enemy|lover|parent|child|sibling|mentor|rival|owns|member_of|located_in|fears|serves|custom","label":"","sentiment":0}],"status_changes":[{"entity":"","change":"injured|healed|died|transformed|betrayed|allied|departed|arrived","detail":""}],"color_attributions":[{"hex_color":"#rrggbb","character_name":"","usage_type":"speech|thought|narration"}],"discovered_aliases":[{"canonical_name":"","alias":"","evidence":""}],"grading":{"rejected_heuristic_entities":[],"transformed_heuristic_entities":[{"from":"","to":""}],"rejected_heuristic_relationships":[{"source":"","target":"","type":""}],"rejected_existing_entities":[]}}]}
- Emit exactly one results entry per passage, with "index" equal to that passage's index attribute.
- Use empty arrays for any field with nothing to report.
- Include "grading" ONLY for passages that had an <arbiter> block. For other passages, omit the grading field entirely.

${EXTRACTION_GLOBAL_RULES}
- Score and extract each passage in isolation. Do NOT carry information between passages.
- For grading: judge ONLY the heuristic candidates listed in that passage's <arbiter> block. Confirmation is by omission — silence means the candidate is acceptable.
  - Reject a heuristic candidate when it falls into any category from the ENTITY RULES "Do NOT extract" list, or when it isn't actually present in that passage.
  - Transform a heuristic candidate when it refers to a real known entity but uses a different surface form (alias, diminutive, partial name, sentence-start capitalization).
- For rejected_existing_entities: judge entries from the single batch-level <batch_existing_entities> list (NOT a per-passage list). Flag entries whenever they fall into any category from the ENTITY RULES "Do NOT extract" list, OR when they are aliases of a known canonical character that should never have been persisted as standalone entries. Importance disagreement alone is NOT grounds for rejection.

${EXTRACTION_RULES}`;

// Extract all passages in one LLM request. Results align with input order.
// Passages the batch drops are retried one by one. A whole batch failure
// falls back to per chunk extraction.
/** Per-chunk arbiter input for the batched path. Position-parallel to chunks.
 *  existingGraphEntities is intentionally NOT here — it's the same list across
 *  every chunk in a batch, so it's passed once via batchExistingEntities to
 *  avoid 5x prompt-token duplication. */
export interface BatchArbiterChunk {
  heuristicEntities: Array<{ name: string; type: string }>;
  heuristicRelationships: Array<{ source: string; target: string; type: string }>;
}

export async function extractBatchWithSidecar(
  chunks: Array<{ index: number; content: string }>,
  generateRawFn: SidecarGenerateFn,
  sidecarConnectionId: string,
  options?: {
    characterNames?: string[];
    knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
    /** Position-parallel to `chunks`. Entries may be null when a chunk has
     *  nothing to grade. When any entry is non-null with content, the batch
     *  uses the arbiter system prompt and embeds per-passage <arbiter> blocks. */
    perChunkArbiter?: Array<BatchArbiterChunk | null>;
    /** Names of entities already in the chat's graph that the sidecar may flag
     *  via rejected_existing_entities. Rendered once at batch level (not per
     *  passage) to avoid duplicating the same list 5x in the prompt. Subject
     *  to the same conservative grading rules. */
    batchExistingEntities?: string[];
    /** alias → canonical name mappings from character/persona/world-book
     *  descriptions. Rendered once at batch level (applies to every passage). */
    descriptionAliases?: Array<{ alias: string; canonicalName: string }>;
    /** Sampling parameters forwarded to the underlying LLM call. */
    samplingParameters?: Record<string, unknown>;
    /** Synchronous token counter for diagnostic logging. */
    tokenCounter?: (text: string) => number;
    /** Logging label, e.g. "rebuild:batch-12". */
    logTag?: string;
  },
): Promise<Array<SidecarExtractionResult | null>> {
  if (chunks.length === 0) return [];
  // Flatten batch-level existing entities into each per-chunk arbiter input
  // when the single-chunk extractor is used (it doesn't have a batch level).
  const singleChunkArbiterFor = (i: number): NonNullable<Parameters<typeof extractWithSidecar>[3]>["arbiter"] | undefined => {
    const a = options?.perChunkArbiter?.[i];
    const existing = options?.batchExistingEntities ?? [];
    if (!a && existing.length === 0) return undefined;
    return {
      heuristicEntities: a?.heuristicEntities ?? [],
      heuristicRelationships: a?.heuristicRelationships ?? [],
      existingGraphEntities: existing,
    };
  };

  // One chunk does not benefit from batching.
  if (chunks.length === 1) {
    return [
      await extractWithSidecar(chunks[0].content, generateRawFn, sidecarConnectionId, {
        ...options,
        arbiter: singleChunkArbiterFor(0),
      }).catch(() => null),
    ];
  }

  const perChunkFallback = (idxs: number[]) =>
    Promise.all(
      idxs.map((i) =>
        extractWithSidecar(chunks[i].content, generateRawFn, sidecarConnectionId, {
          ...options,
          arbiter: singleChunkArbiterFor(i),
        }).catch(() => null),
      ),
    );

  const arbiterActiveByIndex = (options?.perChunkArbiter ?? []).map(
    (a) => !!a && (a.heuristicEntities.length > 0 || a.heuristicRelationships.length > 0),
  );
  const batchExistingActive = (options?.batchExistingEntities ?? []).length > 0;
  const anyArbiterActive = arbiterActiveByIndex.some(Boolean) || batchExistingActive;

  try {
    const entityHint = buildEntityHint(options);
    // Array position is the prompt index so results map back positionally.
    const passages = chunks
      .map((c, i) => {
        const passage = `<passage index="${i}">\n${c.content}\n</passage>`;
        if (!arbiterActiveByIndex[i]) return passage;
        const arbiter = options!.perChunkArbiter![i]!;
        const sections: string[] = [];
        if (arbiter.heuristicEntities.length > 0) {
          const lines = arbiter.heuristicEntities.slice(0, 40).map((e) => `- ${e.name} [${e.type}]`).join("\n");
          sections.push(`<heuristic_entities>\n${lines}\n</heuristic_entities>`);
        }
        if (arbiter.heuristicRelationships.length > 0) {
          const lines = arbiter.heuristicRelationships.slice(0, 40).map((r) => `- ${r.source} —[${r.type}]→ ${r.target}`).join("\n");
          sections.push(`<heuristic_relationships>\n${lines}\n</heuristic_relationships>`);
        }
        const arbiterBlock = `<arbiter index="${i}">\n${sections.join("\n")}\n</arbiter>`;
        return `${passage}\n${arbiterBlock}`;
      })
      .join("\n\n");

    // Existing graph entities are batch-level: the same list applies to every
    // passage, so we render it once instead of duplicating it per chunk.
    const batchExisting = options?.batchExistingEntities ?? [];
    const batchExistingBlock = batchExisting.length > 0
      ? `\n\n<batch_existing_entities>\n${batchExisting.slice(0, 60).map((n) => `- ${n}`).join("\n")}\n</batch_existing_entities>`
      : "";

    const systemPrompt = anyArbiterActive ? BATCH_ARBITER_SYSTEM_PROMPT : BATCH_EXTRACTION_SYSTEM_PROMPT;
    const arbiterInstruction = anyArbiterActive
      ? " Where an <arbiter> block follows a passage, also populate that passage's grading field per the system prompt. The <batch_existing_entities> list (if present) applies to every passage; flag entries via rejected_existing_entities only when they are clearly not real proper-name entities."
      : "";

    const aliasBlock = buildAliasReconciliationBlock(options?.descriptionAliases);
    const userContent = `Analyze each roleplay passage below independently. Return the JSON object described in the system prompt with exactly one results entry per passage. Use only the text inside each passage as evidence.${arbiterInstruction}${entityHint}${aliasBlock}${batchExistingBlock}\n\n${passages}`;
    const tag = options?.logTag ?? "batch";
    logSidecarDispatch(tag, {
      chunks: chunks.length,
      arbiter: anyArbiterActive,
      userContent,
      connectionId: sidecarConnectionId,
      tokenCounter: options?.tokenCounter,
      batchExistingCount: (options?.batchExistingEntities ?? []).length,
    });
    const sentAt = Date.now();

    const response = await generateRawFn({
      connectionId: sidecarConnectionId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      parameters: options?.samplingParameters ?? { temperature: 0.1 },
    });
    const responseMs = Date.now() - sentAt;

    const parsed = extractJsonArray(response.content);
    const byIndex = new Map<number, any>();
    if (parsed) {
      for (const item of parsed) {
        if (item && typeof item.index === "number") byIndex.set(item.index, item);
      }
    }

    const results: Array<SidecarExtractionResult | null> = new Array(chunks.length).fill(null);
    const missing: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const obj = byIndex.get(i);
      if (obj) {
        results[i] = buildResultFromJsonObject(obj, options);
      } else {
        missing.push(i);
      }
    }
    logSidecarResponse(tag, {
      ms: responseMs,
      hasToolCalls: false,
      parsed: chunks.length - missing.length,
      missing: missing.length,
    });

    // Retry passages the batch response dropped.
    if (missing.length > 0) {
      console.warn(`[memory-cortex] ${tag}: ${missing.length}/${chunks.length} passage(s) missing from batch response; retrying as per-chunk extraction`);
      const recovered = await perChunkFallback(missing);
      missing.forEach((idx, k) => {
        results[idx] = recovered[k];
      });
    }

    return results;
  } catch (err: any) {
    console.warn(`[memory-cortex] ${options?.logTag ?? "batch"} failed (${err?.name ?? "Error"}: ${err?.message ?? err}); falling back to per-chunk extraction`);
    return perChunkFallback(chunks.map((_, i) => i));
  }
}

// ─── Diagnostic logging ─────────────────────────────────────────

function logSidecarDispatch(
  tag: string,
  opts: {
    chunks: number;
    arbiter: boolean;
    userContent: string;
    connectionId: string;
    tokenCounter?: (text: string) => number;
    batchExistingCount?: number;
  },
): void {
  const chars = opts.userContent.length;
  // Prefer real tokenizer when supplied; fall back to char/4 estimate. The
  // estimate is rough but better than silence — and matches what the rest of
  // the system uses when no model-specific tokenizer is available.
  const tokens = opts.tokenCounter ? opts.tokenCounter(opts.userContent) : Math.ceil(chars / 4);
  const parts = [
    `[memory-cortex] ${tag} → connection=${opts.connectionId}`,
    `chunks=${opts.chunks}`,
    `tokens≈${tokens}`,
    `chars=${chars}`,
    opts.arbiter ? "arbiter=on" : "arbiter=off",
  ];
  if (opts.batchExistingCount && opts.batchExistingCount > 0) {
    parts.push(`existing=${opts.batchExistingCount}`);
  }
  console.info(parts.join(" "));
}

function logSidecarResponse(
  tag: string,
  opts: { ms: number; hasToolCalls: boolean; parsed?: number; missing?: number },
): void {
  const parts = [
    `[memory-cortex] ${tag} ← ${opts.ms}ms`,
    opts.hasToolCalls ? "tool_calls=yes" : (opts.parsed !== undefined ? `parsed=${opts.parsed}/${opts.parsed + (opts.missing ?? 0)}` : "tool_calls=no"),
  ];
  console.info(parts.join(" "));
}

/** Extract a JSON array from a possibly-fenced response */
/** Strip reasoning/thinking tags and markdown fences from LLM response before JSON parsing */
function stripResponseNoise(text: string): string {
  let cleaned = text;
  // Strip reasoning/thinking blocks: <think>...</think>, <thinking>...</thinking>, <reasoning>...</reasoning>
  cleaned = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  // Strip trailing open reasoning blocks (model cut off mid-thought)
  cleaned = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, "");
  // Strip markdown fences
  if (cleaned.trim().startsWith("```")) {
    cleaned = cleaned.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return cleaned.trim();
}

function extractJsonArray(text: string): any[] | null {
  try {
    const cleaned = stripResponseNoise(text);

    // Try parsing as a direct array first: [...]
    const arrStart = cleaned.indexOf("[");
    const arrEnd = cleaned.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd > arrStart) {
      const arr = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      if (Array.isArray(arr)) return arr;
    }

    // Try parsing as a wrapper object: { "results": [...] }
    // OpenAI/Anthropic json_schema mode requires root-level objects, not arrays
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart !== -1 && objEnd > objStart) {
      const obj = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      if (obj && Array.isArray(obj.results)) return obj.results;
      // Also check if it's a single result (non-batch response)
      if (obj && typeof obj.importance === "number") return [obj];
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

/** Extract the first JSON object from a possibly-fenced response */
function extractJson(text: string): any | null {
  try {
    const cleaned = stripResponseNoise(text);

    // Find first { and last }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;

    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const VALID_EMOTIONAL_TAGS = new Set<EmotionalTag>([
  "grief", "joy", "tension", "dread", "intimacy", "betrayal",
  "revelation", "resolve", "humor", "melancholy", "awe", "fury",
]);

const VALID_NARRATIVE_FLAGS = new Set<NarrativeFlag>([
  "first_meeting", "death", "promise", "confession", "departure",
  "transformation", "battle", "discovery", "reunion", "loss",
]);

const VALID_ENTITY_TYPES = new Set(["character", "location", "item", "faction", "concept", "event"]);
const VALID_MENTION_ROLES = new Set(["subject", "object", "present", "referenced"]);
const VALID_RELATION_TYPES = new Set([
  "ally", "enemy", "lover", "parent", "child", "sibling", "mentor",
  "rival", "owns", "member_of", "located_in", "fears", "serves", "custom",
]);

function validateEmotionalTags(raw: any): EmotionalTag[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => VALID_EMOTIONAL_TAGS.has(t));
}

function validateNarrativeFlags(raw: any): NarrativeFlag[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f) => VALID_NARRATIVE_FLAGS.has(f));
}

const FACT_COMMON_VERBS = new Set([
  "is", "are", "was", "were", "be", "been", "being",
  "has", "have", "had", "having",
  "do", "does", "did",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "seems", "appears", "becomes", "remains", "feels", "looks", "sounds",
  "knows", "believes", "thinks", "wants", "needs", "likes", "loves", "hates",
  "says", "tells", "asks", "speaks", "lives", "works", "serves",
  "owns", "rules", "leads", "guards", "protects", "controls",
  "promised", "revealed", "discovered", "arrived", "departed", "died",
  "killed", "betrayed", "confessed", "transformed", "inherited", "lost",
  "gained", "broke", "destroyed", "created", "joined", "left",
]);

function validateKeyFacts(raw: any): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const facts: string[] = [];

  for (const fact of raw) {
    if (typeof fact !== "string") continue;
    const cleaned = fact.replace(/\s+/g, " ").trim();
    if (cleaned.length < 8 || cleaned.length > 220) continue;
    if (!/[a-zA-Z]/.test(cleaned)) continue;
    if (!cleaned.includes(" ")) continue;
    if (/^[A-Z\s]+$/.test(cleaned)) continue;
    if (/[:;,\-]$/.test(cleaned)) continue;

    const words = cleaned.split(/\s+/);
    if (words.length < 3) continue;
    if (/^[a-z]/.test(cleaned)) continue;

    const hasVerb = words.some((w) => {
      const lower = w.toLowerCase().replace(/[.,;:!?]$/, "");
      if (FACT_COMMON_VERBS.has(lower)) return true;
      if (/(?:ed|es|ing)$/.test(lower) && lower.length >= 4) return true;
      return false;
    });
    if (!hasVerb) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(cleaned);
  }

  return facts;
}

function validateStatusChanges(raw: any): StatusChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s: any) =>
      s && typeof s.entity === "string" && typeof s.change === "string",
  ).map((s: any) => ({
    entity: s.entity.trim(),
    change: s.change,
    detail: typeof s.detail === "string" ? s.detail : "",
  })).filter((s) => isValidEntityName(s.entity));
}

// ─── Entity Name Validation ───────────────────────────────────
// Structural filters to reject garbage that LLMs hallucinate as entities.

/** Pronouns and pronoun contractions — entities must not start with these */
const PRONOUN_STARTS = new Set([
  "i", "i'm", "i've", "i'll", "i'd", "me", "my", "myself",
  "we", "us", "our", "ourselves",
  "you", "your", "yourself", "yourselves", "you're", "you've", "you'll", "you'd",
  "he", "him", "his", "himself", "he's", "he'd", "he'll",
  "she", "her", "herself", "she's", "she'd", "she'll",
  "they", "them", "their", "themselves", "they're", "they've", "they'll", "they'd",
  "it", "its", "itself", "it's",
]);

/** Common English words that LLMs extract as "entities" but are not proper nouns.
 *  Covers verbs, adjectives, adverbs, common nouns, expletives. */
const SIDECAR_SINGLE_REJECT = new Set([
  // Verbs (gerunds, past tense, base forms)
  "having", "being", "going", "coming", "getting", "making", "taking",
  "seeing", "looking", "saying", "doing", "running", "walking", "talking",
  "trying", "asking", "telling", "leaving", "sitting", "standing",
  "feeling", "thinking", "waiting", "watching", "holding", "fighting",
  "turned", "walked", "looked", "started", "stopped", "opened", "closed",
  "moved", "pulled", "pushed", "dropped", "picked", "placed", "reached",
  "stepped", "climbed", "slurred", "mumbled", "whispered", "shouted",
  "screamed", "laughed", "smiled", "frowned", "nodded", "shrugged",
  "grabbed", "slammed", "stumbled", "collapsed", "continued", "replied",
  "answered", "noticed", "realized", "decided", "appeared", "remained",
  "managed", "happened", "covered", "created", "entered", "escaped",
  "followed", "gathered", "ignored", "imagined", "included", "offered",
  "provided", "received", "refused", "released", "removed", "revealed",
  "settled", "survived", "trusted",
  "set", "sets", "put", "puts", "run", "ran", "saw", "seen",
  "go", "goes", "gone", "leave", "leaves", "give", "gave",
  "take", "took", "come", "came", "find", "found",
  "said", "went", "got", "made", "knew", "thought", "felt",
  "told", "asked", "let", "began", "kept", "left",
  "cut", "hit", "hurt", "cost", "shut", "beat", "cast", "bear",
  "catch", "draw", "drive", "earn", "fight", "grow", "hang", "hide",
  "join", "kick", "lack", "lead", "lift", "lose", "mark", "miss",
  "note", "pass", "plan", "pray", "pull", "push", "read", "rest",
  "rush", "save", "seek", "sell", "send", "sign", "sort", "test",
  "warn", "wear", "wish", "wrap",
  // Expletives / interjections
  "fuck", "shit", "damn", "hell", "crap", "bloody", "bastard", "bitch",
  "god", "christ", "jesus", "ugh", "hmm", "huh", "wow", "oh", "ah",
  "okay", "yeah", "nope",
  // Adjectives commonly hallucinated as entities
  "personal", "strange", "certain", "different", "enough", "entire",
  "familiar", "final", "important", "impossible", "incredible", "obvious",
  "perfect", "possible", "serious", "silent", "simple", "single",
  "specific", "sudden", "terrible", "total", "unique", "wrong",
  "dangerous", "desperate", "difficult", "enormous", "essential",
  "former", "genuine", "honest", "human", "initial", "inner",
  "internal", "natural", "normal", "original", "physical", "private",
  "proper", "public", "secret", "separate", "steady", "subtle",
  "alive", "angry", "aware", "bare", "blind", "bold", "brave",
  "broad", "calm", "clean", "cold", "dark", "dead", "deep",
  "eager", "empty", "evil", "false", "fierce", "flat", "free",
  "full", "grand", "great", "guilty", "harsh", "heavy", "hidden",
  "huge", "keen", "large", "late", "lonely", "loose", "loud",
  "main", "major", "mere", "mild", "minor", "mutual", "narrow",
  "new", "noble", "odd", "old", "open", "pale", "plain", "poor",
  "proud", "pure", "quick", "quiet", "rare", "raw", "ready", "real",
  "rich", "rough", "round", "royal", "rude", "safe", "scared",
  "sharp", "short", "sick", "slim", "slow", "small", "smooth",
  "soft", "solid", "spare", "stable", "steep", "stiff", "straight",
  "strict", "strong", "sure", "sweet", "swift", "tall", "thick",
  "thin", "tight", "tiny", "tired", "tough", "true", "ugly",
  "vague", "vast", "vivid", "warm", "weak", "weird", "whole",
  "wide", "wild", "wise", "young",
  // Adverbs
  "barely", "almost", "anyway", "certainly", "clearly", "completely",
  "currently", "definitely", "directly", "entirely", "especially",
  "eventually", "exactly", "extremely", "finally", "honestly",
  "immediately", "instead", "literally", "merely", "mostly",
  "naturally", "obviously", "particularly", "perhaps", "possibly",
  "precisely", "probably", "properly", "purely", "quickly", "quietly",
  "recently", "seriously", "shortly", "simply", "slightly", "slowly",
  "somehow", "specifically", "suddenly", "supposedly", "surely",
  "together", "typically", "ultimately", "unfortunately", "usually",
  // Common nouns
  "cost", "deal", "fact", "kind", "sort", "type", "part", "form",
  "level", "amount", "manner", "reason", "result", "sense", "state",
  "rest", "half", "stuff", "lot", "case", "point", "side", "line",
  "way", "end", "act", "age", "air", "arm", "art", "bed", "bit",
  "care", "door", "edge", "face", "fire", "game", "goal", "hand",
  "head", "hope", "idea", "life", "light", "mind", "mood", "pain",
  "peace", "price", "role", "room", "rule", "soul", "spot", "step",
  "time", "top", "truth", "turn", "use", "view", "wall", "word",
]);

/**
 * Validate that an entity name from sidecar output is structurally plausible.
 * Rejects verb phrases, pronoun phrases, bracket garbage, and other non-entities.
 */
function isValidEntityName(name: string): boolean {
  const trimmed = name.trim();

  // Too short or too long
  if (trimmed.length < 2 || trimmed.length > 80) return false;

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(trimmed)) return false;

  // Reject bracket/special char garbage (e.g., "E B[2 M[1 ---")
  if (/[\[\]{}|<>#@\\~`]/.test(trimmed)) return false;

  // Reject dash/special-only sequences
  if (/^[-—–\s_.=]+$/.test(trimmed)) return false;

  // Reject if too many words (likely a sentence, not a name)
  const words = trimmed.split(/\s+/);
  if (words.length > 6) return false;

  // Reject if starts with a pronoun or pronoun contraction
  const firstWord = words[0].toLowerCase().replace(/[\u2018\u2019\u02BC'']/g, "'");
  if (PRONOUN_STARTS.has(firstWord)) return false;

  // Multi-word: must have at least one word starting with uppercase (proper noun evidence)
  if (words.length > 1 && !words.some((w) => /^[A-Z]/.test(w))) return false;

  // ALL-CAPS single words are emphasis/shouting, not proper nouns
  // (proper nouns are title-cased in prose, not ALL-CAPS)
  if (words.length === 1 && trimmed.length > 1 && /^[A-Z]+$/.test(trimmed)) return false;

  // Single-word: reject known verbs, expletives, adjectives, common nouns
  if (words.length === 1) {
    if (SIDECAR_SINGLE_REJECT.has(trimmed.toLowerCase())) return false;
    const lower = trimmed.toLowerCase();
    // Suffix patterns: adverbs, abstract nouns, adjectives (≥6 chars)
    if (trimmed.length >= 6 && /(?:ly|ness|ment|ful|less|ously|ively|ably|ibly|ally)$/.test(lower)) return false;
  }

  return true;
}

function validateEntities(raw: any): ExtractedEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e: any) =>
        e && typeof e.name === "string" && e.name.length > 0 && isValidEntityName(e.name),
    )
    .map((e: any) => ({
      name: e.name.trim(),
      type: VALID_ENTITY_TYPES.has(e.type) ? e.type : "concept",
      aliases: [],
      confidence: 0.9,
      role: VALID_MENTION_ROLES.has(e.role) ? e.role : "present",
    }));
}

function validateRelationships(raw: any): ExtractedRelationship[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r: any) =>
        r &&
        typeof r.source === "string" &&
        typeof r.target === "string" &&
        r.source.trim().toLowerCase() !== r.target.trim().toLowerCase() &&
        isValidEntityName(r.source) &&
        isValidEntityName(r.target),
    )
    .map((r: any) => ({
      source: r.source.trim(),
      target: r.target.trim(),
      type: VALID_RELATION_TYPES.has(r.type) ? r.type : "custom",
      label: typeof r.label === "string" ? r.label.trim() : "",
      sentiment: typeof r.sentiment === "number" ? Math.max(-1, Math.min(1, r.sentiment)) : 0,
    }));
}

const VALID_FONT_USAGE = new Set(["speech", "thought", "narration"]);

function validateFontColors(raw: any): SidecarFontColor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c: any) =>
        c &&
        typeof c.hex_color === "string" &&
        typeof c.character_name === "string" &&
        c.character_name.length > 0 &&
        !ENTITY_BLOCKLIST.has(c.character_name.toLowerCase().trim()) &&
        isValidEntityName(c.character_name),
    )
    .map((c: any) => ({
      hexColor: c.hex_color.toLowerCase().trim(),
      characterName: c.character_name.trim(),
      usageType: VALID_FONT_USAGE.has(c.usage_type) ? c.usage_type : "narration",
    }));
}

function validateDiscoveredAliases(raw: any): DiscoveredAlias[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (a: any) =>
        a &&
        typeof a.canonical_name === "string" &&
        typeof a.alias === "string" &&
        a.canonical_name.trim().length > 0 &&
        a.alias.trim().length > 0 &&
        typeof a.evidence === "string" &&
        a.evidence.trim().length > 0 &&
        isValidEntityName(a.canonical_name) &&
        isValidEntityName(a.alias) &&
        isPlausibleAlias(a.alias, a.canonical_name) &&
        // Alias must differ from canonical name
        a.canonical_name.trim().toLowerCase() !== a.alias.trim().toLowerCase(),
    )
    .map((a: any) => ({
      canonicalName: a.canonical_name.trim(),
      alias: sanitizeAlias(a.alias) ?? a.alias.trim(),
      evidence: a.evidence.trim(),
    }));
}
