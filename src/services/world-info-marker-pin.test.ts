import { describe, expect, test } from "bun:test";

import { mergeActivatedWorldInfoEntries } from "./prompt-assembly.service";
import type { WorldBookEntry } from "../types/world-book";

/**
 * WI marker-targeting: position-7 entries with a `wi_marker` are routed into
 * the `pinnedMarkers` cache bucket (consumed by the assembly loop to splice
 * adjacent to the matching loom block) instead of the legacy `atMarker` pool
 * (the {{wi_marker}} macro). These tests exercise the producer that runs
 * `bucketByPosition` — the single decision point that decides which bucket a
 * position-7 entry lands in — for all four acceptance scenarios:
 *
 *  (1) wi_marker set + side="after"  → pinnedMarkers (after the block)
 *  (2) wi_marker set + side="before" → pinnedMarkers (before the block)
 *  (3) wi_marker null                → atMarker (legacy {{wi_marker}} pool)
 *  (4) wi_marker set but no matching block → never emitted (verified here by
 *      confirming the entry is in pinnedMarkers and NOT in any always-injected
 *      bucket; the assembly loop only emits a pinned entry when a block with a
 *      matching marker is iterated, so an unmatched marker is silent).
 *
 * `mergeActivatedWorldInfoEntries` returns the exact `WorldInfoCache` the
 * assembly loop consumes; the splice then reads `cache.pinnedMarkers`,
 * grouping by `marker` and emitting `before`/`after` entries adjacent to the
 * matching block. So the bucket + element shape asserted here is the contract
 * the splice relies on.
 */
function makeEntry(partial: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    id: "entry-1",
    world_book_id: "wb-1",
    uid: "uid-1",
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content: "",
    comment: "",
    position: 0,
    depth: 0,
    role: null,
    order_value: 0,
    selective: false,
    constant: true,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 0,
    probability: 100,
    scan_depth: null,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: false,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: false,
    vectorized: false,
    vector_index_status: "not_enabled",
    vector_indexed_at: null,
    vector_index_error: null,
    extensions: {},
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

describe("WI marker-pin bucketing (bucketByPosition via mergeActivatedWorldInfoEntries)", () => {
  test("(1) position-7 + wi_marker + side=after → pinnedMarkers, not atMarker", () => {
    const entry = makeEntry({
      id: "after-1",
      position: 7,
      content: "PINNED AFTER",
      comment: "After Pin",
      wi_marker: "char_description",
      wi_marker_side: "after",
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    expect(cache.pinnedMarkers).toHaveLength(1);
    expect(cache.pinnedMarkers[0]).toEqual({
      content: "PINNED AFTER",
      role: "system",
      entryLabel: "After Pin",
      marker: "char_description",
      side: "after",
    });
    // Excluded from the legacy {{wi_marker}} pool.
    expect(cache.atMarker).toHaveLength(0);
  });

  test("(2) position-7 + wi_marker + side=before → pinnedMarkers before slot", () => {
    const entry = makeEntry({
      id: "before-1",
      position: 7,
      content: "PINNED BEFORE",
      comment: "Before Pin",
      wi_marker: "char_description",
      wi_marker_side: "before",
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    expect(cache.pinnedMarkers).toHaveLength(1);
    expect(cache.pinnedMarkers[0].marker).toBe("char_description");
    expect(cache.pinnedMarkers[0].side).toBe("before");
    expect(cache.atMarker).toHaveLength(0);
  });

  test("(2b) position-7 + wi_marker + null side → defaults to after", () => {
    const entry = makeEntry({
      id: "default-side",
      position: 7,
      content: "X",
      comment: "Default Side",
      wi_marker: "scenario",
      wi_marker_side: null,
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    expect(cache.pinnedMarkers).toHaveLength(1);
    expect(cache.pinnedMarkers[0].side).toBe("after");
    expect(cache.pinnedMarkers[0].marker).toBe("scenario");
  });

  test("(3) position-7 + null wi_marker → stays in atMarker (legacy)", () => {
    const entry = makeEntry({
      id: "legacy-1",
      position: 7,
      content: "LEGACY POOL",
      comment: "Legacy",
      wi_marker: null,
      wi_marker_side: null,
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    // Legacy behavior: joins the {{wi_marker}} macro pool.
    expect(cache.atMarker).toHaveLength(1);
    expect(cache.atMarker[0]).toEqual({
      content: "LEGACY POOL",
      role: "system",
      entryLabel: "Legacy",
    });
    expect(cache.pinnedMarkers).toHaveLength(0);
  });

  test("(3b) position-7 + empty-string wi_marker → falls back to atMarker", () => {
    const entry = makeEntry({
      id: "empty-marker",
      position: 7,
      content: "LEGACY EMPTY",
      comment: "Empty Marker",
      wi_marker: "",
      wi_marker_side: "after",
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    expect(cache.atMarker).toHaveLength(1);
    expect(cache.pinnedMarkers).toHaveLength(0);
  });

  test("(4) non-position-7 entry ignores wi_marker entirely", () => {
    const entry = makeEntry({
      id: "pos0-1",
      position: 0,
      content: "BEFORE BLOCK",
      comment: "Pos Zero",
      // A wi_marker on a non-position-7 entry must be ignored.
      wi_marker: "char_description",
      wi_marker_side: "after",
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    expect(cache.before).toHaveLength(1);
    expect(cache.before[0].content).toBe("BEFORE BLOCK");
    expect(cache.pinnedMarkers).toHaveLength(0);
    expect(cache.atMarker).toHaveLength(0);
  });

  test("mixed: pinned (before+after), legacy atMarker, and pos-0 all bucket independently", () => {
    const entries = [
      makeEntry({
        id: "p-after",
        position: 7,
        content: "AFTER",
        comment: "A",
        wi_marker: "char_description",
        wi_marker_side: "after",
      }),
      makeEntry({
        id: "p-before",
        position: 7,
        content: "BEFORE",
        comment: "B",
        wi_marker: "char_description",
        wi_marker_side: "before",
      }),
      makeEntry({
        id: "legacy",
        position: 7,
        content: "LEGACY",
        comment: "L",
        wi_marker: null,
      }),
      makeEntry({
        id: "pos0",
        position: 0,
        content: "PRE",
        comment: "P0",
        wi_marker: "main_prompt",
        wi_marker_side: "after",
      }),
    ];

    const { cache } = mergeActivatedWorldInfoEntries(entries, []);

    expect(cache.pinnedMarkers).toHaveLength(2);
    expect(cache.pinnedMarkers.map((p) => p.side).sort()).toEqual([
      "after",
      "before",
    ]);
    // All pinned entries target the same marker; the assembly loop groups them
    // under that marker and emits before/after around the char_description block.
    expect(cache.pinnedMarkers.every((p) => p.marker === "char_description"))
      .toBe(true);

    expect(cache.atMarker).toHaveLength(1);
    expect(cache.atMarker[0].content).toBe("LEGACY");

    // Non-position-7 entry went to its own bucket, ignored wi_marker.
    expect(cache.before).toHaveLength(1);
    expect(cache.before[0].content).toBe("PRE");
  });

  test("pinned entry preserves a non-default role", () => {
    const entry = makeEntry({
      id: "role-user",
      position: 7,
      content: "USER ROLE PIN",
      comment: "UserRole",
      role: "user",
      wi_marker: "char_personality",
      wi_marker_side: "after",
    });

    const { cache } = mergeActivatedWorldInfoEntries([entry], []);

    expect(cache.pinnedMarkers).toHaveLength(1);
    expect(cache.pinnedMarkers[0].role).toBe("user");
  });
});
