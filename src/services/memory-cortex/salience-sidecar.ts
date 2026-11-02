/**
 * Memory Cortex — Sidecar-enhanced salience scoring.
 *
 * Uses a sidecar LLM connection to perform deep narrative analysis:
 * importance scoring, emotional tagging, entity extraction, relationship
 * inference, and status change detection — all in a single structured call.
 *
 * This is Tier 2 functionality: opt-in, async, never blocks generation.
 */

import { isCortexDebugEnabled } from "./diagnostics";
import type { SidecarExtractionResult, SidecarFontColor, DiscoveredAlias, EmotionalTag, NarrativeFlag, StatusChange, ExtractedEntity, ExtractedRelationship } from "./types";
import { normalizeFontColor, type ThoughtDelimiters } from "./font-attribution";
import { buildConversationHint, type CortexParticipant } from "./conversation-context";
import { scoreChunkHeuristic } from "./salience-heuristic";
import { buildCortexIdentityContext } from "./identity-context";

interface ExtractionIdentityOptions {
  characterNames?: string[];
  participants?: CortexParticipant[];
  knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
  descriptionAliases?: Array<{ alias: string; canonicalName: string }>;
}

/** Resolve trusted identity labels before structural validation can discard a
 * long/decorated author label and its otherwise valid relationship endpoint. */
function normalizeExtractionNames(raw: any, options?: ExtractionIdentityOptions) {
  const identity = buildCortexIdentityContext(options?.characterNames ?? [], options?.knownEntities ?? [],
    new Map(options?.descriptionAliases?.map(({ alias, canonicalName }) => [alias, canonicalName])), options?.participants);
  const rows = (value: any, fields: string[], identityFields = fields) => Array.isArray(value) ? value.map((entry: any) => {
    if (!entry || typeof entry !== "object") return entry;
    const copy = { ...entry };
    for (const field of fields) if (typeof copy[field] === "string") copy[field] = identity.canonicalize(copy[field]);
    return copy;
  }).filter((entry: any) => !entry || typeof entry !== "object"
    || !identityFields.some((field) => typeof entry[field] === "string" && identity.isSharedLabel(entry[field]))) : value;
  return { ...raw,
    entities_present: rows(raw.entities_present, ["name"]), entities: rows(raw.entities, ["name"]),
    relationships_shown: rows(raw.relationships_shown, ["source", "target"]), relationships: rows(raw.relationships, ["source", "target"]),
    status_changes: rows(raw.status_changes, ["entity"]), color_attributions: rows(raw.color_attributions, ["character_name"]),
    discovered_aliases: rows(raw.discovered_aliases, ["canonical_name"], ["canonical_name", "alias"]),
  };
}

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
- Omit ambiguous, weakly implied or unsupported claims; still extract every clearly supported claim in the passage.
- Check for evidence before leaving a field empty. A connection demonstrated by a concrete action or utterance does not need a formal relationship declaration.
- Supplied participant identity metadata can resolve passage references; it never proves an event or relationship.`;

// Entity, alias, relationship, scoring and font color rules, shared verbatim by
// both extraction paths so behavior stays identical regardless of batching.
const EXTRACTION_RULES = `ENTITIES AND IDENTITY
- Extract specific named characters, locations, items, factions, events and concepts. A single clear mention is sufficient, including direct address or a reference to someone absent. Recurrence, importance and relationships are not prerequisites.
- Preserve the complete proper name, including lowercase connecting words, punctuation and accents. Do not split a name into title-cased fragments or attach a card subtitle to it.
- A scenario card or shared author label can represent multiple characters. Extract each individually evidenced character separately; never combine them into one character or use the shared label as an alias. Attribute actions, dialogue, thoughts, facts and relationships from local evidence in any narrative POV. A shared label alone does not establish which member acted or spoke.
- Use supplied canonical names for established identities. Card display labels and supplied aliases identify that same entity; they are not additional entities. For a new identity use its exact proper name from the passage.
- Exclude generic objects/descriptions, prose fragments, vocalizations, meta/system references and HUD scaffolding. An ordinary word can be a legitimate fictional name: judge its use, not a word blacklist.
- Resolve references from local names, narration, dialogue attribution and established viewpoint in any POV. Message prefixes and conversation_participants supply identity hints. Explicit speaker, thinker and addressee evidence takes precedence. Leave ambiguous references unresolved; never treat every character in a message as its author.
- Report a supported nickname or shortened reference in discovered_aliases with its canonical_name and evidence; never also emit it as a separate entity. Supplied canonical_aliases are identity mappings. Superficial similarity alone does not establish a new alias.

