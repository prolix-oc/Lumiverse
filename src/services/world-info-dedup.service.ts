import type { WorldBookEntry } from "../types/world-book";

type BookSource = "character" | "persona" | "chat" | "global";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DedupRemovalRecord {
  removedEntryId: string;
  removedEntryComment: string;
  removedEntryBookId: string;
  keptEntryId: string;
  keptEntryComment: string;
  keptEntryBookId: string;
  tier: "exact" | "near-exact" | "fuzzy";
  similarity?: number;
}

export interface DeduplicationResult {
  entries: WorldBookEntry[];
  removed: DedupRemovalRecord[];
}

type SourceMap = Map<string, { source: "keyword" | "vector"; score?: number }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FUZZY_THRESHOLD = 0.85;
const MIN_CONTENT_LENGTH_FOR_FUZZY = 30;

const SOURCE_PRECEDENCE: Record<string, number> = {
  character: 4,
  persona: 3,
  chat: 2,
  global: 1,
};

const PUNCTUATION_PATTERN = /[^\w\s]/g;
const WHITESPACE_PATTERN = /\s+/g;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Content-level deduplication for activated world info entries.
 *
 * Runs three tiers (exact → near-exact → fuzzy) scoped within each position
 * group. Entries at different positions are never considered duplicates.
 *
 * Constant entries are never removed.
 */
export function deduplicateWorldInfoEntries(
  entries: WorldBookEntry[],
  sources: SourceMap,
  bookSourceMap?: Map<string, BookSource>,
): DeduplicationResult {
  if (entries.length <= 1) return { entries: [...entries], removed: [] };

  // Partition by position — dedup only within same position
  const byPosition = new Map<number, WorldBookEntry[]>();
  for (const e of entries) {
    const pos = e.position;
    const list = byPosition.get(pos);
    if (list) list.push(e);
    else byPosition.set(pos, [e]);
  }

  const removed: DedupRemovalRecord[] = [];
  const survivorIds = new Set<string>();

  for (const [, group] of byPosition) {
    if (group.length <= 1) {
      for (const e of group) survivorIds.add(e.id);
      continue;
    }

    const removedInGroup = new Set<string>();

    // Tier 1: exact content match
    runTierExact(group, removedInGroup, removed, sources, bookSourceMap);

    // Tier 2: normalized content match
    runTierNearExact(group, removedInGroup, removed, sources, bookSourceMap);

    // Tier 3: fuzzy Jaccard similarity
    runTierFuzzy(group, removedInGroup, removed, sources, bookSourceMap);

    for (const e of group) {
      if (!removedInGroup.has(e.id)) survivorIds.add(e.id);
    }
  }

  return {
    entries: entries.filter(e => survivorIds.has(e.id)),
    removed,
  };
}

// ---------------------------------------------------------------------------
// Tier 1: Exact content match
// ---------------------------------------------------------------------------

function runTierExact(
  group: WorldBookEntry[],
  removedIds: Set<string>,
  removed: DedupRemovalRecord[],
  sources: SourceMap,
  bookSourceMap?: Map<string, BookSource>,
): void {
  const byContent = new Map<string, WorldBookEntry[]>();
  for (const e of group) {
    if (removedIds.has(e.id)) continue;
    if (!e.content || !e.content.trim()) continue;
    const key = e.content;
    const list = byContent.get(key);
    if (list) list.push(e);
    else byContent.set(key, [e]);
  }

  for (const [, dupes] of byContent) {
    if (dupes.length <= 1) continue;
    resolveDuplicates(dupes, "exact", undefined, removedIds, removed, sources, bookSourceMap);
  }
}

// ---------------------------------------------------------------------------
// Tier 2: Normalized content match
// ---------------------------------------------------------------------------

