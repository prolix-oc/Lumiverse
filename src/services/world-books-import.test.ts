import { describe, expect, test } from "bun:test";
import {
  countImportedWorldBookEntries,
  materializeCharacterBookEntriesForRuntime,
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
});
