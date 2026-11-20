import { expect, test } from "bun:test";
import { readMessagePresetContext } from "./preset-context";

test("preset contexts accept sparse slots and partial snapshots without mutating them", () => {
  const context = { preset_id: "source", variables: { local: { mode: "a" }, prompt_selections: { choice: ["x"] } } };
  const extra = { spindle_metadata: { preset_contexts: [null, context] } };
  expect(readMessagePresetContext(extra, 0)).toBeNull();
  expect(readMessagePresetContext(extra, 1)).toBe(context);
  expect(readMessagePresetContext(extra, 2)).toBeNull();
});

test("malformed imported metadata and invalid indexes cannot become render contexts", () => {
  for (const value of [null, [], "source", {}, { preset_id: " " },
    { preset_id: "source", variables: [] },
    { preset_id: "source", variables: { local: "value" } },
    { preset_id: "source", variables: { chat: { key: 3 } } },
    { preset_id: "source", variables: { prompt_defaults: { key: null } } },
    { preset_id: "source", variables: { prompt_selections: { key: "x" } } },
    { preset_id: "source", variables: { prompt_selections: { key: [3] } } },
  ]) {
    expect(readMessagePresetContext({ spindle_metadata: { preset_contexts: [value] } }, 0)).toBeNull();
  }
  const extra = { spindle_metadata: { preset_contexts: [{ preset_id: "source" }] } };
  for (const index of [-1, 0.5, NaN, Infinity, "0", null]) {
    expect(readMessagePresetContext(extra, index as number)).toBeNull();
  }
  expect(readMessagePresetContext({ spindle_metadata: { preset_contexts: { 0: { preset_id: "source" } } } }, 0)).toBeNull();
});