function runTierNearExact(
  group: WorldBookEntry[],
  removedIds: Set<string>,
  removed: DedupRemovalRecord[],
  sources: SourceMap,
  bookSourceMap?: Map<string, BookSource>,
): void {
  const byNormalized = new Map<string, WorldBookEntry[]>();
  for (const e of group) {
    if (removedIds.has(e.id)) continue;
    if (!e.content || !e.content.trim()) continue;
    const key = normalizeContent(e.content);
    if (!key) continue;
    const list = byNormalized.get(key);
    if (list) list.push(e);
    else byNormalized.set(key, [e]);
  }

  for (const [, dupes] of byNormalized) {
    if (dupes.length <= 1) continue;
    resolveDuplicates(dupes, "near-exact", undefined, removedIds, removed, sources, bookSourceMap);
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Fuzzy Jaccard similarity
// ---------------------------------------------------------------------------

function runTierFuzzy(
  group: WorldBookEntry[],
  removedIds: Set<string>,
  removed: DedupRemovalRecord[],
  sources: SourceMap,
  bookSourceMap?: Map<string, BookSource>,
): void {
  // Build token sets for eligible entries
  const eligible: Array<{ entry: WorldBookEntry; tokens: Set<string> }> = [];
  for (const e of group) {
    if (removedIds.has(e.id)) continue;
    if (!e.content || e.content.length < MIN_CONTENT_LENGTH_FOR_FUZZY) continue;
    eligible.push({ entry: e, tokens: buildTokenSet(normalizeContent(e.content)) });
  }

  for (let i = 0; i < eligible.length; i++) {
    if (removedIds.has(eligible[i].entry.id)) continue;
    for (let j = i + 1; j < eligible.length; j++) {
      if (removedIds.has(eligible[j].entry.id)) continue;

      const sim = jaccardSimilarity(eligible[i].tokens, eligible[j].tokens);
      if (sim < FUZZY_THRESHOLD) continue;

      const a = eligible[i].entry;
      const b = eligible[j].entry;

      // Skip if both are constants
      if (a.constant && b.constant) continue;

      const cmp = compareEntryPrecedence(a, b, sources, bookSourceMap);
      const winner = cmp <= 0 ? a : b;
      const loser = cmp <= 0 ? b : a;

      // Never remove constants
      if (loser.constant) continue;

      removedIds.add(loser.id);
      removed.push({
        removedEntryId: loser.id,
        removedEntryComment: loser.comment || "",
        removedEntryBookId: loser.world_book_id,
        keptEntryId: winner.id,
        keptEntryComment: winner.comment || "",
        keptEntryBookId: winner.world_book_id,
        tier: "fuzzy",
        similarity: sim,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

/**
 * Given a set of duplicate entries, keep the winner and mark the rest as removed.
 * Constants are never removed.
 */
function resolveDuplicates(
  dupes: WorldBookEntry[],
  tier: "exact" | "near-exact",
  similarity: number | undefined,
  removedIds: Set<string>,
  removed: DedupRemovalRecord[],
  sources: SourceMap,
  bookSourceMap?: Map<string, BookSource>,
): void {
  // Sort by precedence — best first
  const sorted = [...dupes].sort((a, b) => compareEntryPrecedence(a, b, sources, bookSourceMap));
  const winner = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const loser = sorted[i];
    // Never remove constants
    if (loser.constant) continue;
    // If both are constants, skip (already handled above but defensive)
    if (winner.constant && loser.constant) continue;

    removedIds.add(loser.id);
    removed.push({
      removedEntryId: loser.id,
      removedEntryComment: loser.comment || "",
      removedEntryBookId: loser.world_book_id,
      keptEntryId: winner.id,
      keptEntryComment: winner.comment || "",
      keptEntryBookId: winner.world_book_id,
      tier,
      similarity,
    });
  }
}

// ---------------------------------------------------------------------------
// Precedence comparison
// ---------------------------------------------------------------------------

/**
 * Compare two entries for precedence. Returns negative if `a` wins, positive
 * if `b` wins, zero if tied.
 */
function compareEntryPrecedence(
  a: WorldBookEntry,
  b: WorldBookEntry,
  sources: SourceMap,
  bookSourceMap?: Map<string, BookSource>,
): number {
  // Constants always win over non-constants
  if (a.constant && !b.constant) return -1;
  if (!a.constant && b.constant) return 1;

  // Higher priority wins
  if (b.priority !== a.priority) return b.priority - a.priority;

  // Higher book source precedence wins
  if (bookSourceMap) {
    const aSrc = SOURCE_PRECEDENCE[bookSourceMap.get(a.world_book_id) ?? ""] ?? 0;
    const bSrc = SOURCE_PRECEDENCE[bookSourceMap.get(b.world_book_id) ?? ""] ?? 0;
    if (bSrc !== aSrc) return bSrc - aSrc;
  }

  // Keyword activation beats vector
  const aSource = sources.get(a.id)?.source;
  const bSource = sources.get(b.id)?.source;
  if (aSource === "keyword" && bSource !== "keyword") return -1;
  if (bSource === "keyword" && aSource !== "keyword") return 1;

  // Stable: first in array wins (return 0 preserves sort stability)
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeContent(s: string): string {
  return s
    .toLowerCase()
    .replace(PUNCTUATION_PATTERN, "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

function buildTokenSet(normalized: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (token.length >= 2) tokens.add(token);
  }
  return tokens;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
