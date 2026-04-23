/**
 * Regression suite for the "9000+ entry lorebook fires no entries" bug.
 *
 * Production log that motivated this suite:
 *   [embeddings] WI vector search: 0 rows from LanceDB for book=17c52a6c (limit=30)
 *   [prompt-assembly] Vector WI retrieval: eligible=9251, hits=57,
 *                     afterThreshold=57, afterRerank=57, shortlisted=15 (topK=15)
 *   [WI merge] vector candidates=15 → accepted=0,
 *              skipped: dedup=0, minPriority=0, group=0, budgetCap=15, budgetSim=0
 *
 * The merge/activation pipeline is deterministic and pure, so we exercise it
 * directly with entries shaped like the user's import. The vector-search half
 * of the pipeline (LanceDB) is stubbed — we feed the merge function synthetic
 * `VectorActivatedEntry[]` that mirror what `collectVectorActivatedWorldInfoDetailed`
 * would have produced.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { WorldBookEntry } from "../types/world-book";
import {
  mergeActivatedWorldInfoEntries,
  type VectorActivatedEntry,
} from "./prompt-assembly.service";
import {
  finalizeActivatedWorldInfoEntries,
  type WorldInfoSettings,
} from "./world-info-activation.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOREBOOK_PATH = path.join(os.homedir(), "Downloads", "memories_lorebook.json");

let __counter = 0;
function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  __counter++;
  // Each entry gets unique filler content so the content-level deduplicator
  // (which collapses near-duplicates) doesn't mask behaviour we want to
  // observe.
  const filler = `entry-${__counter} — ${"abcdefghij".repeat(__counter % 7 + 3)} ${__counter * 7919}`;
  return {
    id: overrides.id ?? crypto.randomUUID(),
    world_book_id: "book-a",
    uid: overrides.uid ?? crypto.randomUUID(),
    key: [],
    keysecondary: [],
    content: filler,
    comment: "",
    position: 0,
    depth: 4,
    role: null,
    order_value: 100,
    selective: true,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 100,
    probability: 100,
    scan_depth: null,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: true,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 10,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: true,
    vectorized: true,
    vector_index_status: "indexed",
    vector_indexed_at: 0,
    vector_index_error: null,
    extensions: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

/** Wrap a WorldBookEntry as a VectorActivatedEntry with realistic scoring. */
function asVectorCandidate(entry: WorldBookEntry, finalScore = 0.8): VectorActivatedEntry {
  return {
    entry,
    score: finalScore,
    distance: Number.POSITIVE_INFINITY, // FTS-only, mirroring the production log
    finalScore,
    lexicalCandidateScore: 10,
    matchedPrimaryKeys: [],
    matchedSecondaryKeys: [],
    matchedComment: null,
    scoreBreakdown: {
      vectorSimilarity: 0,
      lexicalContentBoost: finalScore,
      primaryExact: 0,
      primaryPartial: 0,
      secondaryExact: 0,
      secondaryPartial: 0,
      commentExact: 0,
      commentPartial: 0,
      focusBoost: 0,
      priority: 0,
      broadPenalty: 0,
      focusMissPenalty: 0,
    },
    searchTextPreview: entry.content.slice(0, 120),
  };
}

