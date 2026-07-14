import { describe, expect, test } from "bun:test";
import {
  runRegexRequest,
  substituteRegexCaptures,
  type CaptureReplacement,
  type CollectedMatch,
} from "./regex-sandbox-core";

function collect(pattern: string, flags: string, input: string): CollectedMatch[] {
  return runRegexRequest({ id: "collect", op: "collect", pattern, flags, input }) as CollectedMatch[];
}

function captureReplacements(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
): CaptureReplacement[] {
  return runRegexRequest({
    id: "capture-replacements",
    op: "capture-replacements",
    pattern,
    flags,
    input,
    replacement,
  }) as CaptureReplacement[];
}

function legacyCaptureReplacements(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
): CaptureReplacement[] {
  return collect(pattern, flags, input).map((match) => ({
    index: match.index,
    matchLength: match.fullMatch.length,
    replacement: substituteRegexCaptures(
      replacement,
      match.fullMatch,
      match.groups,
      match.index,
      input,
      match.namedGroups,
    ),
  }));
}

describe("capture-replacements regex operation", () => {
  test("preserves raw-mode capture substitution semantics", () => {
    const pattern = "(?<word>[a-z]+)(?:-(?<suffix>[a-z]+))?";
    const input = "before alpha-beta and gamma after";
    const replacement = "$$|$&|$`|$'|$1|$2|$3|$<word>|$<suffix>|$<missing>";

    expect(captureReplacements(pattern, "g", input, replacement)).toEqual(
      legacyCaptureReplacements(pattern, "g", input, replacement),
    );
  });

  test("handles global zero-length and sticky matches identically", () => {
    for (const testCase of [
      { pattern: "(?=(a))", flags: "g", input: "aa", replacement: "<$1>" },
      { pattern: "(a)?", flags: "y", input: "aa", replacement: "<$1>" },
      { pattern: "(a)", flags: "", input: "ba", replacement: "<$1>" },
    ]) {
      expect(captureReplacements(
        testCase.pattern,
        testCase.flags,
        testCase.input,
        testCase.replacement,
      )).toEqual(legacyCaptureReplacements(
        testCase.pattern,
        testCase.flags,
        testCase.input,
        testCase.replacement,
      ));
    }
  });

  test("keeps a 300-group result proportional to matches, not captures", () => {
    const groupCount = 300;
    const pattern = "(a)".repeat(groupCount);
    const input = "a".repeat(groupCount * 3);
    const replacement = "$1|$99|$100";
    const result = captureReplacements(pattern, "g", input, replacement);

    expect(result).toEqual(legacyCaptureReplacements(pattern, "g", input, replacement));
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      index: 0,
      matchLength: groupCount,
      replacement: "a|a|a0",
    });
    expect("groups" in result[0]).toBe(false);
    expect("fullMatch" in result[0]).toBe(false);
  });
});
