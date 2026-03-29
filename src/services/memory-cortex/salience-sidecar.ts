/**
 * Memory Cortex — Sidecar-enhanced salience scoring.
 *
 * Uses a sidecar LLM connection to perform deep narrative analysis:
 * importance scoring, emotional tagging, entity extraction, relationship
 * inference, and status change detection — all in a single structured call.
 *
 * This is Tier 2 functionality: opt-in, async, never blocks generation.
 */

import type { SidecarExtractionResult, SidecarFontColor, EmotionalTag, NarrativeFlag, StatusChange, ExtractedEntity, ExtractedRelationship } from "./types";
import { scoreChunkHeuristic } from "./salience-heuristic";

// ─── Tool-Based Structured Extraction ──────────────────────────
// Native tool/function calling — every provider supports this natively.
// Each extraction aspect is a separate tool. The LLM calls ALL tools.
// Results come back as tool_calls with guaranteed JSON args.

import type { ToolDefinition } from "../../llm/types";

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

const EXTRACTION_SYSTEM_PROMPT = `You are a narrative data extractor for a roleplay memory system. Extract structured facts from the passage with precision.

STRICT RULES — violations corrupt the memory database:
1. ONLY extract entities with explicit proper names in the passage (e.g. "Melina", "Dustwell", "Sixth Street"). Proper nouns only.
2. NEVER extract meta-references: User, You, AI, Player, Narrator, Character, Assistant, System, Bot, Human, NPC, OOC, or any pronoun.
3. NEVER invent entities. If a character is referred to only by pronoun ("she", "he"), do NOT create an entity for them.
4. CANONICAL NAMES: When known entities are listed below with aliases, ALWAYS output the canonical (primary) name, never a nickname or shorthand. "Pul" → use "Pulchra Fellini". For NEW entities not in the known list, use the exact name from the passage.
5. Relationships require TWO DIFFERENT named entities that BOTH appear in the passage. Never create relationships between aliases of the same entity. No relationships with pronouns or meta-references.
6. Score importance by lasting narrative consequence (deaths, promises, discoveries) — NOT by dramatic prose style or emotional intensity of the writing.
7. Key facts must be concrete and verifiable from the text: names learned, items acquired, locations visited, promises made. Not impressions or moods.
8. For font color tags: if the passage contains <font color=...> or <span style="color:..."> HTML, identify which named character owns each color.

Call ALL provided tools with data extracted strictly from the passage text.`;

// ─── Tool Definitions ──────────────────────────────────────────

const TOOL_SALIENCE: ToolDefinition = {
  name: "score_salience",
  description: "Score narrative importance and detect emotional/story signals. Base score on lasting consequences, not writing style.",
  parameters: {
    type: "object",
    properties: {
      importance: { type: "integer", description: "0=mundane filler/small talk, 2=routine interaction, 4=notable but forgettable, 6=significant development, 8=major plot point, 10=story-defining moment (death, betrayal, transformation)" },
      emotional_tones: { type: "array", items: { type: "string" }, description: "Up to 3 that are clearly expressed (not just implied by dramatic prose). Options: grief, joy, tension, dread, intimacy, betrayal, revelation, resolve, humor, melancholy, awe, fury" },
      narrative_flags: { type: "array", items: { type: "string" }, description: "ONLY if genuinely applicable: first_meeting, death, promise, confession, departure, transformation, battle, discovery, reunion, loss" },
      key_facts: { type: "array", items: { type: "string" }, description: "Concrete facts: 'Melina promised to return', 'The sword was broken', 'They arrived at Dustwell'. Not vibes or impressions." },
    },
    required: ["importance", "emotional_tones"],
  },
};

const TOOL_ENTITIES: ToolDefinition = {
  name: "extract_entities",
  description: "Extract ONLY entities with proper names written in the passage. A proper name is a capitalized noun used as a specific identifier (person, place, thing, group). Do NOT include pronouns, generic references, or meta-terms. Return empty array if no proper names appear.",
  parameters: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact proper name from the text. Must be a specific name, never a pronoun or generic word." },
            type: { type: "string", description: "character (named person/creature), location (named place), item (named object/weapon), faction (named group/org), concept (named abstract), or event (named occurrence)" },
            role: { type: "string", description: "subject (acts), object (acted upon), present (in scene), or referenced (mentioned but absent)" },
          },
          required: ["name", "type"],
        },
        description: "Named entities found. Empty array [] if no proper nouns appear.",
      },
      status_changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Proper name of the entity whose status changed" },
            change: { type: "string", description: "injured, healed, died, transformed, betrayed, allied, departed, arrived" },
            detail: { type: "string", description: "Brief description of what happened" },
          },
        },
        description: "Status changes that explicitly occurred in this passage. Empty array if none.",
      },
    },
    required: ["entities"],
  },
};

