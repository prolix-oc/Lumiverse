import { describe, expect, test } from "bun:test";

import { normalizePromptBlocks } from "./presets.service";
import type { PromptBlock } from "../types/preset";

function block(overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: "placement-block",
    name: "Placement block",
    content: "",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    variables: [
      {
        id: "selector",
        name: "target",
        label: "Target",
        type: "select",
        defaultValue: "frontier",
        options: [{ id: "frontier", label: "Frontier", value: "" }],
      },
    ],
    ...overrides,
  };
}

describe("normalizePromptBlocks placement bindings", () => {
  test("retains valid option profiles for preset persistence", () => {
    const [normalized] = normalizePromptBlocks([
      block({
        placementBinding: {
          variableId: "selector",
          options: {
            frontier: { role: "user", position: "in_history", depth: 3.8 },
          },
        },
      }),
    ]);

    expect(normalized.placementBinding).toEqual({
      variableId: "selector",
      options: {
        frontier: { role: "user", position: "in_history", depth: 3 },
      },
    });
  });

  test("drops malformed profiles instead of persisting a partial placement binding", () => {
    const [normalized] = normalizePromptBlocks([
      block({
        placementBinding: {
          variableId: "selector",
          options: {
            frontier: { role: "system", position: "somewhere" as "pre_history", depth: -1 },
          },
        },
      }),
    ]);

    expect(normalized.placementBinding).toBeUndefined();
  });
});
