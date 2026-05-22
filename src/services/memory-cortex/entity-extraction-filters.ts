import type { EntityType, ExtractedEntity, MentionRole } from "./types";

export interface MemoryEntityTypeFilterConfig {
  protectedTerms: string[];
  rejectedTerms: string[];
  cleanupPatterns: string[];
}

export type MemoryEntityExtractionFilters = Record<EntityType, MemoryEntityTypeFilterConfig>;

export const ENTITY_FILTER_TYPES: EntityType[] = [
  "character",
  "location",
  "item",
  "faction",
  "concept",
  "event",
];

function createEmptyFilterConfig(): MemoryEntityTypeFilterConfig {
  return {
    protectedTerms: [],
    rejectedTerms: [],
    cleanupPatterns: [],
  };
}

export function getDefaultEntityExtractionFilters(): MemoryEntityExtractionFilters {
  return {
    character: createEmptyFilterConfig(),
    location: createEmptyFilterConfig(),
    item: createEmptyFilterConfig(),
    faction: createEmptyFilterConfig(),
    concept: createEmptyFilterConfig(),
    event: createEmptyFilterConfig(),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeEntityExtractionFilters(input?: unknown): MemoryEntityExtractionFilters {
  const defaults = getDefaultEntityExtractionFilters();
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaults;

  const record = input as Partial<Record<EntityType, Partial<MemoryEntityTypeFilterConfig>>>;
  const normalized = {} as MemoryEntityExtractionFilters;

  for (const type of ENTITY_FILTER_TYPES) {
    const value = record[type];
    normalized[type] = {
      protectedTerms: normalizeStringArray(value?.protectedTerms),
      rejectedTerms: normalizeStringArray(value?.rejectedTerms),
      cleanupPatterns: normalizeStringArray(value?.cleanupPatterns),
    };
  }

  return normalized;
}

const regexCache = new Map<string, RegExp | null>();

function parseRegexString(value: string): RegExp | null {
  if (regexCache.has(value)) return regexCache.get(value) ?? null;

  let parsed: RegExp | null = null;
  const match = value.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
  if (match) {
    try {
      parsed = new RegExp(match[1], match[2]);
    } catch {
      parsed = null;
    }
  }

  regexCache.set(value, parsed);
  return parsed;
}

export function matchesFilterTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const parsed = parseRegexString(term);
  if (parsed) return parsed.test(text);
  return text.toLowerCase().includes(term.toLowerCase());
}

function matchesAnyTerm(text: string, terms: string[]): boolean {
  if (!text || terms.length === 0) return false;
  return terms.some((term) => matchesFilterTerm(text, term));
}

export function applyCleanupPatterns(text: string, patterns: string[]): string {
  let cleaned = text;
  for (const pattern of patterns) {
    const parsed = parseRegexString(pattern);
    if (parsed) {
      cleaned = cleaned.replace(parsed, "");
    } else {
      cleaned = cleaned.split(pattern).join("");
    }
  }
  return cleaned;
}

function normalizeProtectedCandidate(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s\[\]{}()|,:;.-]+/, "")
    .replace(/[\s\[\]{}()|,:;.-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlausibleProtectedCandidate(text: string): boolean {
  if (text.length < 2 || text.length > 120) return false;
  if (!/[A-Za-z0-9]/.test(text)) return false;
  if (text.split(/\s+/).length > 16) return false;
  return true;
}

export interface ProtectedLineEntity extends ExtractedEntity {
  mentionRole: MentionRole;
  sourceLine: string;
}

export function buildProtectedLineEntities(
  content: string,
  filters: MemoryEntityExtractionFilters,
): ProtectedLineEntity[] {
  const found = new Map<string, ProtectedLineEntity>();
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    for (const type of ENTITY_FILTER_TYPES) {
      const rule = filters[type];
      if (rule.protectedTerms.length === 0) continue;
      if (!matchesAnyTerm(line, rule.protectedTerms)) continue;
      if (matchesAnyTerm(line, rule.rejectedTerms)) continue;

      const cleaned = normalizeProtectedCandidate(applyCleanupPatterns(line, rule.cleanupPatterns));
      if (!isPlausibleProtectedCandidate(cleaned)) continue;

      const key = `${type}:${cleaned.toLowerCase()}`;
      if (found.has(key)) continue;

      found.set(key, {
        name: cleaned,
        type,
        aliases: [],
        confidence: 0.95,
        mentionRole: "present",
        sourceLine: line,
      });
    }
  }

  return [...found.values()];
}

function findSourceLine(content: string, entityName: string): string | null {
  const lowered = entityName.toLowerCase();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase().includes(lowered)) return line;
  }
  return null;
}

export function filterEntitiesByExtractionFilters<T extends ExtractedEntity>(
  entities: T[],
  content: string,
  filters: MemoryEntityExtractionFilters,
  protectedLineEntities: ProtectedLineEntity[] = buildProtectedLineEntities(content, filters),
): T[] {
  const protectedNamesByLine = new Map<string, Set<string>>();

  for (const entity of protectedLineEntities) {
    const key = entity.sourceLine;
    if (!protectedNamesByLine.has(key)) protectedNamesByLine.set(key, new Set<string>());
    protectedNamesByLine.get(key)!.add(entity.name.toLowerCase());
  }

  const filtered: T[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const sourceLine = findSourceLine(content, entity.name);
    if (sourceLine) {
      const protectedNames = protectedNamesByLine.get(sourceLine);
      if (protectedNames && !protectedNames.has(entity.name.toLowerCase())) continue;
    }

    const rule = filters[entity.type];
    if (matchesAnyTerm(entity.name, rule.rejectedTerms)) continue;
    if (sourceLine && matchesAnyTerm(sourceLine, rule.rejectedTerms)) continue;

    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entity);
  }

  return filtered;
}