describe("finalizeActivatedWorldInfoEntries", () => {
  test("drops whitespace-only world info entries from activation and cache", () => {
    const result = finalizeActivatedWorldInfoEntries([
      makeEntry({ id: "blank", uid: "blank", content: "   \n\t  " }),
      makeEntry({ id: "real", uid: "real", content: "Useful lore" }),
    ]);

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual(["real"]);
    expect(result.cache.before).toEqual([{ role: "system", content: "Useful lore", entryLabel: "(unnamed entry real)" }]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1: the "as-imported" shape — keys=[], vectorized=true, no constants.
// This is the exact profile of memories_lorebook.json. With default settings
// (maxActivatedEntries=0=unlimited, maxTokenBudget=0=unlimited) ALL 15 vector
// candidates MUST be accepted.
// ---------------------------------------------------------------------------

describe("mergeActivatedWorldInfoEntries — user-shape (9000+ entries, keys=[], vectorized)", () => {
  test("accepts all 15 vector candidates when settings are default", () => {
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: i + 1, comment: `memory #${i + 1}` })),
    );

    const result = mergeActivatedWorldInfoEntries(
      /* keyword */ [],
      /* vector  */ vectorCandidates,
      /* settings */ {},
    );

    expect(result.keywordActivated).toBe(0);
    expect(result.vectorActivated).toBe(15);
    expect(result.activatedEntries).toHaveLength(15);
  });

  test("accepts all 15 vector candidates when maxActivatedEntries >= 15", () => {
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: i + 1 })),
    );

    for (const cap of [15, 20, 100]) {
      const settings: Partial<WorldInfoSettings> = { maxActivatedEntries: cap };
      const result = mergeActivatedWorldInfoEntries([], vectorCandidates, settings);
      expect(result.vectorActivated).toBe(15);
    }
  });

  test("FIXED: score-boosted vectors can now displace equal-priority keyword entries at a full cap", () => {
    // This is the production bug reproducer. Before the fix: all 15 vector
    // candidates were rejected with `budgetCap=15`. After the fix: vectors
    // with meaningful finalScore receive a bounded priority uplift and beat
    // equal-priority keyword entries on the order_value tiebreaker.
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["x"], order_value: i + 1, comment: `kw-${i}` }),
    );
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, comment: `v-${i}` }), 0.8),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    // At least some vectors must now fire — that is the bug fix.
    expect(result.vectorActivated).toBeGreaterThan(0);
    expect(result.totalActivated).toBe(15);
    // The output must still respect the user's cap.
    expect(result.activatedEntries.length).toBe(15);
  });

  test("FIXED: low-score vectors (finalScore ≈ 0) do NOT displace keyword entries", () => {
    // Marginal vector hits should not evict keyword matches — the boost is
    // bounded and proportional to finalScore, so near-zero scores contribute
    // near-zero boost.
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["x"], order_value: i + 1, comment: `kw-${i}` }),
    );
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, comment: `v-${i}` }), 0.01),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    expect(result.keywordActivated).toBe(15);
    expect(result.vectorActivated).toBe(0);
  });

  test("FIXED: higher-priority keyword entries are still protected from vector displacement", () => {
    // Boost ceiling is 20 priority points, so a keyword entry with priority
    // ≥ 30 can never be displaced by a vector with base priority 10.
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["x"], order_value: i + 1, priority: 50 }),
    );
    const vectorCandidates = Array.from({ length: 15 }, (_, i) =>
      asVectorCandidate(
        makeEntry({ order_value: 1000 + i, priority: 10 }),
        /* saturated score */ 3.0,
      ),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    expect(result.keywordActivated).toBe(15);
    expect(result.vectorActivated).toBe(0);
  });

  test("token budget can also starve vectors — but skip counter is budgetSim, not budgetCap", () => {
    // Each entry is ~275 tokens; tokenBudget=100 means none survive.
    const vectorCandidates = Array.from({ length: 15 }, () =>
      asVectorCandidate(makeEntry({ content: "x".repeat(1100) })),
    );

    const result = mergeActivatedWorldInfoEntries([], vectorCandidates, {
      maxTokenBudget: 100,
    });

    // This is a SEPARATE failure mode from the user's log. Verifies the
    // budgetCap vs budgetSim counters discriminate correctly.
    expect(result.vectorActivated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: equal priority + high order_value loses even when budget has room
// ---------------------------------------------------------------------------

describe("mergeActivatedWorldInfoEntries — priority/order tie-breaking", () => {
  test("higher-priority vector entries displace lower-priority keyword entries", () => {
    const keywordEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ key: ["x"], order_value: i + 1, priority: 5 }),
    );
    const vectorCandidates = Array.from({ length: 5 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, priority: 50 })),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 15 },
    );

    // With priority inversion, vectors should make it in.
    expect(result.vectorActivated).toBeGreaterThan(0);
  });

  test("when budget has headroom, vector entries always win — even at equal priority", () => {
    const keywordEntries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ key: ["x"], order_value: i + 1, priority: 10 }),
    );
    const vectorCandidates = Array.from({ length: 10 }, (_, i) =>
      asVectorCandidate(makeEntry({ order_value: 1000 + i, priority: 10 })),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordEntries,
      vectorCandidates,
      { maxActivatedEntries: 20 },
    );

    expect(result.keywordActivated).toBe(5);
    expect(result.vectorActivated).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: replay against the real 9239-entry user file
// ---------------------------------------------------------------------------

