import { describe, expect, test } from "bun:test";

import { isNativeMessageHidden, selectNativeVisibleHistory } from "./native-chat-corpus";

interface FixtureMessage {
  readonly id: string;
  readonly index_in_chat: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

function message(id: string, index: number, hidden?: true | 1): FixtureMessage {
  return {
    id,
    index_in_chat: index,
    extra: hidden === undefined ? {} : { hidden },
  };
}

describe("native visible chat corpus", () => {
  test("excludes boolean and numeric hidden messages", () => {
    const messages = [message("visible-1", 1), message("hidden-bool", 2, true), message("hidden-int", 3, 1), message("visible-2", 4)];

    expect(messages.map(isNativeMessageHidden)).toEqual([false, true, true, false]);
    expect(selectNativeVisibleHistory({}, messages).map((item) => item.id)).toEqual(["visible-1", "visible-2"]);
  });

  test("keeps the visible context anchor and every later visible message", () => {
    const messages = [message("before", 1), message("anchor", 2), message("hidden-after", 3, true), message("after", 4)];

    expect(selectNativeVisibleHistory({ metadata: { context_history_anchor_message_id: "anchor" } }, messages).map((item) => item.id))
      .toEqual(["anchor", "after"]);
  });

  test("missing and hidden anchors use the full visible corpus", () => {
    const messages = [message("first", 1), message("hidden-anchor", 2, true), message("last", 3)];

    expect(selectNativeVisibleHistory({ metadata: { context_history_anchor_message_id: "missing" } }, messages).map((item) => item.id))
      .toEqual(["first", "last"]);
    expect(selectNativeVisibleHistory({ metadata: { context_history_anchor_message_id: "hidden-anchor" } }, messages).map((item) => item.id))
      .toEqual(["first", "last"]);
  });
});
