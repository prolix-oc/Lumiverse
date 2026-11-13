import { describe, expect, test } from "bun:test";

import type { Message } from "../types/message";
import type { WorldBookEntry } from "../types/world-book";
import { activateWorldInfo, type WiState } from "./world-info-activation.service";
import { WorldInfoMatcher, makeScanState } from "./world-info-matcher.service";

function entry(partial: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    folder: "", tags: [],
    id: "entry-1",
    world_book_id: "book-1",
    uid: "uid-1",
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content: "lore",
    comment: "",
    position: 0,
    depth: 0,
    role: null,
    order_value: 0,
    selective: false,
    constant: false,
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
    exclude_greeting: partial.exclude_greeting ?? false,
    revision: partial.revision ?? 1,
  };
}

function message(id: string, index: number, content: string): Message {
  return {
    id,
    chat_id: "chat-1",
    index_in_chat: index,
    is_user: true,
    name: "User",
    content,
    send_date: index,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [index],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: index,
  };
}

describe("world-info admission provenance", () => {
  test("captures constants and exact keyword message locators without content", () => {
    const constant = entry({ id: "constant", uid: "constant", constant: true, content: "always" });
    const keyword = entry({ id: "keyword", uid: "keyword", key: ["dragon"], content: "secret lore" });
    const result = activateWorldInfo({
      entries: [constant, keyword],
      messages: [message("message-7", 7, "A dragon appears")],
      chatTurn: 1,
      wiState: {},
    });

    expect(result.activationProvenanceById.get("constant")).toEqual({ origin: "constant" });
    expect(result.firstTriggeredForBookById.get("constant")).toBe(true);
    expect(result.firstTriggeredForBookById.get("keyword")).toBe(false);
    expect(result.activationProvenanceById.get("keyword")).toEqual({
      origin: "keyword",
      activationPass: 0,
      matchedPrimaryKeys: ["dragon"],
      matchedSecondaryKeys: [],
      exactMatch: {
        configuredPattern: "dragon",
        source: { kind: "message", messageId: "message-7", messageOffset: 7, start: 2, end: 8 },
      },
    });
    expect(JSON.stringify(result.activationProvenanceById)).not.toMatch(/secret lore|messageContent|regex/);
  });

  test("uses sticky provenance without inventing a locator", () => {
    const sticky = entry({ id: "sticky", uid: "sticky", key: ["dragon"], sticky: 2 });
    const wiState: WiState = {};
    activateWorldInfo({ entries: [sticky], messages: [message("message-1", 1, "dragon")], chatTurn: 1, wiState });
    const result = activateWorldInfo({ entries: [sticky], messages: [message("message-2", 2, "quiet")], chatTurn: 2, wiState });

    expect(result.activationProvenanceById.get("sticky")).toEqual({ origin: "sticky" });
  });

  test("records recursive-entry locators and mixed evidence explicitly", () => {
    const constant = entry({ id: "seed", uid: "seed", constant: true, content: "dragon" });
    const recursive = entry({ id: "recursive", uid: "recursive", key: ["dragon"], content: "recursive lore" });
    const recursiveResult = activateWorldInfo({ entries: [constant, recursive], messages: [], chatTurn: 0, wiState: {} });

    expect(recursiveResult.activationProvenanceById.get("recursive")).toEqual({
      origin: "keyword",
      activationPass: 1,
      matchedPrimaryKeys: ["dragon"],
      matchedSecondaryKeys: [],
      exactMatch: {
        configuredPattern: "dragon",
        source: { kind: "recursive_entry", entryId: "seed", start: 0, end: 6 },
      },
    });

    const mixed = entry({ id: "mixed", uid: "mixed", key: ["dragon"] });
    const mixedResult = activateWorldInfo({
      entries: [mixed],
      messages: [message("message-1", 1, "dragon"), message("message-2", 2, "dragon")],
      chatTurn: 2,
      wiState: {},
    });
    expect(mixedResult.activationProvenanceById.get("mixed")).toMatchObject({
      origin: "keyword",
      exactMatch: { configuredPattern: "dragon", source: { kind: "mixed_or_unavailable" } },
    });
  });

  test("deep-clones nested provenance at the activation cache boundary", () => {
    const keyword = entry({ id: "cached", uid: "cached", key: ["dragon"] });
    const wiState: WiState = {};
    const first = activateWorldInfo({
      entries: [keyword],
      messages: [message("message-1", 1, "dragon")],
      chatTurn: 1,
      wiState,
    });
    const firstProvenance = first.activationProvenanceById.get("cached");
    if (!firstProvenance || firstProvenance.origin !== "keyword" || !firstProvenance.exactMatch) {
      throw new Error("expected keyword provenance");
    }
    const mutableProvenance = firstProvenance as any;
    mutableProvenance.matchedPrimaryKeys[0] = "mutated";
    mutableProvenance.exactMatch.source.kind = "mixed_or_unavailable";
    delete wiState.cached;

    const second = activateWorldInfo({
      entries: [keyword],
      messages: [message("message-1", 1, "dragon")],
      chatTurn: 1,
      wiState,
    });
    expect(second.activationProvenanceById.get("cached")).toEqual({
      origin: "keyword",
      activationPass: 0,
      matchedPrimaryKeys: ["dragon"],
      matchedSecondaryKeys: [],
      exactMatch: {
        configuredPattern: "dragon",
        source: { kind: "message", messageId: "message-1", messageOffset: 1, start: 0, end: 6 },
      },
    });
  });

  test("marks exactly one first entry per book in final survivor order", () => {
    const entries = [
      entry({ id: "a-low", uid: "a-low", world_book_id: "book-a", key: ["trigger"], priority: 1, order_value: 1 }),
      entry({ id: "a-high", uid: "a-high", world_book_id: "book-a", key: ["trigger"], priority: 20, order_value: 2 }),
      entry({ id: "b", uid: "b", world_book_id: "book-b", key: ["trigger"], priority: 5, order_value: 3 }),
    ];
    const result = activateWorldInfo({
      entries,
      messages: [message("message-1", 1, "trigger")],
      chatTurn: 1,
      wiState: {},
    });

    expect(result.activatedEntries.map((item) => item.id)).toEqual(["a-high", "b", "a-low"]);
    expect([...result.firstTriggeredForBookById]).toEqual([
      ["a-high", true],
      ["b", true],
      ["a-low", false],
    ]);
  });

  test("maps length-changing case folds back to original UTF-16 offsets", () => {
    const matcher = new WorldInfoMatcher([entry({ uid: "unicode", key: ["i\u0307"] })]);
    const state = makeScanState();
    matcher.scanChunk("x\u0130y", state, undefined, {
      kind: "message",
      messageId: "message-unicode",
      messageOffset: 4,
    });

    expect(state.primaryHits.get("unicode")).toEqual(new Set([0]));
    expect(state.exactMatches.get("unicode")).toEqual([{
      configuredPattern: "i\u0307",
      source: { kind: "message", messageId: "message-unicode", messageOffset: 4 },
      start: 1,
      end: 2,
    }]);
  });

  test("bounds repeated exact-match evidence once provenance is ambiguous", () => {
    const matcher = new WorldInfoMatcher([entry({ uid: "repeated", key: ["Alice"] })]);
    const state = makeScanState();
    const content = Array(20).fill("Alice").join(" ");

    for (let index = 0; index < 600; index++) {
      matcher.scanChunk(content, state, undefined, {
        kind: "message",
        messageId: `message-${index}`,
        messageOffset: index,
      });
    }

    expect(state.primaryHits.get("repeated")).toEqual(new Set([0]));
    expect(state.exactMatches.get("repeated")).toEqual([
      {
        configuredPattern: "Alice",
        source: { kind: "message", messageId: "message-0", messageOffset: 0 },
        start: 0,
        end: 5,
      },
      {
        configuredPattern: "Alice",
        source: { kind: "message", messageId: "message-0", messageOffset: 0 },
        start: 6,
        end: 11,
      },
    ]);
  });

  test("ignores keywords inside scan-exclusion markup and keeps exact offsets", () => {
    const offscene = entry({ id: "offscene", uid: "offscene", key: ["Zebulon"] });
    const dragon = entry({ id: "dragon", uid: "dragon", key: ["dragon"] });
    const later = '<div class="tracker" wi-exclude>🐉 Off-scene: Zebulon</div>\nA dragon lands.';
    const start = later.indexOf("dragon");
    const result = activateWorldInfo({
      entries: [offscene, dragon],
      messages: [
        message("message-1", 1, "Rain falls. <wi-exclude>A dragon sleeps"),
        message("message-2", 2, later),
      ],
      chatTurn: 1,
      wiState: {},
    });

    expect(result.activatedEntries.map((item) => item.id)).toEqual(["dragon"]);
    expect(result.activationProvenanceById.has("offscene")).toBe(false);
    expect(result.activationProvenanceById.get("dragon")).toEqual({
      origin: "keyword",
      activationPass: 0,
      matchedPrimaryKeys: ["dragon"],
      matchedSecondaryKeys: [],
      exactMatch: {
        configuredPattern: "dragon",
        source: { kind: "message", messageId: "message-2", messageOffset: 2, start, end: start + 6 },
      },
    });
  });

  test("does not scan messages that are entirely excluded", () => {
    const anything = entry({ id: "anything", uid: "anything", key: [".{10,}"], use_regex: true });
    const result = activateWorldInfo({
      entries: [anything],
      messages: [
        message("message-1", 1, "<wi-exclude>Off-scene: Zebulon, Mordecai</wi-exclude>"),
        message("message-2", 2, "!--WI_EXCLUDE_START--!\nTracker: Mira\n!--WI_EXCLUDE_END--!\n"),
      ],
      chatTurn: 1,
      wiState: {},
    });

    expect(result.activatedEntries).toEqual([]);
  });
});