RELATIONSHIPS
- First check person-to-person connections, especially between the named user persona and the character. The user persona is an in-story character, eligible for the same relationship types as anyone else.
- Resolve endpoints including message prefixes, supplied aliases, and unambiguous pronouns. Include both resolved endpoints in entities_present even when names are absent from the body.
- Consider the full interpersonal dynamic: emotional, social, romantic, familial, adversarial, professional and power relationships. These are overlapping dimensions, not an exhaustive checklist. Recognize the nature of the bond from its meaning in context, without requiring particular words or behaviors.
- Identify how characters regard, relate to and affect one another. A bond need not be named explicitly when its nature is clear from passage evidence; supported interpretation of that evidence is part of extraction.
- Record concrete connections stated or demonstrated by dialogue, thoughts, actions or narration, including established bonds reaffirmed in this passage. A single supported interaction or commitment counts; no new status, long history or formal declaration is required. Bonds may be developing, established, changing, one-sided or mixed; preserve each independently supported dimension.
- Use the full relationship type vocabulary as broad categories. Choose the closest supported type and use label to preserve the actual nature of the connection. Friendship falls within ally; romantic attachment within lover; antagonistic bonds within enemy. Other standard types are equally eligible. Use custom with a precise label when no standard type fits. Do not flatten every positive connection into ally or every negative connection into enemy, or omit a bond because it does not fit a familiar pattern.
- A love interest is a relationship even before a formal partnership. Lover covers developing or established romantic attachment, including one-sided interest. Do not invent reciprocity, exclusivity, marriage or sex. Co-presence and routine conversation alone establish no interpersonal bond.
- Negated, hypothetical or insincere claims do not establish the claimed connection. Evidence about a different pair does not establish this pair's bond. Words inside proper names or card titles are not relationship evidence.
- Direction is source relative to target: parent = parent to child; child = child to parent; mentor = teacher/trainer to student; serves = subordinate to superior; owns = owner to possession; member_of = member to group; located_in = entity to place; fears = fearful entity to target. A student is not a child.
- Then add supported item, location and group connections. Ownership or location links do not replace person-to-person connections. Before returning, check that no supported interpersonal connection was omitted or recorded only in key_facts. Do not create an interpersonal connection when none is supported.

FACTS AND IMPORTANCE
- key_facts are self-contained, concrete statements supported by the passage. Write the relevant canonical entity names explicitly instead of unresolved I/you/she/he references. Resolve these only when passage viewpoint and identity metadata make the subject clear.
- Include durable developments such as agreements, promises, training commitments, confessions, discoveries, arrivals, departures and status changes. An uneventful passage can still contain a useful fact. Do not replace facts with themes, emotional impressions or personality judgments.
- Score importance from 0 to 10 by lasting consequence, not prose intensity. Treat facts, relationships and importance as separate judgments; low importance alone does not mean there are no facts or relationships.

