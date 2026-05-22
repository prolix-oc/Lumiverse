import type {
  EntityType,
  ExtractedEntity,
  MemoryEntity,
  MentionRole,
  ExtractedRelationship,
} from "./types";
import { isPlausibleAlias, sanitizeAlias } from "./alias-validation";

export interface RefinerAlias {
  canonicalName: string;
  alias: string;
  evidence?: string;
}

interface RefinerInput {
  content: string;
  knownEntities: MemoryEntity[];
  characterNames: string[];
  entities: Array<ExtractedEntity & { mentionRole?: MentionRole }>;
  relationships: Array<ExtractedRelationship & { confidence?: number }>;
  aliases: RefinerAlias[];
  descriptionAliases?: RefinerAlias[];
}

interface RefinedEntity extends ExtractedEntity {
  mentionRole: MentionRole;
}

interface RefinerOutput {
  entities: RefinedEntity[];
  relationships: Array<ExtractedRelationship & { confidence?: number }>;
  aliases: RefinerAlias[];
}

const EVENT_HEAD_RE = /\b(?:war|battle|siege|fall|rise|incident|uprising|revolution|festival|ritual|ceremony|coronation|treaty|pact|massacre|awakening|operation|summit|trial|election|funeral|memorial)\b/i;
const EVENT_TEMPORAL_RE = /\b(?:during|after|before|since|following|in the wake of|on the anniversary of|at the time of|survivors? of|veterans? of|witness(?:ed|es)?|fought in|died in|sparked|triggered|caused by|began with|ended with)\b/i;
const FACTION_NAME_RE = /\b(?:guild|order|clan|army|church|council|brotherhood|syndicate|sect|cult|house|dynasty|tribe|corporation|company|agency|bureau|division|force|squad|unit|organization|collective|cartel|network|security|guard|watch|corps|command|commandery|directorate|committee|administration|holdings|industries|logistics|services|solutions|systems|labs?|partners|foundry|forge)\b/i;
const FACTION_MEMBERSHIP_RE = /\b(?:member|agent|officer|captain|operative|director|chair|leader|recruit|employee|staff|soldier|guard|patrol|commander|serv(?:e|es|ed|ing)|join(?:ed|s|ing)?|left|defect(?:ed|s|ing)?|works?|worked|reports?|reported|belongs?|belonged|employed)\b/i;
const FACTION_ASSET_RE = /\b(?:base|hq|headquarters|insignia|troops|convoy|patrol|unit|cell|network|roster|personnel|orders|command|banner|colors|uniforms?|seal|charter|funding|territory|docks?|warehouse|compound)\b/i;
const BODY_POSSESSIVE_RE = /[''\u2019]s\s+(?:eyes?|voice|hands?|fingers?|arms?|legs?|face|lips?|mouth|hair|head|shoulder|chest|back|heart|gaze|smile|grin|frown|expression|tone|breath|thoughts?|mind|body)\b/i;
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/^the\s+/i, "");
}