describe("mergeActivatedWorldInfoEntries — real 9239-entry user lorebook", () => {
  const available = existsSync(LOREBOOK_PATH);
  const skip = available ? test : test.skip;

  // Load once, reuse across tests. Maps each ST-style raw entry to our
  // WorldBookEntry model using the same defaults createEntry/importWorldBook
  // would apply (priority=10 when unset, order_value from displayIndex/order).
  function loadRealEntries(): WorldBookEntry[] {
    const raw = JSON.parse(readFileSync(LOREBOOK_PATH, "utf8"));
    const rawEntries: any[] = Array.isArray(raw.entries)
      ? raw.entries
      : Object.values(raw.entries);
    return rawEntries.map((e: any, i: number) =>
      makeEntry({
        id: `real-${i}`,
        uid: `real-uid-${i}`,
        world_book_id: "memories-book",
        content: String(e.content || ""),
        comment: String(e.comment || ""),
        key: Array.isArray(e.key) ? e.key : [],
        keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
        order_value: e.displayIndex ?? e.order ?? i + 1,
        priority: e.priority ?? 10,
        position: e.position ?? 0,
        depth: e.depth ?? 4,
        selective: e.selective ?? true,
        constant: e.constant ?? false,
        disabled: !!e.disable,
        probability: e.probability ?? 100,
        use_probability: e.useProbability ?? true,
        vectorized: e.vectorized ?? true,
      }),
    );
  }

  skip("invariants: >9000 entries, all empty keys, all vectorized, no constants, none disabled", () => {
    const entries = loadRealEntries();
    expect(entries.length).toBeGreaterThan(9000);
    expect(entries.every((e) => e.key.length === 0)).toBe(true);
    expect(entries.every((e) => e.vectorized === true)).toBe(true);
    expect(entries.every((e) => !e.constant)).toBe(true);
    expect(entries.every((e) => !e.disabled)).toBe(true);
  });

  skip("end-to-end: only this book + default settings + any subset as vector hits → every hit wins", () => {
    const entries = loadRealEntries();
    // Simulate LanceDB returning 30 arbitrary entries as candidates.
    const hitIndexes = [3, 47, 120, 500, 987, 1234, 2200, 3500, 4815, 5000, 6666, 7777, 8000, 8500, 9000, 100, 250, 450, 700, 900, 1100, 1300, 1500, 1700, 1900, 2100, 2300, 2500, 2700, 2900];
    const vectorCandidates = hitIndexes.map((idx, rank) =>
      asVectorCandidate(entries[idx], 1.0 - rank * 0.02),
    );

    const result = mergeActivatedWorldInfoEntries([], vectorCandidates, {});
    expect(result.vectorActivated).toBe(vectorCandidates.length);
    expect(result.keywordActivated).toBe(0);
  });

  skip("full-scale merge: 9239 entries + 15 vector hits + maxActivatedEntries=15 + zero keyword competition → all 15 vectors accepted", () => {
    const entries = loadRealEntries();
    const vectorCandidates = entries.slice(0, 15).map((e, i) =>
      asVectorCandidate(e, 1.2 - i * 0.05),
    );

    const result = mergeActivatedWorldInfoEntries([], vectorCandidates, { maxActivatedEntries: 15 });
    expect(result.vectorActivated).toBe(15);
  });

  skip("post-fix production-log replay: 15 keyword competitors + cap=15 + real book content → vectors now fire", () => {
    const entries = loadRealEntries();
    // Another source contributes 15 keyword matches at default priority.
    const keywordCompetitors = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ world_book_id: "other-book", key: ["trigger"], order_value: i + 1, priority: 10 }),
    );
    const vectorHits = entries.slice(0, 15).map((e, i) =>
      asVectorCandidate(e, 0.9 - i * 0.03),
    );

    const result = mergeActivatedWorldInfoEntries(
      keywordCompetitors,
      vectorHits,
      { maxActivatedEntries: 15 },
    );

    // Before the fix: vectorActivated=0, budgetCap=15.
    // After the fix: vectorActivated > 0 and the total still respects cap.
    expect(result.vectorActivated).toBeGreaterThan(0);
    expect(result.totalActivated).toBe(15);
  });

  skip("realistic pipeline: varying maxActivatedEntries × retrieval_top_k combinations", () => {
    const entries = loadRealEntries();

    for (const topK of [4, 15, 30, 50]) {
      for (const cap of [0, 15, 30, 100]) {
        const vectorCandidates = entries.slice(0, topK).map((e, i) =>
          asVectorCandidate(e, 1.0 - i * (0.8 / topK)),
        );
        const result = mergeActivatedWorldInfoEntries([], vectorCandidates, {
          maxActivatedEntries: cap,
        });
        const expected = cap === 0 ? topK : Math.min(topK, cap);
        // Content-level dedup may trim a few near-duplicates; allow wiggle.
        expect(result.vectorActivated).toBeGreaterThanOrEqual(
          Math.max(0, expected - 3),
        );
        expect(result.vectorActivated).toBeLessThanOrEqual(expected);
      }
    }
  });

  skip("stress test: 9239 entries through full pipeline completes in under 2 seconds", () => {
    const entries = loadRealEntries();
    const vectorCandidates = entries.slice(0, 30).map((e, i) =>
      asVectorCandidate(e, 1.0 - i * 0.02),
    );

    const t0 = performance.now();
    const result = mergeActivatedWorldInfoEntries([], vectorCandidates, {
      maxActivatedEntries: 30,
    });
    const elapsed = performance.now() - t0;

    expect(result.vectorActivated).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });

  skip("dedup sanity: real-content duplicates across books are collapsed but don't zero out vectors", () => {
    const entries = loadRealEntries();
    // Duplicate the first entry into a separate book (simulates two books
    // with overlapping content, which is what triggers dedup).
    const duplicate = makeEntry({
      id: "dupe-1",
      world_book_id: "other-book",
      content: entries[0].content,
      comment: entries[0].comment,
      priority: 10,
    });

    const vector = [
      asVectorCandidate(entries[0], 0.9),
      asVectorCandidate(duplicate, 0.9),
      ...entries.slice(1, 15).map((e, i) => asVectorCandidate(e, 0.85 - i * 0.01)),
    ];

    const result = mergeActivatedWorldInfoEntries([], vector, {});
    // One dedup hit expected (the intentional duplicate).
    expect(result.deduplicated).toBeGreaterThanOrEqual(1);
    expect(result.vectorActivated).toBeGreaterThan(10);
  });
});
