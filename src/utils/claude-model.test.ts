import { describe, expect, test } from "bun:test";

import {
  isClaudeOpusAtLeast,
  parseClaudeOpusVersion,
  supportsClaudeOpusXhigh,
} from "./claude-model";

describe("Claude Opus model capabilities", () => {
  test("parses direct and catalog-style Opus versions without treating dates as minors", () => {
    expect(parseClaudeOpusVersion("claude-opus-4-8-20260604")).toEqual({ major: 4, minor: 8 });
    expect(parseClaudeOpusVersion("anthropic/claude-opus-5.5")).toEqual({ major: 5, minor: 5 });
    expect(parseClaudeOpusVersion("claude-opus-5-20260813")).toEqual({ major: 5, minor: 0 });
    expect(parseClaudeOpusVersion("claude-opus-4-20250514")).toEqual({ major: 4, minor: 0 });
  });

  test("compares Opus versions numerically", () => {
    expect(isClaudeOpusAtLeast("claude-opus-4-8", 4, 6)).toBe(true);
    expect(isClaudeOpusAtLeast("claude-opus-5-5", 4, 8)).toBe(true);
    expect(isClaudeOpusAtLeast("claude-opus-4-5-20251101", 4, 8)).toBe(false);
    expect(isClaudeOpusAtLeast("claude-sonnet-5-5", 4, 8)).toBe(false);
  });

  test("keeps Opus 4.7 eligible and enables XHigh for every Opus 4.8+ version", () => {
    for (const model of [
      "claude-opus-4-7",
      "claude-opus-4.8",
      "claude-opus-4-8-20260604",
      "claude-opus-5",
      "claude-opus-5-5",
      "anthropic/claude-opus-5.5",
      "claude-opus-6",
    ]) {
      expect(supportsClaudeOpusXhigh(model)).toBe(true);
    }

    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4-20250514",
      "claude-sonnet-5-5",
      "not-claude-opus-5-5",
    ]) {
      expect(supportsClaudeOpusXhigh(model)).toBe(false);
    }
  });
});
