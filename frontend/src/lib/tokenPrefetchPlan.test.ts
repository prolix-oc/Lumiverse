import { describe, expect, test } from "bun:test";
import {
  planSelectionPrefetch,
  shouldCountOpenEntryImmediately,
  type SelectionPrefetchInput,
} from "./tokenPrefetchPlan";

describe("planSelectionPrefetch", () => {
  const baseInput: SelectionPrefetchInput = {
    selected: true,
    entryId: "entry-7",
    content: "content",
    model: "model-a",
    cacheKey: "model-a:7:hash",
  };

  test.each([
    ["no-selection", { selected: false }, "no-selection"],
    ["already-planned", { alreadyPlanned: true }, "already-planned"],
    ["empty string", { content: "" }, "empty-content"],
    ["null content", { content: null }, "empty-content"],
    ["undefined content", { content: undefined }, "empty-content"],
    ["stored exact", { storedExact: true }, "stored-exact"],
    ["already counted", { alreadyCounted: true }, "already-counted"],
  ] as const)("skips for %s", (_label, override, reason) => {
    expect(planSelectionPrefetch({ ...baseInput, ...override })).toEqual({
      kind: "skip",
      reason,
    });
  });

  test.each([
    ["selection", { selected: false }, "no-selection"],
    ["planning", { alreadyPlanned: true }, "already-planned"],
    ["content", { alreadyPlanned: false, content: "" }, "empty-content"],
    ["stored exact", { alreadyPlanned: false, content: "content", storedExact: true }, "stored-exact"],
    ["counted", { alreadyPlanned: false, content: "content", storedExact: false, alreadyCounted: true }, "already-counted"],
  ] as const)("applies the cheap %s gate before later gates", (_label, firstGate, reason) => {
    expect(
      planSelectionPrefetch({
        ...baseInput,
        alreadyPlanned: true,
        content: "",
        storedExact: true,
        alreadyCounted: true,
        ...firstGate,
      }),
    ).toEqual({ kind: "skip", reason });
  });

  test("schedules an eligible selection interactively with all request fields", () => {
    expect(planSelectionPrefetch(baseInput)).toEqual({
      kind: "schedule",
      priority: "interactive",
      entryId: "entry-7",
      cacheKey: "model-a:7:hash",
      model: "model-a",
      content: "content",
    });
  });

  test("returns a stable result for identical inputs", () => {
    const first = planSelectionPrefetch(baseInput);
    const second = planSelectionPrefetch(baseInput);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe("shouldCountOpenEntryImmediately", () => {
  test.each([
    ["automatic fresh untouched", "automatic", true, false, true],
    ["delayed fresh untouched", "delayed", true, false, true],
    ["manual fresh untouched", "manual", true, false, false],
    ["automatic stale untouched", "automatic", false, false, false],
    ["delayed stale untouched", "delayed", false, false, false],
    ["automatic fresh edited", "automatic", true, true, false],
    ["delayed fresh edited", "delayed", true, true, false],
    ["manual stale edited", "manual", false, true, false],
  ] as const)("%s", (_label, mode, isFresh, isEdited, expected) => {
    expect(shouldCountOpenEntryImmediately({ mode, isFresh, isEdited })).toBe(
      expected,
    );
  });
});
