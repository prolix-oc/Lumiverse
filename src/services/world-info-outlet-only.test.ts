/**
 * Tests for world-info "Outlet Only" position (8).
 *
 * Position 8 is a no-op bucket in `bucketByPosition`: such an entry is still
 * activated and still resolved into the outlet map via `resolveWorldInfoOutlets`
 * (`{{outlet::name}}`), but is NEVER injected at any prompt position. This fixes
 * the previous double-output where a position-2 + outlet entry appeared both at
 * its position AND via the outlet macro.
 */
import { describe, it, expect } from "bun:test";

import type { WorldBookEntry, WorldInfoCache } from "../types/world-book";
import type { MacroEnv } from "../macros";

import { finalizeActivatedWorldInfoEntries } from "./world-info-activation.service";
import { resolveWorldInfoOutlets } from "./prompt-assembly.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    content: "",
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

/** Minimal macro env: `resolveWorldInfoOutlets` only touches `extra.worldInfoOutlets`. */
function makeEnv(): MacroEnv {
  return { extra: {} } as unknown as MacroEnv;
}

/** Collect every bucket's content strings into one flat array. */
function allBucketContents(cache: WorldInfoCache): string[] {
  return [
    ...cache.before,
    ...cache.after,
    ...cache.anBefore,
    ...cache.anAfter,
    ...cache.depth,
    ...cache.emBefore,
    ...cache.emAfter,
    ...cache.atMarker,
  ].map((item) => item.content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("world-info outlet-only position (8)", () => {
  it("position-8 entry with outlet is excluded from all position buckets", () => {
    const entry = makeEntry({
      id: "outlet-only",
      uid: "outlet-only",
      position: 8,
      outlet_name: "lore",
      content: "X",
    });

    const result = finalizeActivatedWorldInfoEntries([entry], undefined, {
      skipGroupLogic: true,
      preserveOrder: true,
    });

    // Still activated (so it can flow into outlet resolution)...
    expect(result.activatedEntries.map((e) => e.id)).toContain("outlet-only");

    // ...but present in NO position bucket.
    const { cache } = result;
    expect(cache.before).toEqual([]);
    expect(cache.after).toEqual([]);
    expect(cache.anBefore).toEqual([]);
    expect(cache.anAfter).toEqual([]);
    expect(cache.emBefore).toEqual([]);
    expect(cache.emAfter).toEqual([]);
    expect(cache.atMarker).toEqual([]);
    expect(cache.depth).toEqual([]);
    expect(allBucketContents(cache)).not.toContain("X");
  });

  it("position-8 entry with outlet still resolves into the outlet map", async () => {
    const entry = makeEntry({
      id: "outlet-only",
      uid: "outlet-only",
      position: 8,
      outlet_name: "lore",
      content: "X",
    });

    const result = finalizeActivatedWorldInfoEntries([entry], undefined, {
      skipGroupLogic: true,
      preserveOrder: true,
    });

    const env = makeEnv();
    await resolveWorldInfoOutlets(result.activatedEntries, env);

    expect(env.extra.worldInfoOutlets).toBeDefined();
    expect(env.extra.worldInfoOutlets["lore"]).toBe("X");
  });

  it("contrast: position-2 entry with outlet still double-outputs (legacy unchanged)", async () => {
    const entry = makeEntry({
      id: "legacy",
      uid: "legacy",
      position: 2,
      outlet_name: "lore",
      content: "Y",
    });

    const result = finalizeActivatedWorldInfoEntries([entry], undefined, {
      skipGroupLogic: true,
      preserveOrder: true,
    });

    // Legacy behavior untouched: position 2 lands in the AN-before bucket...
    expect(result.cache.anBefore.map((item) => item.content)).toContain("Y");

    // ...AND is also surfaced via the outlet macro.
    const env = makeEnv();
    await resolveWorldInfoOutlets(result.activatedEntries, env);

    expect(env.extra.worldInfoOutlets["lore"]).toBe("Y");
  });

  it("position-8 entry with no outlet name outputs nowhere", async () => {
    const entry = makeEntry({
      id: "orphan",
      uid: "orphan",
      position: 8,
      outlet_name: null,
      content: "Z",
    });

    const result = finalizeActivatedWorldInfoEntries([entry], undefined, {
      skipGroupLogic: true,
      preserveOrder: true,
    });

    // Not injected at any position...
    expect(allBucketContents(result.cache)).not.toContain("Z");

    // ...and, with no outlet name, never enters the outlet map.
    const env = makeEnv();
    const outlets = await resolveWorldInfoOutlets(result.activatedEntries, env);

    expect(Object.values(outlets)).not.toContain("Z");
  });
});