FONT COLORS
- Report only colors present in HTML color markup. Normalize short hex, named colors and rgb to #rrggbb.
- Determine usage first: a thought/italic wrapper takes precedence over quotation marks, inside or outside the color tag. *...*, _..._, <i>, <em> and configured markers indicate thought; otherwise quoted dialogue is speech and descriptive/action prose is narration.
- Identify the thinker from local attribution and established narrative viewpoint in any POV. Mentions of other characters do not by themselves change viewpoint. One author can write multiple characters; a shared label does not establish a thinker.
- Attribute each color/usage to its speaker or thinker using local evidence. An addressed name, previous mapping or shared color does not prove ownership. A color can have both speech and thought: report both usage types when supported. Omit uncertain owners; never invent a color.`;

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
  description: "Extract named entities referenced by the passage, including canonical participants referred to through message prefixes or unambiguous I/you narration. Reject capitalized common words, meta references and formatting noise. Output canonical names, never pronouns. Return empty arrays when nothing qualifies.",
  parameters: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The canonical proper name of a known entity or participant, resolved from passage references. For a new entity, use its exact proper name from the passage." },
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
              enum: ["injured", "healed", "died", "destroyed", "transformed", "betrayed", "allied", "departed", "arrived"],
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
  description: "Check the full range of interpersonal bonds first, including connections involving the named user persona and character. Interpret the bond in context and use the full type vocabulary with a precise label; use custom when no standard type fits. Then add supported item/location/group links; these do not replace interpersonal relationships. Resolve canonical endpoints from passage references. Concrete evidence is sufficient without formal status; co-presence alone is not. Return an empty array only after checking for supported connections.",
  parameters: {
    type: "object",
    properties: {
      relationships: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string", description: "Canonical name of the entity holding the relationship role, resolved from passage names, prefixes, aliases or unambiguous pronouns. Include it in extract_entities." },
            target: { type: "string", description: "Canonical name of the entity the source's relationship points to, resolved from passage references. Include it in extract_entities." },
            type: {
              type: "string",
              enum: ["ally", "enemy", "lover", "parent", "child", "sibling", "mentor", "rival", "owns", "member_of", "located_in", "fears", "serves", "custom"],
              description: "Choose the closest supported category from the full enum. Categories describe broad connections, not fixed behaviors or required wording. ally includes friendship and affiliative bonds; lover covers romantic attachment; enemy covers antagonistic bonds. All other standard types are equally eligible. Use custom when no standard type fits, with label preserving the actual connection. Formal partnership or reciprocity is not required unless claimed.",
            },
            label: { type: "string", description: "Concise factual description of the actual bond, preserving its nature, current state and supported direction or asymmetry. Do not imply a stronger or more formal relationship than the evidence supports." },
            sentiment: { type: "number", minimum: -1, maximum: 1, description: "Emotional valence of the relationship as shown in the passage: -1.0 hostile, 0 neutral/unclear, 1.0 warm." },
          },
          required: ["source", "target", "type"],
        },
        description: "All clearly supported connections, with interpersonal relationships checked first. Do not omit a supported person-to-person connection because item/location links or key_facts were already reported. Empty array if none.",
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
              description: "thought=internal/italic channel (wrapping *...*, _..._, i/em or configured markers wins over quotes, inside or outside the color tag); speech=other quoted dialogue; narration=plain descriptive text. Report separate entries if a color has multiple usages.",
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

const EXTRACTION_TOOLS: ToolDefinition[] = [TOOL_SALIENCE, TOOL_ENTITIES, TOOL_RELATIONSHIPS, TOOL_FONT_COLORS];

const salienceProperties = (TOOL_SALIENCE.parameters as any).properties;
const entityProperties = (TOOL_ENTITIES.parameters as any).properties;
const relationshipProperties = (TOOL_RELATIONSHIPS.parameters as any).properties;
const fontColorProperties = (TOOL_FONT_COLORS.parameters as any).properties;

/** One tool call for a whole rebuild batch. Tool arguments are substantially
 *  more reliable than asking smaller/local models to print a large JSON blob
 *  into assistant content. The ordinary per-passage tools remain the fallback. */
const TOOL_ANALYZE_PASSAGE_BATCH: ToolDefinition = {
  name: "analyze_passage_batch",
  description: "Analyze every indexed passage independently and return exactly one structured result for each passage index.",
  parameters: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The exact zero-based passage index supplied by the caller." },
            importance: salienceProperties.importance,
            emotional_tones: salienceProperties.emotional_tones,
            narrative_flags: salienceProperties.narrative_flags,
            key_facts: salienceProperties.key_facts,
            entities_present: entityProperties.entities,
            relationships_shown: relationshipProperties.relationships,
            status_changes: entityProperties.status_changes,
            color_attributions: fontColorProperties.color_attributions,
            discovered_aliases: entityProperties.discovered_aliases,
          },
          required: [
            "index",
            "importance",
            "emotional_tones",
            "narrative_flags",
            "key_facts",
            "entities_present",
            "relationships_shown",
            "status_changes",
            "color_attributions",
            "discovered_aliases",
          ],
        },
      },
    },
    required: ["results"],
  },
};

/**
 * Build the tool-choice parameters for each provider.
 * Anthropic: tool_choice { type: "any" } — must use at least one tool
 * OpenAI/compat: tool_choice "required" — must use tools
 * Google: toolConfig { functionCallingConfig: { mode: "ANY" } }
 * Nano-GPT: tool_choice "auto" — some routed models reject "required"
 * DeepSeek: tool_choice "auto" — thinking mode rejects forced tool choices
 */
const GOOGLE_PROVIDERS = new Set(["google", "google_vertex"]);

export function getToolChoiceParams(provider: string): Record<string, any> {
  const normalizedProvider = provider.trim().toLowerCase();
  if (GOOGLE_PROVIDERS.has(normalizedProvider)) {
    return { toolConfig: { functionCallingConfig: { mode: "ANY" } } };
  }
  // Anthropic accepts tool_choice at body level; OpenAI/compat also accept it
  // Both use different formats but the passthrough sends it as-is
  if (normalizedProvider === "anthropic") {
    return { tool_choice: { type: "any" } };
  }
  // DeepSeek enables thinking by default and rejects `required` in that mode.
  if (normalizedProvider === "deepseek") {
    return { tool_choice: "auto" };
  }
  // Nano-GPT routes requests to many upstream models. Some reject the OpenAI
  // compatible `required` value, while still honoring the extraction prompt
  // and tool definitions when `auto` is used.
  if (normalizedProvider === "nanogpt") {
    return { tool_choice: "auto" };
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
  options?: ExtractionIdentityOptions,
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

  for (const call of toolCalls) {
    // Sidecar providers are external and occasionally return sparse tool-call
    // arrays. Ignore malformed entries rather than failing the whole passage.
    if (!call || typeof call.name !== "string" || !call.args || typeof call.args !== "object") continue;
    const args = normalizeExtractionNames(call.args, options);
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
  requestPurpose?: string;
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
function buildEntityHint(options?: ExtractionIdentityOptions): string {
  const identity = buildCortexIdentityContext(options?.characterNames ?? [], options?.knownEntities ?? [],
    undefined, options?.participants);
  let hint = "";
  if (options?.knownEntities?.length) {
    const lines = options.knownEntities.filter((entity) => !identity.isSharedLabel(entity.name))
      .slice(0, 50) // Cap to avoid prompt bloat
      .map((e) => {
        const aliases = e.aliases.filter((alias) => !identity.isSharedLabel(alias));
        const aliasStr = aliases.length > 0 ? ` (aka ${aliases.join(", ")})` : "";
        return `- ${e.name} [${e.type}]${aliasStr}`;
      });
    hint += `\n\n<known_entities>\nUse these canonical names when they match the passage. Never output an alias when a canonical name is listed here.\n${lines.join("\n")}\n</known_entities>`;
  }
  if (options?.characterNames?.length) {
    hint += `\n\n<known_characters>\n${options.characterNames.join(", ")}\n</known_characters>\nUse these canonical participant names when the passage refers to them, including through prefixes or unambiguous pronouns.`;
  }
  return hint;
}

/** An empty extraction is valid; a missing tool or missing field is not. */
function validateExtractionObject(json: any): void {
  if (!json || typeof json.importance !== "number" || !Number.isFinite(json.importance)
    || json.importance < 0 || json.importance > 10) throw new Error("Invalid or missing importance");
  for (const field of ["emotional_tones", "narrative_flags", "key_facts", "entities_present", "relationships_shown", "status_changes", "color_attributions", "discovered_aliases"]) {
    if (!Array.isArray(json[field])) throw new Error(`Incomplete extraction: ${field}`);
  }
}

function validateExtractionTools(calls: Array<{ name: string; args: Record<string, unknown> }>): void {
  const required = ["score_salience", "extract_entities", "extract_relationships", "extract_font_colors"];
  for (const name of required) {
    if (calls.filter((call) => call?.name === name && call.args && typeof call.args === "object").length !== 1) {
      throw new Error(`Incomplete extraction tool: ${name} (expected exactly one call; received tools=${JSON.stringify(calls.map((call) => call?.name ?? "unknown"))})`);
    }
  }
  const args = (name: string): any => calls.find((call) => call?.name === name)!.args;
  validateExtractionObject({ ...args("score_salience"), ...args("extract_entities"),
    entities_present: args("extract_entities").entities,
    relationships_shown: args("extract_relationships").relationships,
    color_attributions: args("extract_font_colors").color_attributions });
}

// Validate a parsed JSON extraction object into a SidecarExtractionResult.
function buildResultFromJsonObject(
  json: any,
  options?: ExtractionIdentityOptions,
): SidecarExtractionResult {
  validateExtractionObject(json);
  json = normalizeExtractionNames(json, options);
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
    participants?: CortexParticipant[];
    knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
    thoughtDelimiters?: ThoughtDelimiters;
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
    /** Throw on failure instead of returning null. Required for fallback callers
     *  that need to distinguish a real error (timeout, network, malformed
     *  response) from a successful "the passage had nothing to extract" result. */
    throwOnFailure?: boolean;
    signal?: AbortSignal;
  },
): Promise<SidecarExtractionResult | null> {
  const tag = options?.logTag ?? "single";
  const startedAt = Date.now();
  let stage = "prompt";
  let responseSummary = "";

  try {
    // Build entity context for the prompt — prefer full entities with aliases over bare names
    const entityHint = buildEntityHint(options);

    const aliasBlock = buildAliasReconciliationBlock(options?.descriptionAliases);
    const userContent = `Analyze the exact roleplay passage below. Call score_salience, extract_entities, extract_relationships, and extract_font_colors exactly once each. Use only the text below as evidence. Use empty arrays when nothing qualifies.${entityHint}${aliasBlock}${buildConversationHint(content, options?.characterNames ?? [], options?.descriptionAliases, options?.participants)}${buildThoughtMarkerHint(options?.thoughtDelimiters)}\n\n<passage>\n${content}\n</passage>`;
    logSidecarDispatch(tag, {
      chunks: 1,
      userContent,
      connectionId: sidecarConnectionId,
      tokenCounter: options?.tokenCounter,
    });
    const sentAt = Date.now();
    stage = "request";

    const response = await generateRawFn({

      requestPurpose: "extraction",
      connectionId: sidecarConnectionId,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      parameters: options?.samplingParameters ?? { temperature: 0.1 },
      tools: EXTRACTION_TOOLS,
      signal: options?.signal,
    });
    stage = "response validation";
    responseSummary = ` ${summarizeSidecarResponse(response)}`;
    logSidecarResponse(tag, { ms: Date.now() - sentAt, responseSummary });

    // Tool calls: parse structured results from tool_calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      validateExtractionTools(response.tool_calls);
      let result = parseToolCallResults(response.tool_calls, options);
      // Resolve any remaining aliases to canonical names (safety net if LLM used alias)
      if (options?.knownEntities?.length) {
        result = resolveAliasesInResult(result, options.knownEntities);
      }
      return result;
    }

    // Fallback: try parsing the text content as JSON (some providers inline it)
    const json = extractJson(response.content);
    if (!json) {
      throw new Error(`sidecar response had no tool_calls and no parseable JSON (${summarizeSidecarResponse(response)})`);
    }

    return buildResultFromJsonObject(json, options);
  } catch (err) {
    if (options?.throwOnFailure) throw err;
    console.warn(`[memory-cortex] ${tag}: Sidecar extraction failed, falling back to heuristic (connection=${sidecarConnectionId} stage=${stage} elapsed=${Date.now() - startedAt}ms${responseSummary}):`, err);
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
${lines}
</canonical_aliases>`;
}

