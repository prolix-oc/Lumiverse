import { describe, expect, test } from "bun:test";
import type { ActivatedWorldInfoEntry } from "../llm/types";
import type { WorldBookEntry } from "../types/world-book";
import { __vectorWiRetrievalTest } from "../services/prompt-assembly.service";
import {
  buildWorldInfoCaptureMap,
  INTERNAL_WORLD_INFO_CAPTURES_KEY,
  projectWorldInfoCaptureContext,
} from "./world-info-capture";

const activated: ActivatedWorldInfoEntry[] = [
  {
    id: "shelf-a",
    comment: "Shelf A",
    keys: ["alpha"],
    source: "keyword",
    bookId: "book-a",
    bookSource: "chat",
  },
  {
    id: "peer-b",
    comment: "Peer B",
    keys: [],
    source: "vector",
    score: 0.9,
    bookId: "book-b",
    bookSource: "peer",
  },
];

describe("world-info activation capture", () => {
  test("keeps requested active entries isolated per extension, including empty captures", () => {
    const captures = buildWorldInfoCaptureMap(
      new Map([
        ["one", new Set(["shelf-a", "missing"])],
        ["two", new Set(["peer-b", "shelf-a"])],
        ["empty", new Set()],
      ]),
      activated,
    );

    expect(captures.one.map((entry) => entry.id)).toEqual(["shelf-a"]);
    expect(captures.two.map((entry) => entry.id)).toEqual([
      "shelf-a",
      "peer-b",
    ]);
    expect(captures.empty).toEqual([]);

    const shared = {
      chatId: "chat",
      [INTERNAL_WORLD_INFO_CAPTURES_KEY]: captures,
    };
    expect(projectWorldInfoCaptureContext(shared, "one").capturedWorldInfo).toEqual([
      expect.objectContaining({ id: "shelf-a", bookSource: "chat" }),
    ]);
    expect(projectWorldInfoCaptureContext(shared, "two").capturedWorldInfo).toEqual([
      expect.objectContaining({ id: "shelf-a", bookSource: "chat" }),
      expect.objectContaining({ id: "peer-b", bookSource: "persona" }),
    ]);
    expect(projectWorldInfoCaptureContext(shared, "empty").capturedWorldInfo).toEqual([]);
    expect(projectWorldInfoCaptureContext(shared, "other").capturedWorldInfo).toBeUndefined();
    expect(projectWorldInfoCaptureContext(shared, "one")).not.toHaveProperty(
      INTERNAL_WORLD_INFO_CAPTURES_KEY,
    );
  });

  test("projects native activated entries through the public DTO", () => {
    const projected = projectWorldInfoCaptureContext(
      {
        chatId: "chat",
        activatedWorldInfo: [
          {
            ...activated[1],
            content: "private lore content",
            internalOnly: "private",
          },
        ],
      },
      "one",
    );

    expect(projected.activatedWorldInfo).toEqual([
      {
        id: "peer-b",
        comment: "Peer B",
        keys: [],
        source: "vector",
        score: 0.9,
        bookId: "book-b",
        bookSource: "persona",
      },
    ]);
  });

  test("shares vector retrieval only when the raw and native candidate views are identical", () => {
    const vector = {
      id: "vector",
      vectorized: true,
      disabled: false,
      content: "indexed",
      vector_index_status: "indexed",
    } as WorldBookEntry;
    const keywordOnly = {
      id: "keyword",
      vectorized: false,
      disabled: false,
      content: "keyword",
      vector_index_status: "not_enabled",
    } as WorldBookEntry;
    expect(
      __vectorWiRetrievalTest.viewsEquivalent(
        [vector, keywordOnly],
        [vector, { ...keywordOnly, disabled: true }],
      ),
    ).toBe(true);
    expect(
      __vectorWiRetrievalTest.viewsEquivalent(
        [vector, keywordOnly],
        [{ ...vector, disabled: true }, keywordOnly],
      ),
    ).toBe(false);
    expect(
      __vectorWiRetrievalTest.viewsEquivalent(
        [vector, keywordOnly],
        [{ ...vector, content: "mutated" }, keywordOnly],
      ),
    ).toBe(false);
  });

  test("does not share vector retrieval when eligible entries are reordered", () => {
    const first = {
      id: "first",
      vectorized: true,
      disabled: false,
      content: "first",
      vector_index_status: "indexed",
    } as WorldBookEntry;
    const second = {
      ...first,
      id: "second",
      content: "second",
    } as WorldBookEntry;

    expect(
      __vectorWiRetrievalTest.viewsEquivalent(
        [first, second],
        [second, first],
      ),
    ).toBe(false);
  });
});