const TOOL_RELATIONSHIPS: ToolDefinition = {
  name: "extract_relationships",
  description: "Extract relationships between TWO named entities that BOTH appear in the passage. Both source and target must be proper names from the text. Empty array if fewer than 2 named entities appear.",
  parameters: {
    type: "object",
    properties: {
      relationships: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string", description: "Proper name of source entity (must appear in passage)" },
            target: { type: "string", description: "Proper name of target entity (must appear in passage)" },
            type: { type: "string", description: "ally, enemy, lover, parent, child, sibling, mentor, rival, owns, member_of, located_in, fears, serves, or custom" },
            label: { type: "string", description: "Brief descriptor: 'childhood friends', 'sworn enemies'" },
            sentiment: { type: "number", description: "-1.0 (hostile) to 1.0 (warm)" },
          },
          required: ["source", "target", "type"],
        },
        description: "Relationships between named entities. Empty array [] if fewer than 2 named entities.",
      },
    },
    required: ["relationships"],
  },
};

const TOOL_FONT_COLORS: ToolDefinition = {
  name: "extract_font_colors",
  description: "If HTML <font color=...> or <span style='color:...'> tags appear in the passage, identify which named character speaks or narrates in each color. Empty array if no color tags present.",
  parameters: {
    type: "object",
    properties: {
      color_attributions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            hex_color: { type: "string", description: "The hex color value (e.g. #ff9999, #E6E6FA)" },
            character_name: { type: "string", description: "Proper name of the character using this color" },
            usage_type: { type: "string", description: "speech (quoted dialogue in this color), thought (internal/italic), or narration (descriptive text)" },
          },
          required: ["hex_color", "character_name", "usage_type"],
        },
        description: "Color-to-character mappings. Empty array [] if no HTML color tags found.",
      },
    },
    required: ["color_attributions"],
  },
};

const EXTRACTION_TOOLS: ToolDefinition[] = [TOOL_SALIENCE, TOOL_ENTITIES, TOOL_RELATIONSHIPS, TOOL_FONT_COLORS];

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

  for (const call of toolCalls) {
    const args = call.args as any;
    switch (call.name) {
      case "score_salience":
        importance = typeof args.importance === "number" ? args.importance : 5;
        emotionalTags = validateEmotionalTags(args.emotional_tones);
        narrativeFlags = validateNarrativeFlags(args.narrative_flags);
        keyFacts = Array.isArray(args.key_facts) ? args.key_facts.filter((f: any) => typeof f === "string") : [];
        break;
      case "extract_entities":
        entities = validateEntities(args.entities);
        statusChanges = validateStatusChanges(args.status_changes);
        break;
      case "extract_relationships":
        relationships = validateRelationships(args.relationships);
        break;
      case "extract_font_colors":
        fontColors = validateFontColors(args.color_attributions);
        break;
    }
  }

  // Post-processing: filter blocklisted meta-entities that slipped through
  entities = entities.filter((e) => !ENTITY_BLOCKLIST.has(e.name.toLowerCase().trim()));
  relationships = relationships.filter(
    (r) => !ENTITY_BLOCKLIST.has(r.source.toLowerCase().trim()) && !ENTITY_BLOCKLIST.has(r.target.toLowerCase().trim()),
  );
  statusChanges = statusChanges.filter((s) => !ENTITY_BLOCKLIST.has(s.entity.toLowerCase().trim()));

  return {
    score: Math.max(0, Math.min(1, importance / 10)),
    emotionalTags: emotionalTags as any[],
    narrativeFlags: narrativeFlags as any[],
    statusChanges,
    keyFacts,
    entitiesPresent: entities as any[],
    relationshipsShown: relationships as any[],
    fontColors,
  };
}

/** Get the extraction tools array (for passing to generate calls) */
export function getExtractionTools(): ToolDefinition[] {
  return EXTRACTION_TOOLS;
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

  const resolve = (name: string) => aliasMap.get(name.toLowerCase()) || name;

  // Resolve entity names and deduplicate (e.g., "Pulchra" + "Pul" both → "Pulchra Fellini")
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

  return {
    ...result,
    entitiesPresent: [...seenEntities.values()],
    relationshipsShown: relationships,
    statusChanges,
    fontColors,
  };
}

