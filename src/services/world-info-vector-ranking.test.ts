import { describe, expect, test } from "bun:test";

import type { WorldBookEntry } from "../types/world-book";
import {
  getWorldInfoVectorCandidateRecallLimit,
  rankVectorWorldInfoCandidates,
} from "./world-info-vector-ranking";

function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    world_book_id: "book-a",
    uid: overrides.uid ?? crypto.randomUUID(),
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content: "Example content.",
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

describe("world info vector ranking", () => {
  test("expands candidate recall beyond 100 when enough entries are eligible", () => {
    expect(getWorldInfoVectorCandidateRecallLimit("balanced", 100, 224)).toBe(
      224,
    );
    expect(getWorldInfoVectorCandidateRecallLimit("balanced", 100, 9000)).toBe(
      300,
    );
  });

  test("rescues exact title matches that were absent from vector-store recall", () => {
    const loki = makeEntry({
      id: "loki",
      comment: "Loki",
      content:
        "Name: Loki\nPersonality: Trickster goddess and patron of the Loki Familia.",
    });

    const result = rankVectorWorldInfoCandidates({
      eligibleEntries: [loki],
      pooledCandidates: [],
      queryText: "Loki, still perched on the booth, let out a loud laugh.",
      hybridWeightMode: "balanced",
      similarityThreshold: 0,
      rerankCutoff: 0.36,
      topK: 8,
    });

    expect(result.shortlistedEntries.map((item) => item.entry.id)).toContain(
      "loki",
    );
    const trace = result.candidateTrace.find((item) => item.entry.id === "loki");
    expect(trace?.matchedComment).toBe("Loki");
    expect(trace?.lexicalCandidateScore).toBe(30);
    expect(trace?.finalScore).toBeGreaterThanOrEqual(0.36);
  });
});