function dedupeAliases(aliases: RefinerAlias[]): RefinerAlias[] {
  const seen = new Set<string>();
  const deduped: RefinerAlias[] = [];
  for (const alias of aliases) {
    const canonicalName = alias.canonicalName.trim();
    const aliasName = sanitizeAlias(alias.alias);
    if (!canonicalName || !aliasName) continue;
    if (!isPlausibleAlias(aliasName, canonicalName)) continue;
    const key = `${canonicalName.toLowerCase()}:${aliasName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ canonicalName, alias: aliasName, evidence: alias.evidence });
  }
  return deduped;
}

function hasBoundary(content: string, start: number, end: number): boolean {
  const before = start > 0 ? content[start - 1] : "";
  const after = end < content.length ? content[end] : "";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

function collectMentionContexts(content: string, name: string, padding = 140, maxMatches = 6): string[] {
  const lowerContent = content.toLowerCase();
  const lowerName = name.toLowerCase();
  const windows: string[] = [];
  let cursor = 0;

  while (windows.length < maxMatches) {
    const index = lowerContent.indexOf(lowerName, cursor);
    if (index === -1) break;
    const end = index + lowerName.length;
    cursor = end;
    if (!hasBoundary(content, index, end)) continue;
    const start = Math.max(0, index - padding);
    const finish = Math.min(content.length, end + padding);
    windows.push(content.slice(start, finish));
  }

  return windows;
}

function countMatchingContexts(contexts: string[], predicate: (context: string) => boolean): number {
  let count = 0;
  for (const context of contexts) {
    if (predicate(context)) count += 1;
  }
  return count;
}

function hasFactionMembershipSignal(name: string, contexts: string[]): boolean {
  const escaped = escapeRegExp(name);
  return contexts.some((context) => {
    const lowered = context.toLowerCase();
    return (
      new RegExp(`\\b(?:member|agent|officer|operative|director|leader|captain|employee|staff|soldier|guard|recruit)\\s+(?:of|in|from|with|for)\\s+(?:the\\s+)?${escaped}\\b`, "i").test(context)
      || new RegExp(`\\b(?:join(?:ed|s|ing)?|left|defect(?:ed|s|ing)?|serv(?:e|es|ed|ing)|works?|worked|reports?|reported|belongs?|belonged|employed)\\s+(?:to|in|for|with|under)?\\s*(?:the\\s+)?${escaped}\\b`, "i").test(context)
      || (new RegExp(`\\b${escaped}\\b`, "i").test(context) && FACTION_MEMBERSHIP_RE.test(lowered) && FACTION_ASSET_RE.test(lowered))
    );
  });
}

function hasFactionAssetSignal(name: string, contexts: string[]): boolean {
  const escaped = escapeRegExp(name);
  return contexts.some((context) => (
    new RegExp(`\\b${escaped}[''\u2019]s\\s+${FACTION_ASSET_RE.source}`, "i").test(context)
    || new RegExp(`\\b${escaped}\\s+${FACTION_ASSET_RE.source}`, "i").test(context)
  ));
}

function hasEventTemporalSignal(name: string, contexts: string[]): boolean {
  const escaped = escapeRegExp(name);
  return contexts.some((context) => (
    new RegExp(`\\b(?:during|after|before|since|following|at the time of|in the wake of|on the anniversary of)\\s+(?:the\\s+)?${escaped}\\b`, "i").test(context)
    || new RegExp(`\\b(?:survived|witness(?:ed|es)?|fought\\s+in|died\\s+in|sparked|triggered|caused\\s+by|remembered|commemorated)\\s+(?:the\\s+)?${escaped}\\b`, "i").test(context)
  ));
}

function hasNegativeCharacterSignal(name: string, contexts: string[]): boolean {
  const escaped = escapeRegExp(name);
  return contexts.some((context) => (
    new RegExp(`\\b${escaped}${BODY_POSSESSIVE_RE.source}`, "i").test(context)
    || new RegExp(`(?:^|[""\u201C\.!?]\\s*)${escaped},\\s+(?:I|we|you|he|she|they|what|where|how|why|do|don't|please|listen|look|stop|wait|help|come|go|run|tell|no|yes)\\b`, "i").test(context)
  ));
}

function canonicalizeRelationships(
  relationships: Array<ExtractedRelationship & { confidence?: number }>,
  aliases: RefinerAlias[],
): Array<ExtractedRelationship & { confidence?: number }> {
  if (aliases.length === 0) return relationships;

  const aliasToCanonical = new Map<string, string>();
  for (const alias of aliases) {
    aliasToCanonical.set(normalizeKey(alias.alias), alias.canonicalName);
  }

  const deduped = new Map<string, ExtractedRelationship & { confidence?: number }>();
  for (const relationship of relationships) {
    const source = aliasToCanonical.get(normalizeKey(relationship.source)) ?? relationship.source;
    const target = aliasToCanonical.get(normalizeKey(relationship.target)) ?? relationship.target;
    const key = `${normalizeKey(source)}:${normalizeKey(target)}:${relationship.type}:${relationship.label}`;
    if (!deduped.has(key)) deduped.set(key, { ...relationship, source, target });
  }

  return [...deduped.values()];
}

