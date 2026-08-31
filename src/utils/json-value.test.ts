import { describe, expect, test } from "bun:test";
import { canonicalJsonValue, sameJsonValue } from "./json-value";

describe("JSON authority comparison", () => {
  test("ignores object key order recursively", () => {
    const left = { outer: { alpha: 1, beta: 2 }, enabled: true };
    const right = { enabled: true, outer: { beta: 2, alpha: 1 } };

    expect(sameJsonValue(left, right)).toBe(true);
    expect(canonicalJsonValue(left)).toBe(canonicalJsonValue(right));
  });

  test("preserves array order as semantic authority", () => {
    const left = { phases: ["prepare", "commit"] };
    const right = { phases: ["commit", "prepare"] };

    expect(sameJsonValue(left, right)).toBe(false);
    expect(canonicalJsonValue(left)).not.toBe(canonicalJsonValue(right));
  });
});
