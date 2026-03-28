/**
 * Memory Cortex — Sidecar-enhanced salience scoring.
 *
 * Uses a sidecar LLM connection to perform deep narrative analysis:
 * importance scoring, emotional tagging, entity extraction, relationship
 * inference, and status change detection — all in a single structured call.
 *
 * This is Tier 2 functionality: opt-in, async, never blocks generation.
 */

import type { SidecarExtractionResult, EmotionalTag, NarrativeFlag, StatusChange, ExtractedEntity, ExtractedRelationship } from "./types";
import { scoreChunkHeuristic } from "./salience-heuristic";

// ─── Prompt Template ───────────────────────────────────────────

const EXTRACTION_PROMPT = `Analyze this roleplay passage and extract structured memory metadata. Be precise and conservative — only report what is clearly present in the text.

<passage>
{{CONTENT}}
</passage>

Respond in JSON only, no explanation:
{
  "importance": <0-10 integer, where 0 is mundane filler and 10 is a story-defining moment>,
  "emotional_tones": [<up to 4 from: "grief","joy","tension","dread","intimacy","betrayal","revelation","resolve","humor","melancholy","awe","fury">],
  "narrative_flags": [<any that apply: "first_meeting","death","promise","confession","departure","transformation","battle","discovery","reunion","loss">],
  "status_changes": [{"entity":"<name>","change":"<injured|healed|died|transformed|betrayed|allied|departed|arrived|promoted|demoted>","detail":"<brief>"}],
  "key_facts": ["<important factual detail worth remembering long-term>"],
  "entities_present": [{"name":"<canonical name>","type":"<character|location|item|faction|concept|event>","role":"<subject|object|present|referenced>"}],
  "relationships_shown": [{"source":"<name>","target":"<name>","type":"<ally|enemy|lover|parent|child|sibling|mentor|rival|owns|member_of|located_in|fears|serves|custom>","label":"<brief descriptor>","sentiment":<-1.0 to 1.0>}]
}`;

// ─── Extraction ────────────────────────────────────────────────

/**
 * Run sidecar-enhanced extraction on a chunk of narrative text.
 *
 * @param content - The sanitized chunk content
 * @param generateRawFn - A function that calls the sidecar LLM (injected to avoid circular deps)
 * @param sidecarConnectionId - Connection profile ID for the sidecar
 * @returns Structured extraction result, or null if the call fails
 */
export async function extractWithSidecar(
  content: string,
  generateRawFn: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
  }) => Promise<{ content: string }>,
  sidecarConnectionId: string,
): Promise<SidecarExtractionResult | null> {
  try {
    const prompt = EXTRACTION_PROMPT.replace("{{CONTENT}}", content);

    const response = await generateRawFn({
      connectionId: sidecarConnectionId,
      messages: [
        {
          role: "system",
          content: "You are a narrative analysis engine for a roleplay memory system. Output valid JSON only, no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
      parameters: { temperature: 0.1, max_tokens: 1024 },
    });

    const json = extractJson(response.content);
    if (!json) return null;

    return {
      score: Math.max(0, Math.min(1, (json.importance ?? 5) / 10)),
      emotionalTags: validateEmotionalTags(json.emotional_tones),
      narrativeFlags: validateNarrativeFlags(json.narrative_flags),
      statusChanges: validateStatusChanges(json.status_changes),
      keyFacts: Array.isArray(json.key_facts) ? json.key_facts.filter((f: any) => typeof f === "string") : [],
      entitiesPresent: validateEntities(json.entities_present),
      relationshipsShown: validateRelationships(json.relationships_shown),
    };
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
  };
}

// ─── Helpers ───────────────────────────────────────────────────

/** Extract the first JSON object from a possibly-fenced response */
function extractJson(text: string): any | null {
  try {
    // Strip markdown fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

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

function validateEntities(raw: any): ExtractedEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e: any) =>
        e && typeof e.name === "string" && e.name.length > 0,
    )
    .map((e: any) => ({
      name: e.name,
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