function buildKnownTypeLookup(
  knownEntities: MemoryEntity[],
  characterNames: string[],
  descriptionAliases: RefinerAlias[],
): Map<string, { canonicalName: string; type: EntityType }> {
  const lookup = new Map<string, { canonicalName: string; type: EntityType }>();

  for (const name of characterNames) {
    const key = normalizeKey(name);
    lookup.set(key, { canonicalName: name, type: "character" });
  }

  for (const entity of knownEntities) {
    lookup.set(normalizeKey(entity.name), { canonicalName: entity.name, type: entity.entityType });
    for (const alias of entity.aliases) {
      lookup.set(normalizeKey(alias), { canonicalName: entity.name, type: entity.entityType });
    }
  }

  for (const alias of descriptionAliases) {
    const key = normalizeKey(alias.alias);
    if (lookup.has(key)) continue;
    const canonicalKey = normalizeKey(alias.canonicalName);
    const known = lookup.get(canonicalKey);
    lookup.set(key, { canonicalName: alias.canonicalName, type: known?.type ?? "character" });
  }

  return lookup;
}

function getDistinctRelationshipCount(
  name: string,
  relationships: Array<ExtractedRelationship & { confidence?: number }>,
): number {
  const related = new Set<string>();
  for (const rel of relationships) {
    if (normalizeKey(rel.source) === normalizeKey(name)) related.add(normalizeKey(rel.target));
    if (normalizeKey(rel.target) === normalizeKey(name)) related.add(normalizeKey(rel.source));
  }
  return related.size;
}

