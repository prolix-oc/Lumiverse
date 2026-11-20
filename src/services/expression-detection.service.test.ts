import { describe, expect, test } from "bun:test";
import {
  buildExpressionSelectionPrompt,
  buildMultiCharacterSelectionPrompt,
  resolveDetectedCharacterNames,
  resolveDetectedExpressionLabel,
} from "./expression-detection.service";

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

describe("multi-character expression prompting", () => {
  const characters = ["Alice", "Bob", "Dr. Carol"];

  test("explicitly permits every visible character to be displayed", () => {
    const prompt = buildMultiCharacterSelectionPrompt(characters);

    expect(prompt).toContain("EVERY listed character");
    expect(prompt).toContain("show multiple character sprites at the same time");
    expect(prompt).toContain("own unique expression set");
    expect(prompt).toContain('["Character A", "Character B"]');
  });

  test("resolves a fenced JSON array without losing multiple characters", () => {
    expect(resolveDetectedCharacterNames(
      '```json\n["Alice", "Dr. Carol"]\n```',
      characters,
    )).toEqual(["Alice", "Dr. Carol"]);
  });

  test("deduplicates names and rejects characters outside the card", () => {
    expect(resolveDetectedCharacterNames(
      '["Bob", "Mallory", "Bob"]',
      characters,
    )).toEqual(["Bob"]);
  });

  test("treats an explicit empty array as no visible characters", () => {
    expect(resolveDetectedCharacterNames("[]", characters)).toEqual([]);
  });

  test("treats an all-unknown response as invalid instead of clearing the display", () => {
    expect(resolveDetectedCharacterNames('["Mallory"]', characters)).toBeNull();
  });

  test("scopes expression selection to one character's own labels", () => {
    const prompt = buildExpressionSelectionPrompt(["happy", "sad"], "Alice");

    expect(prompt).toContain('Evaluate ONLY "Alice"');
    expect(prompt).toContain("do not use their dialogue, actions, or emotions");
    expect(prompt).toContain('Available expressions for "Alice": happy, sad');
  });
});
