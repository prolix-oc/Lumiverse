import { describe, expect, test } from "bun:test";
import {
  countImportedWorldBookEntries,
  materializeCharacterBookEntriesForRuntime,
  normalizeImportedEntryInput,
} from "./world-books.service";

describe("character book import normalization", () => {
  test("counts object-keyed embedded entries", () => {
    expect(
      countImportedWorldBookEntries({
        0: { key: ["alpha"], content: "Alpha lore" },
        1: { key: ["beta"], content: "Beta lore" },
      }),
    ).toBe(2);
  });

  test("materializes object-keyed entries for runtime fallback", () => {
    const entries = materializeCharacterBookEntriesForRuntime("book-1", {
      entries: {
        0: {
          key: ["alpha"],
          content: "Alpha lore",
          comment: "Alpha",
          position: "after_char",
        },
        1: {
          key: ["beta"],
          content: "Beta lore",
          comment: "Beta",
        },
      },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      world_book_id: "book-1",
      key: ["alpha"],
      content: "Alpha lore",
      comment: "Alpha",
      position: 1,
    });
    expect(entries[1]).toMatchObject({
      world_book_id: "book-1",
      key: ["beta"],
      content: "Beta lore",
      comment: "Beta",
      position: 0,
    });
  });

  test("normalizes activation fields from Character Book extensions", () => {
    const entry = normalizeImportedEntryInput({
      keys: ["alpha"],
      content: "Alpha lore",
      extensions: {
        priority: 42,
        sticky: 3,
        cooldown: 2,
        delay: 1,
        selective_logic: 3,
        use_probability: false,
        use_regex: true,
        prevent_recursion: true,
        exclude_recursion: true,
        delay_until_recursion: true,
        group_override: true,
        group_weight: 7,
        probability: 55,
        scan_depth: 9,
        automation_id: "auto-1",
        vectorized: true,
      },
    }, 0);

    expect(entry).toMatchObject({
      priority: 42,
      sticky: 3,
      cooldown: 2,
      delay: 1,
      selective_logic: 3,
      use_probability: false,
      use_regex: true,
      prevent_recursion: true,
      exclude_recursion: true,
      delay_until_recursion: true,
      group_override: true,
      group_weight: 7,
      probability: 55,
      scan_depth: 9,
      automation_id: "auto-1",
      vectorized: true,
    });
  });

  test("runtime-only embedded entries do not claim vector indexes", () => {
    const entries = materializeCharacterBookEntriesForRuntime("book-1", {
      entries: [{ key: ["alpha"], content: "Alpha lore", extensions: { vectorized: true } }],
    });

    expect(entries[0]).toMatchObject({
      vectorized: false,
      vector_index_status: "not_enabled",
    });
  });
});