// ─── Extraction ────────────────────────────────────────────────

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
  },
): Promise<SidecarExtractionResult | null> {
  try {
    // Build entity context for the prompt — prefer full entities with aliases over bare names
    let entityHint = "";
    if (options?.knownEntities?.length) {
      const lines = options.knownEntities
        .slice(0, 50) // Cap to avoid prompt bloat
        .map((e) => {
          const aliasStr = e.aliases.length > 0 ? ` (aka ${e.aliases.join(", ")})` : "";
          return `- ${e.name} [${e.type}]${aliasStr}`;
        });
      entityHint = `\n\nKnown entities — ALWAYS use the canonical name, never aliases:\n${lines.join("\n")}`;
    } else if (options?.characterNames?.length) {
      entityHint = `\nKnown characters in this roleplay: ${options.characterNames.join(", ")}. Extract these if they appear, plus any NEW proper names.`;
    }

    const response = await generateRawFn({
      connectionId: sidecarConnectionId,
      messages: [
        {
          role: "system",
          content: EXTRACTION_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `Extract structured data from this roleplay passage. Call ALL tools.${entityHint}\n\n<passage>\n${content}\n</passage>`,
        },
      ],
      parameters: { temperature: 0.1 },
      tools: EXTRACTION_TOOLS,
    });

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
    if (!json) return null;

    // Apply blocklist to fallback path too
    const fbEntities = validateEntities(json.entities_present).filter((e) => !ENTITY_BLOCKLIST.has(e.name.toLowerCase().trim()));
    const fbRelationships = validateRelationships(json.relationships_shown).filter(
      (r) => !ENTITY_BLOCKLIST.has(r.source.toLowerCase().trim()) && !ENTITY_BLOCKLIST.has(r.target.toLowerCase().trim()),
    );

    let fbResult: SidecarExtractionResult = {
      score: Math.max(0, Math.min(1, (json.importance ?? 5) / 10)),
      emotionalTags: validateEmotionalTags(json.emotional_tones),
      narrativeFlags: validateNarrativeFlags(json.narrative_flags),
      statusChanges: validateStatusChanges(json.status_changes),
      keyFacts: Array.isArray(json.key_facts) ? json.key_facts.filter((f: any) => typeof f === "string") : [],
      entitiesPresent: fbEntities,
      relationshipsShown: fbRelationships,
      fontColors: validateFontColors(json.color_attributions),
    };
    if (options?.knownEntities?.length) {
      fbResult = resolveAliasesInResult(fbResult, options.knownEntities);
    }
    return fbResult;
  } catch (err) {
    console.warn("[memory-cortex] Sidecar extraction failed, falling back to heuristic:", err);
    return null;
  }
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
  };
}

/**
 * Extract from multiple chunks. Each chunk gets its own tool-calling request.
 * The rebuild pipeline handles concurrency batching — this just processes the array.
 */
/**
 * Extract from multiple chunks. Each chunk gets its own tool-calling LLM request.
 * The caller handles concurrency batching — this just processes the array.
 */
export async function extractBatchWithSidecar(
  chunks: Array<{ index: number; content: string }>,
  generateRawFn: SidecarGenerateFn,
  sidecarConnectionId: string,
  options?: { characterNames?: string[]; knownEntities?: Array<{ name: string; type: string; aliases: string[] }> },
): Promise<Array<SidecarExtractionResult | null>> {
  if (chunks.length === 0) return [];

  // Process each chunk independently — tool calling guarantees structured output per chunk
  return Promise.all(
    chunks.map((chunk) =>
      extractWithSidecar(chunk.content, generateRawFn, sidecarConnectionId, options).catch(() => null),
    ),
  );
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

function validateStatusChanges(raw: any): StatusChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s: any) =>
      s && typeof s.entity === "string" && typeof s.change === "string",
  ).map((s: any) => ({
    entity: s.entity,
    change: s.change,
    detail: typeof s.detail === "string" ? s.detail : "",
  }));
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

/** Single words that LLMs extract as "entities" but are clearly not proper nouns */
const SIDECAR_SINGLE_REJECT = new Set([
  // Verb forms
  "having", "being", "going", "coming", "getting", "making", "taking",
  "seeing", "looking", "saying", "doing", "running", "walking", "talking",
  "trying", "asking", "telling", "leaving", "sitting", "standing",
  "turned", "walked", "looked", "started", "stopped", "opened", "closed",
  "moved", "pulled", "pushed", "dropped", "picked", "placed", "reached",
  "stepped", "climbed", "slurred", "mumbled", "whispered", "shouted",
  "screamed", "laughed", "smiled", "frowned", "nodded", "shrugged",
  "grabbed", "slammed", "stumbled", "collapsed", "continued", "replied",
  "answered", "noticed", "realized", "decided", "appeared", "remained",
  "set", "sets", "put", "puts", "run", "ran", "saw", "seen",
  "go", "goes", "gone", "leave", "leaves", "give", "gave",
  "take", "took", "come", "came", "find", "found",
  "said", "went", "got", "made", "knew", "thought", "felt",
  "told", "asked", "let", "began", "kept", "left",
  // Expletives / interjections
  "fuck", "shit", "damn", "hell", "crap", "bloody", "bastard", "bitch",
  "god", "christ", "jesus", "ugh", "hmm", "huh", "wow",
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

  // Single-word: reject known verbs, expletives, adjectives
  if (words.length === 1) {
    if (SIDECAR_SINGLE_REJECT.has(trimmed.toLowerCase())) return false;
    // Lowercase single word with verb suffix — likely not a proper noun
    if (/^[a-z]/.test(trimmed) && /(?:ing|ed|tion|ment|ness)$/.test(trimmed)) return false;
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
        r.source !== r.target,
    )
    .map((r: any) => ({
      source: r.source,
      target: r.target,
      type: VALID_RELATION_TYPES.has(r.type) ? r.type : "custom",
      label: typeof r.label === "string" ? r.label : "",
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
        !ENTITY_BLOCKLIST.has(c.character_name.toLowerCase().trim()),
    )
    .map((c: any) => ({
      hexColor: c.hex_color.toLowerCase().trim(),
      characterName: c.character_name.trim(),
      usageType: VALID_FONT_USAGE.has(c.usage_type) ? c.usage_type : "narration",
    }));
}