function scoreFactionCandidate(
  name: string,
  contexts: string[],
  relationships: Array<ExtractedRelationship & { confidence?: number }>,
): number {
  let score = 0;
  if (FACTION_NAME_RE.test(name)) score += 0.35;
  if (hasFactionMembershipSignal(name, contexts)) score += 0.3;
  if (hasFactionAssetSignal(name, contexts)) score += 0.2;
  if (getDistinctRelationshipCount(name, relationships) >= 2) score += 0.15;
  if (hasNegativeCharacterSignal(name, contexts)) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

function scoreEventCandidate(name: string, contexts: string[]): number {
  let score = 0;
  if (EVENT_HEAD_RE.test(name)) score += 0.4;
  if (hasEventTemporalSignal(name, contexts)) score += 0.35;
  const repeatedTemporalSupport = countMatchingContexts(contexts, (context) => EVENT_TEMPORAL_RE.test(context));
  if (repeatedTemporalSupport >= 2) score += 0.1;
  if (hasNegativeCharacterSignal(name, contexts)) score -= 0.35;
  return Math.max(0, Math.min(1, score));
}

function mergeMentionRole(current: MentionRole, next?: MentionRole): MentionRole {
  if (!next) return current;
  if (current === "subject" || next === "subject") return "subject";
  if (current === "object" || next === "object") return "object";
  if (current === "referenced" || next === "referenced") return "referenced";
  return current;
}

function createCanonicalEntity(
  canonicalName: string,
  knownTypeLookup: Map<string, { canonicalName: string; type: EntityType }>,
): RefinedEntity {
  const known = knownTypeLookup.get(normalizeKey(canonicalName));
  return {
    name: known?.canonicalName ?? canonicalName,
    type: known?.type ?? "character",
    aliases: [],
    confidence: known?.type === "character" ? 0.9 : 0.82,
    mentionRole: "present",
  };
}

export function refineHeuristicDetections(input: RefinerInput): RefinerOutput {
  const descriptionAliases = dedupeAliases(input.descriptionAliases ?? []);
  const knownTypeLookup = buildKnownTypeLookup(input.knownEntities, input.characterNames, descriptionAliases);
  const entities = new Map<string, RefinedEntity>();

  for (const entity of input.entities) {
    const key = normalizeKey(entity.name);
    const known = knownTypeLookup.get(key);
    entities.set(key, {
      name: known?.canonicalName ?? entity.name,
      type: known?.type ?? entity.type,
      aliases: [...entity.aliases],
      confidence: entity.confidence,
      mentionRole: entity.mentionRole ?? entity.role ?? "present",
      provisional: entity.provisional,
    });
  }

  const refinedAliases = dedupeAliases([...descriptionAliases, ...input.aliases]);

  for (const alias of refinedAliases) {
    const aliasKey = normalizeKey(alias.alias);
    const canonicalKey = normalizeKey(alias.canonicalName);
    if (!aliasKey || !canonicalKey || aliasKey === canonicalKey) continue;

    const aliasContexts = collectMentionContexts(input.content, alias.alias);
    const aliasFactionScore = scoreFactionCandidate(alias.alias, aliasContexts, input.relationships);
    const aliasEventScore = scoreEventCandidate(alias.alias, aliasContexts);
    if (Math.max(aliasFactionScore, aliasEventScore) >= 0.8) continue;

    const canonicalEntity = entities.get(canonicalKey) ?? createCanonicalEntity(alias.canonicalName, knownTypeLookup);
    const aliasEntity = entities.get(aliasKey);
    canonicalEntity.mentionRole = mergeMentionRole(canonicalEntity.mentionRole, aliasEntity?.mentionRole);
    canonicalEntity.confidence = Math.max(canonicalEntity.confidence, aliasEntity?.confidence ?? 0.82);
    if (!canonicalEntity.aliases.some((value) => value.toLowerCase() === alias.alias.toLowerCase())) {
      canonicalEntity.aliases.push(alias.alias);
    }
    entities.set(canonicalKey, canonicalEntity);

    if (aliasEntity) {
      canonicalEntity.mentionRole = mergeMentionRole(canonicalEntity.mentionRole, aliasEntity.mentionRole);
      canonicalEntity.confidence = Math.max(canonicalEntity.confidence, aliasEntity.confidence);
      entities.delete(aliasKey);
    }
  }

  const refinedRelationships = canonicalizeRelationships(input.relationships, refinedAliases);

  for (const [key, entity] of entities) {
    const known = knownTypeLookup.get(key);
    if (known) {
      entity.name = known.canonicalName;
      entity.type = known.type;
      entity.confidence = Math.max(entity.confidence, known.type === "character" ? 0.9 : 0.82);
      continue;
    }

    const contexts = collectMentionContexts(input.content, entity.name);
    if (contexts.length === 0) continue;

    const factionScore = scoreFactionCandidate(entity.name, contexts, refinedRelationships);
    const eventScore = scoreEventCandidate(entity.name, contexts);

    if (factionScore >= 0.75 && factionScore >= eventScore + 0.1) {
      entity.type = "faction";
      entity.confidence = Math.max(entity.confidence, 0.82);
      continue;
    }

    if (eventScore >= 0.75 && eventScore >= factionScore + 0.1) {
      entity.type = "event";
      entity.confidence = Math.max(entity.confidence, 0.8);
      continue;
    }

    if (entity.type === "faction" && factionScore < 0.35) {
      entity.type = "concept";
      entity.confidence = Math.min(entity.confidence, 0.55);
      continue;
    }

    if (entity.type === "event" && eventScore < 0.35) {
      entity.type = "concept";
      entity.confidence = Math.min(entity.confidence, 0.55);
    }
  }

  return {
    entities: [...entities.values()],
    relationships: refinedRelationships,
    aliases: refinedAliases,
  };
}