/**
 * Score a chunk with sidecar, falling back to heuristic on failure.
 */
export async function scoreChunkWithSidecar(
  content: string,
  generateRawFn: (opts: {
    connectionId: string;
    requestPurpose?: string;
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
Call analyze_passage_batch exactly once with arguments matching this shape:
{"results":[{"index":<the passage's index>,"importance":<integer 0-10>,"emotional_tones":[],"narrative_flags":[],"key_facts":[],"entities_present":[{"name":"","type":"character|location|item|faction|event|concept","role":"subject|object|present|referenced"}],"relationships_shown":[{"source":"","target":"","type":"ally|enemy|lover|parent|child|sibling|mentor|rival|owns|member_of|located_in|fears|serves|custom","label":"","sentiment":0}],"status_changes":[{"entity":"","change":"injured|healed|died|destroyed|transformed|betrayed|allied|departed|arrived","detail":""}],"color_attributions":[{"hex_color":"#rrggbb","character_name":"","usage_type":"speech|thought|narration"}],"discovered_aliases":[{"canonical_name":"","alias":"","evidence":""}]}]}
- Emit exactly one results entry per passage, with "index" equal to that passage's index attribute.
- Use empty arrays for any field with nothing to report.

${EXTRACTION_GLOBAL_RULES}
- Score and extract each passage in isolation. Do NOT carry information between passages.

${EXTRACTION_RULES}`;

export async function extractBatchWithSidecar(
  chunks: Array<{ index: number; content: string }>,
  generateRawFn: SidecarGenerateFn,
  sidecarConnectionId: string,
  options?: {
    characterNames?: string[];
    participants?: CortexParticipant[];
    knownEntities?: Array<{ name: string; type: string; aliases: string[] }>;
    thoughtDelimiters?: ThoughtDelimiters;
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
  // One chunk does not benefit from batching.
  if (chunks.length === 1) {
    return [
      await extractWithSidecar(chunks[0].content, generateRawFn, sidecarConnectionId, options),
    ];
  }

  const tag = options?.logTag ?? "batch";
  const startedAt = Date.now();
  let stage = "prompt";
  let responseSummary = "";

  try {
    const entityHint = buildEntityHint(options);
    // Array position is the prompt index so results map back positionally.
    const passages = chunks
      .map((c, i) => `<passage index="${i}">\n${c.content}\n</passage>${buildConversationHint(c.content, options?.characterNames ?? [], options?.descriptionAliases, options?.participants)}`)
      .join("\n\n");

    const aliasBlock = buildAliasReconciliationBlock(options?.descriptionAliases);
    const userContent = `Analyze each roleplay passage below independently. Call analyze_passage_batch exactly once with exactly one results entry per passage. Use only the text inside each passage as evidence.${entityHint}${aliasBlock}${buildThoughtMarkerHint(options?.thoughtDelimiters)}\n\n${passages}`;
    logSidecarDispatch(tag, {
      chunks: chunks.length,
      userContent,
      connectionId: sidecarConnectionId,
      tokenCounter: options?.tokenCounter,
    });
    const sentAt = Date.now();
    stage = "request";

    const response = await generateRawFn({

      requestPurpose: "batch extraction",
      connectionId: sidecarConnectionId,
      messages: [
        { role: "system", content: BATCH_EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      parameters: options?.samplingParameters ?? { temperature: 0.1 },
      tools: [TOOL_ANALYZE_PASSAGE_BATCH],
    });
    const responseMs = Date.now() - sentAt;
    stage = "response validation";
    responseSummary = ` ${summarizeSidecarResponse(response)}`;

    // Be defensive here as this is the boundary for provider-normalized data.
    // A malformed/sparse entry should simply be treated as no batch tool call,
    // allowing the existing text parser to recover without another request.
    const batchToolCall = response.tool_calls?.find(
      (call) => !!call && call.name === TOOL_ANALYZE_PASSAGE_BATCH.name,
    );
    const toolResults = batchToolCall?.args?.results;
    const parsed = Array.isArray(toolResults) ? toolResults : extractJsonArray(response.content);
    const byIndex = new Map<number, any>();
    const duplicates = new Set<number>();
    if (parsed) {
      for (const item of parsed) {
        if (item && Number.isInteger(item.index)) {
          if (byIndex.has(item.index)) duplicates.add(item.index);
          byIndex.set(item.index, item);
        }
      }
    }

    const results: Array<SidecarExtractionResult | null> = new Array(chunks.length).fill(null);
    const failures: Array<{ index: number; reason: unknown }> = [];
    for (let i = 0; i < chunks.length; i++) {
      const obj = duplicates.has(i) ? null : byIndex.get(i);
      if (obj) {
        try {
          results[i] = buildResultFromJsonObject(obj, options);
        } catch (err) { failures.push({ index: i, reason: err }); }
      } else {
        failures.push({ index: i, reason: duplicates.has(i) ? "Duplicate passage index"
          : parsed ? "Missing passage result" : "No parseable batch results" });
      }
    }
    logSidecarResponse(tag, {
      ms: responseMs,
      responseSummary,
      parsed: chunks.length - failures.length,
      missing: failures.length,
    });

    if (failures.length > 0) {
      console.warn(`[memory-cortex] ${tag}: ${failures.length}/${chunks.length} passage(s) missing or invalid in batch response (connection=${sidecarConnectionId}${responseSummary}):`, failures);
    }

    return results;
  } catch (err: unknown) {
    console.warn(`[memory-cortex] ${tag}: batch extraction failed (connection=${sidecarConnectionId} stage=${stage} elapsed=${Date.now() - startedAt}ms${responseSummary}):`, err);
    return chunks.map(() => null);
  }
}

// ─── Diagnostic logging ─────────────────────────────────────────

/** Shape only: never log passage text or the provider's generated content. */
function summarizeSidecarResponse(response: Awaited<ReturnType<SidecarGenerateFn>>): string {
  const calls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
  const names = calls.slice(0, 20).map((call) => typeof call?.name === "string" ? call.name.slice(0, 100) : "unknown");
  return `content_chars=${typeof response?.content === "string" ? response.content.length : 0} tool_calls=${JSON.stringify(names)}${calls.length > 20 ? ` (${calls.length} total)` : ""}`;
}

function logSidecarDispatch(
  tag: string,
  opts: {
    chunks: number;
    userContent: string;
    connectionId: string;
    requestPurpose?: string;
    tokenCounter?: (text: string) => number;
  },
): void {
  if (!isCortexDebugEnabled()) return;
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
  ];
  console.info(parts.join(" "));
}

function logSidecarResponse(
  tag: string,
  opts: { ms: number; responseSummary: string; parsed?: number; missing?: number },
): void {
  if (!isCortexDebugEnabled()) return;
  const parts = [
    `[memory-cortex] ${tag} ← ${opts.ms}ms`,
    opts.responseSummary.trim(),
  ];
  if (opts.parsed !== undefined) parts.push(`parsed=${opts.parsed}/${opts.parsed + (opts.missing ?? 0)}`);
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

function buildThoughtMarkerHint(markers?: ThoughtDelimiters): string {
  return markers?.prefix && markers?.suffix
    ? `\n\nConfigured thought delimiters (formatting data): ${JSON.stringify(markers)}. These indicate thought usage even when they wrap a color tag or contain quotes.` : "";
}

function validateFontColors(raw: any): SidecarFontColor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c: any) =>
        c &&
        typeof c.hex_color === "string" && normalizeFontColor(c.hex_color) !== null &&
        VALID_FONT_USAGE.has(c.usage_type) &&
        typeof c.character_name === "string" &&
        c.character_name.length > 0 &&
        !ENTITY_BLOCKLIST.has(c.character_name.toLowerCase().trim()) &&
        isValidEntityName(c.character_name),
    )
    .map((c: any) => ({
      hexColor: normalizeFontColor(c.hex_color)!,
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
