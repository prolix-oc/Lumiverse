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
    folder: "", tags: [],
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
    exclude_greeting: false,
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
    revision: overrides.revision ?? 1,
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

describe("Vector First selection", () => {
  function fixture() {
    const keyword = makeEntry({
      key: ["Silvergate"], comment: "Silvergate",
      content: "Ancient architects built the northern town centuries ago.",
    });
    const semantic = makeEntry({
      comment: "Guard patrols",
      content: "Watch officers keep the central square safe throughout the night.",
    });
    return {
      keyword, semantic,
      input: {
        eligibleEntries: [keyword, semantic],
        pooledCandidates: [candidate(semantic, 0.3, 0, 0)],
        queryText: "Silvergate guards patrol the plaza.",
        hybridWeightMode: "vector_first" as const,
        similarityThreshold: 0, rerankCutoff: 0, topK: 1,
      },
    };
  }

  test("keyword-only rescue cannot consume the vector shortlist with both cutoffs at zero", () => {
    const { keyword, semantic, input } = fixture();
    const result = rankVectorWorldInfoCandidates(input);
    expect(result.shortlistedEntries.map((item) => item.entry.id)).toEqual([semantic.id]);
    expect(result.candidateTrace.some((item) => item.entry.id === keyword.id)).toBe(false);
    expect(result.hitsBeforeThreshold).toBe(1);
    expect(result.thresholdRejected).toBe(0);
    expect(result.rerankRejected).toBe(0);
  });

  test("semantic distance takes precedence over keyword boosts among actual vector hits", () => {
    const { keyword, semantic, input } = fixture();
    const result = rankVectorWorldInfoCandidates({
      ...input,
      pooledCandidates: [candidate(keyword, 0.5, 30, 1), candidate(semantic, 0.3, 0, 0)],
      topK: 2,
    });
    expect(result.shortlistedEntries.map((item) => item.entry.id)).toEqual([semantic.id, keyword.id]);
    // The secondary lexical score is still available for diagnostics and cutoff filtering.
    expect(result.shortlistedEntries[1].finalScore).toBeGreaterThan(result.shortlistedEntries[0].finalScore);
  });

  test("keyword evidence breaks equal-distance ties", () => {
    const { keyword, semantic, input } = fixture();
    const result = rankVectorWorldInfoCandidates({
      ...input,
      pooledCandidates: [candidate(semantic, 0.3, 0, 0), candidate(keyword, 0.3, 30, 1)],
    });
    expect(result.shortlistedEntries[0].entry.id).toBe(keyword.id);
  });

  test("empty vector recall and non-finite distances do not create semantic activations", () => {
    const { keyword, input } = fixture();
    for (const pooledCandidates of [[], [candidate(keyword, Infinity, 30, 1)]]) {
      const result = rankVectorWorldInfoCandidates({ ...input, pooledCandidates });
      expect(result.shortlistedEntries).toHaveLength(0);
      expect(result.hitsBeforeThreshold).toBe(0);
    }
  });

  test("positive cutoffs still filter candidates in Vector First", () => {
    const { semantic, input } = fixture();
    const thresholded = rankVectorWorldInfoCandidates({ ...input, similarityThreshold: 0.2 });
    expect(thresholded.shortlistedEntries).toHaveLength(0);
    expect(thresholded.thresholdRejected).toBe(1);
    expect(thresholded.candidateTrace[0]).toMatchObject({
      entry: { id: semantic.id }, retrievalStage: "rejected_by_similarity_threshold",
    });
    const reranked = rankVectorWorldInfoCandidates({ ...input, rerankCutoff: 1 });
    expect(reranked.shortlistedEntries).toHaveLength(0);
    expect(reranked.rerankRejected).toBe(1);
  });

  test("Balanced and Keyword First retain exact-key rescue and lexical ranking", () => {
    const { keyword, semantic, input } = fixture();
    for (const hybridWeightMode of ["balanced", "keyword_first"] as const) {
      const rescued = rankVectorWorldInfoCandidates({
        ...input, hybridWeightMode, pooledCandidates: [],
      });
      expect(rescued.shortlistedEntries[0].entry.id).toBe(keyword.id);
      expect(rescued.shortlistedEntries[0].distance).toBe(Infinity);
      expect(rescued.shortlistedEntries[0].scoreBreakdown.vectorSimilarity).toBe(0);
      const ranked = rankVectorWorldInfoCandidates({
        ...input, hybridWeightMode,
        pooledCandidates: [candidate(keyword, 0.5, 30, 1), candidate(semantic, 0.3, 0, 0)],
      });
      expect(ranked.shortlistedEntries[0].entry.id).toBe(keyword.id);
    }
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

  test("promotes unanchored lore that connects at least three explicit subjects", () => {
    const arden = makeEntry({ comment: "Arden Vale" });
    const mira = makeEntry({ comment: "Mira Sol" });
    const tovin = makeEntry({ comment: "Tovin Reed" });
    const supporting = makeEntry({
      comment: "Council Origins",
      content: "Arden Vale, Mira Sol, and Tovin Reed founded the council before their ideological split.",
    });
    const marginal = makeEntry({
      comment: "Bridge Officer",
      content: "A bridge officer maintains routine consoles during transit and reports status.",
    });
    const twoSubjectAssociation = makeEntry({
      comment: "Vale Residence",
      content: "Arden Vale once visited the residence with Mira Sol.",
    });
    const longBiography = makeEntry({
      comment: "Distant Biographer",
      content: `Arden Vale, Mira Sol, and Tovin Reed are mentioned in passing. ${"unrelated biography detail ".repeat(220)}`,
    });
    const entries = [arden, mira, tovin, supporting, marginal, twoSubjectAssociation, longBiography];
    const result = rankVectorWorldInfoCandidates({
      eligibleEntries: entries,
      pooledCandidates: [
        candidate(arden, 0.4, 30, 0.7),
        candidate(mira, 0.41, 30, 0.7),
        candidate(tovin, 0.42, 30, 0.7),
        candidate(supporting, 0.51, 20, 0.58),
        candidate(marginal, 0.49, 21, 0.58),
        candidate(twoSubjectAssociation, 0.48, 22, 0.58),
        candidate(longBiography, 0.47, 23, 0.58),
      ],
      queryText: "Arden Vale told Mira Sol and Tovin Reed how they founded the council before splitting apart.",
      hybridWeightMode: "balanced",
      similarityThreshold: 0,
      rerankCutoff: 0,
      topK: 20,
    });
    const byName = new Map(result.shortlistedEntries.map((item) => [item.entry.comment, item]));

    expect(byName.get("Council Origins")!.scoreBreakdown.supportingContextBoost).toBe(0.025);
    expect(byName.get("Bridge Officer")!.scoreBreakdown.supportingContextBoost).toBe(0);
    expect(byName.get("Vale Residence")!.scoreBreakdown.supportingContextBoost).toBe(0);
    expect(byName.get("Distant Biographer")!.scoreBreakdown.supportingContextBoost).toBeLessThan(0.01);
    expect(byName.get("Council Origins")!.finalScore).toBeGreaterThan(
      byName.get("Bridge Officer")!.finalScore,
    );
    expect(byName.get("Council Origins")!.finalScore).toBeGreaterThan(
      byName.get("Vale Residence")!.finalScore,
    );
    expect(byName.get("Council Origins")!.finalScore).toBeGreaterThan(
      byName.get("Distant Biographer")!.finalScore,
    );
  });
});
