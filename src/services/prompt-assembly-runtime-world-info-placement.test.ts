import { describe, expect, test } from "bun:test";
import type { LlmMessage } from "../llm/types";
import type { WorldBookEntry } from "../types/world-book";
import {
  buildRuntimeWorldInfoChatPlacements,
  insertRuntimeWorldInfoIntoTaggedHistory,
  repositionRuntimeWorldInfoInTaggedHistory,
  type RuntimeWorldInfoChatPlacementEntry,
} from "./prompt-assembly.service";

function history(content: string): LlmMessage {
  return {
    role: "user",
    content,
    __chatHistorySource: true,
  } as unknown as LlmMessage;
}

function placement(
  content: string,
  depth: number,
  direction: "from_start" | "from_end",
): RuntimeWorldInfoChatPlacementEntry {
  return {
    id: content,
    content,
    entryLabel: content,
    orderValue: 0,
    placement: {
      type: "chat_depth",
      role: "system",
      depth,
      direction,
    },
  };
}

function entry(id: string, orderValue: number): WorldBookEntry {
  return {
    folder: "", tags: [],
    id,
    world_book_id: "book",
    uid: id,
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [id],
    keysecondary: [],
    content: id,
    comment: id,
    position: 0,
    depth: 0,
    role: null,
    order_value: orderValue,
    selective: false,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 1,
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
    revision: 1,
    extensions: {},
    created_at: 0,
    updated_at: 0,
  };
}

describe("runtime world-info chat placement", () => {
  test("uses only selected rows and restores final lore order", () => {
    const placements = new Map([
      ["later", placement("later", 1, "from_start").placement],
      ["earlier", placement("earlier", 1, "from_start").placement],
      ["equal-a", placement("equal-a", 1, "from_start").placement],
      ["equal-b", placement("equal-b", 1, "from_start").placement],
      ["dropped", placement("dropped", 1, "from_start").placement],
    ]);

    expect(
      buildRuntimeWorldInfoChatPlacements(
        [
          entry("later", 20),
          entry("earlier", 10),
          entry("equal-a", 15),
          entry("equal-b", 15),
        ],
        placements,
      ).map(({ id }) => id),
    ).toEqual(["earlier", "equal-b", "equal-a", "later"]);
  });

  test("matches sequential start and reverse splice behavior", () => {
    const messages = [history("h0"), history("h1"), history("h2")];
    insertRuntimeWorldInfoIntoTaggedHistory(messages, [
      placement("start-a", 1, "from_start"),
      placement("start-b", 1, "from_start"),
      placement("end-a", 1, "from_end"),
      placement("end-b", 1, "from_end"),
    ]);

    expect(messages.map(({ content }) => content)).toEqual([
      "h0",
      "start-b",
      "start-a",
      "h1",
      "end-a",
      "end-b",
      "h2",
    ]);
  });

  test("counts a tagged greeting in the selected prompt-history frame", () => {
    const messages = [history("greeting"), history("user")];
    insertRuntimeWorldInfoIntoTaggedHistory(messages, [
      placement("after-greeting", 1, "from_start"),
    ]);

    expect(messages.map(({ content }) => content)).toEqual([
      "greeting",
      "after-greeting",
      "user",
    ]);
  });

  test("retains Array.splice negative-index behavior for oversized reverse depth", () => {
    const messages = [
      { role: "system", content: "prefix" } as LlmMessage,
      history("h0"),
      history("h1"),
      history("h2"),
      history("h3"),
      { role: "system", content: "tail" } as LlmMessage,
    ];
    insertRuntimeWorldInfoIntoTaggedHistory(messages, [
      placement("reverse-six", 6, "from_end"),
    ]);

    expect(messages.map(({ content }) => content)).toEqual([
      "prefix",
      "h0",
      "h1",
      "reverse-six",
      "h2",
      "h3",
      "tail",
    ]);
  });

  test("reapplies placement after older history is clipped", () => {
    const messages = [
      history("h0"),
      history("h1"),
      history("h2"),
      history("h3"),
    ];
    const entries = [
      placement("from-start", 1, "from_start"),
      placement("from-end", 1, "from_end"),
    ];
    insertRuntimeWorldInfoIntoTaggedHistory(messages, entries);
    messages.splice(
      messages.findIndex(({ content }) => content === "h0"),
      1,
    );
    repositionRuntimeWorldInfoInTaggedHistory(messages, entries);

    expect(messages.map(({ content }) => content)).toEqual([
      "h1",
      "from-start",
      "h2",
      "from-end",
      "h3",
    ]);
  });
});
