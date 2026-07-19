import { describe, expect, test } from "bun:test";
import { resolveDetectedExpressionLabel } from "./expression-detection.service";

describe("resolveDetectedExpressionLabel", () => {
  const labels = [
    "name_apron_neutral",
    "name_apron_action_position",
    "name_casual_neutral",
  ];

  test("keeps exact matches first", () => {
    expect(resolveDetectedExpressionLabel("name_apron_neutral", labels)).toBe("name_apron_neutral");
  });

  test("normalizes quoted filename-style responses", () => {
    expect(resolveDetectedExpressionLabel("`name-apron-action-position.png`", labels)).toBe("name_apron_action_position");
  });

  test("prefers the most specific reverse fuzzy match", () => {
    expect(resolveDetectedExpressionLabel("name_apron_action", labels)).toBe("name_apron_action_position");
  });

  test("does not collapse outfit-only partials to the first neutral match", () => {
    expect(resolveDetectedExpressionLabel("name_apron", labels)).toBe("name_apron_action_position");
  });
});
