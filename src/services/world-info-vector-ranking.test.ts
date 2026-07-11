import { describe, expect, test } from "bun:test";
import type { WorldBookEntry } from "../types/world-book";
import { normalizeBm25Scores } from "./embeddings.service";
import {
  buildWorldInfoLexicalQueryBatches,
  rankVectorWorldInfoCandidates,
  type VectorCandidatePoolEntry,
} from "./world-info-vector-ranking";

let entryCounter = 0;
function makeEntry(overrides: Partial<WorldBookEntry>): WorldBookEntry {
  entryCounter += 1;
  return {
    id: overrides.id ?? `entry-${entryCounter}`,
    world_book_id: "book-a",
    uid: overrides.uid ?? `uid-${entryCounter}`,
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content: `Synthetic lore ${entryCounter}`,
    comment: "",
    position: 0,
    depth: 4,
    role: null,
    order_value: 100,
    selective: false,
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
    prevent_recursion: false,
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

function candidate(
  entry: WorldBookEntry,
  distance: number,
  lexicalScore: number,
  lexicalStrength: number,
): VectorCandidatePoolEntry {
  return {
    entry,
    candidate: {
      entry_id: entry.id,
      distance,
      lexical_score: lexicalScore,
      lexical_strength: lexicalStrength,
      content: entry.content,
      searchTextPreview: entry.content,
      metadata: { comment: entry.comment },
    },
  };
}

describe("normalizeBm25Scores", () => {
  test("is bounded and exactly invariant under uniform positive scaling", () => {
    const scores = [1, 1.5, 2.5, 4, 8, 16, null, 0];
    const base = normalizeBm25Scores(scores);
    const scaled = normalizeBm25Scores(
      scores.map((score) => (typeof score === "number" ? score * 97 : score)),
    );

    expect(base.every((value) => value >= 0 && value <= 1)).toBe(true);
    base.forEach((value, index) => expect(scaled[index]).toBeCloseTo(value, 12));
    expect(base.at(-2)).toBe(0);
    expect(base.at(-1)).toBe(0);
  });

  test("keeps existing ordering stable under isolated extreme outliers", () => {
    const scores = [1, 1.4, 2, 2.8, 4, 5.6, 8, 11.2, 16, 22.4, 32, 44.8];
    const base = normalizeBm25Scores(scores);
    const withOutliers = normalizeBm25Scores([1e-12, ...scores, 1e12]).slice(1, -1);

    for (let index = 1; index < withOutliers.length; index += 1) {
      expect(withOutliers[index]).toBeGreaterThan(withOutliers[index - 1]);
    }
    base.forEach((value, index) => {
      expect(Math.abs(withOutliers[index] - value)).toBeLessThanOrEqual(0.05);
    });
  });
});

describe("buildWorldInfoLexicalQueryBatches", () => {
  test("packs sanitized anchors before topical terms without truncating them", () => {
    const entries = [
      makeEntry({ comment: 'Aster (OR) "Vale"' }),
      makeEntry({ comment: "Mira Sol" }),
      makeEntry({ key: ["Council:Founders"], comment: "Founders Accord" }),
    ];
    const query = `${"old scenery ".repeat(20)} Aster Vale met Mira Sol and Council Founders. `
      + `Recent topic: succession, schism, reconciliation, observatory.`;
    const batches = buildWorldInfoLexicalQueryBatches(query, entries, 28);
    const combined = batches.map((batch) => batch.text).join(" ");

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.text.length <= 28)).toBe(true);
    for (const anchor of ["aster", "vale", "mira", "sol", "council", "founders"]) {
      expect(combined.split(" ")).toContain(anchor);
    }
    expect(combined).not.toMatch(/["():*\\]/);
    expect(combined.split(" ")).not.toContain("or");
    expect(combined.indexOf("founders")).toBeLessThan(combined.indexOf("observatory"));
  });
});

describe("per-mention canonical ownership", () => {
  test("gates only mention bonuses while preserving independent relevance", () => {
    const arden = makeEntry({ comment: "Arden Vale", content: "Arden chairs the expedition." });
    const residence = makeEntry({ comment: "Vale Residence", content: "A private house near the observatory." });
    const mira = makeEntry({ comment: "Mira Sol", content: "Mira is the expedition navigator." });
    const affection = makeEntry({ comment: '"Darling" (Mira Affection)', content: "A nickname Mira sometimes uses." });
    const generic = makeEntry({ comment: "Spirit Protocol", content: "A broad emergency protocol." });
    const aiName = makeEntry({ comment: "Ai Rowan", content: "Ai is an unrelated student." });
    const support = makeEntry({ comment: "Founders Accord", content: "The founders split after the succession schism." });
    const entries = [arden, residence, mira, affection, generic, aiName, support];
    const pooled = [
      candidate(arden, 0.44, 30, 0.7),
      candidate(residence, 0.31, 80, 0.8),
      candidate(mira, 0.39, 35, 0.72),
      candidate(affection, 0.67, 60, 0.76),
      candidate(generic, 0.58, 55, 0.7),
      candidate(aiName, 0.64, 58, 0.72),
      candidate(support, 0.28, 22, 0.62),
    ];
    const result = rankVectorWorldInfoCandidates({
      eligibleEntries: entries,
      pooledCandidates: pooled,
      queryText: "Arden Vale briefed Mira and the ship AI about spirits and the founders' succession schism.",
      hybridWeightMode: "balanced",
      similarityThreshold: 0,
      rerankCutoff: 0,
      topK: 20,
    });
    const byName = new Map(result.shortlistedEntries.map((item) => [item.entry.comment, item]));

    expect(byName.get("Arden Vale")!.scoreBreakdown.commentExact).toBeGreaterThan(0);
    expect(byName.get("Vale Residence")!.scoreBreakdown.commentPartial).toBe(0);
    expect(byName.get("Vale Residence")!.scoreBreakdown.focusBoost).toBe(0);
    expect(byName.get("Mira Sol")!.scoreBreakdown.commentPartial).toBeGreaterThan(0);
    expect(byName.get('"Darling" (Mira Affection)')!.scoreBreakdown.commentPartial).toBe(0);
    expect(byName.get("Spirit Protocol")!.scoreBreakdown.commentPartial).toBe(0);
    expect(byName.get("Spirit Protocol")!.scoreBreakdown.focusBoost).toBe(0);
    expect(byName.get("Ai Rowan")!.scoreBreakdown.commentPartial).toBe(0);

    // Non-owners still retain ordinary vector and independent lexical evidence.
    expect(byName.get("Vale Residence")!.scoreBreakdown.vectorSimilarity).toBeGreaterThan(0);
    expect(byName.get("Vale Residence")!.scoreBreakdown.lexicalContentBoost).toBeGreaterThan(0);
    expect(byName.get("Founders Accord")!.scoreBreakdown.vectorSimilarity).toBeGreaterThan(0);
    expect(byName.get("Founders Accord")!.finalScore).toBeGreaterThan(
      byName.get('"Darling" (Mira Affection)')!.finalScore,
    );

    const weakestRelevant = Math.min(
      byName.get("Arden Vale")!.finalScore,
      byName.get("Mira Sol")!.finalScore,
      byName.get("Founders Accord")!.finalScore,
    );
    const strongestAssociative = Math.max(
      byName.get("Vale Residence")!.finalScore,
      byName.get('"Darling" (Mira Affection)')!.finalScore,
      byName.get("Spirit Protocol")!.finalScore,
      byName.get("Ai Rowan")!.finalScore,
    );
    expect(weakestRelevant).toBeGreaterThan(strongestAssociative);
  });
});
