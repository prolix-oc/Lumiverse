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

function nativeCaptureReplacements(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
): CaptureReplacement[] {
  return runRegexRequest({
    id: "native-capture-replacements",
    op: "capture-replacements",
    pattern,
    flags,
    input,
    replacement,
    replacementMode: "native",
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

  test("substitutes unmatched named groups as empty, keeps unknown names untouched", () => {
    const pattern = "(?<word>[a-z]+)(?:-(?<suffix>[a-z]+))?";
    const input = "gamma alpha-beta";
    const replacement = "<$<word>|$<suffix>|$<missing>>";

    const results = captureReplacements(pattern, "g", input, replacement);
    expect(results).toHaveLength(2);
    // "gamma": suffix is defined but absent → empty; "missing" is unknown → literal.
    expect(results[0].replacement).toBe("<gamma||$<missing>>");
    // "alpha-beta": suffix captured.
    expect(results[1].replacement).toBe("<alpha|beta|$<missing>>");
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

describe("terminal-literal search window", () => {
  test("skips a large unterminated tail without changing completed replacements", () => {
    const fields = Array.from({ length: 21 }, (_, index) => `field${index + 1}`);
    const fieldPattern = String.raw`([^\]|]+)`;
    const pattern = String.raw`\[METER\|${Array.from({ length: 21 }, () => fieldPattern).join(String.raw`\|`)}\]([\s\S]*?)\[\/METER\]`;
    const valid = `[METER|${fields.join("|")}]body[/METER]`;
    const incomplete = `[METER|${fields.join("|")}]${"body ".repeat(5)}`;
    const input = valid + incomplete.repeat(3_000);

    const result = runRegexRequest({
      id: "bounded-replace",
      op: "replace",
      pattern,
      flags: "gi",
      input,

      replacement: "<$1>",
    });
    expect(result).toBe(`<field1>${incomplete.repeat(3_000)}`);
  });

  test("preserves full-suffix replacement semantics", () => {
    const input = "fooENDING trailing";
    const request = {
      id: "suffix-replacement",
      op: "replace" as const,
      pattern: "fooENDING",
      flags: "g",
      input,
      replacement: "$'",
    };
    expect(runRegexRequest(request)).toBe(input.replace(/fooENDING/g, "$'"));
  });
});
describe("native replacement semantics", () => {
  test("matches native String.replace for every replacement token", () => {
    const pattern = "(?<word>ab)(c)?";
    const flags = "";
    const input = "prefix abc suffix";
    const replacements = [
      "$&",
      "$$",
      "$`",
      "$'",
      "$1",
      "$2",
      "$3",
      "$10",
      "$<word>",
      "$<missing>",
      "$0",
      "$01",
      "$100",
    ];

    for (const replacement of replacements) {
      const native = input.replace(new RegExp(pattern, flags), replacement);
      expect(runRegexRequest({
        id: `native-${replacement}`,
        op: "replace",
        pattern,
        flags,
        input,
        replacement,
      })).toBe(native);
      expect(runRegexRequest({
        id: `native-test-${replacement}`,
        op: "test",
        pattern,
        flags,
        input,
        replacement,
      })).toEqual({ result: native, matches: 1 });
      const nativeMatches = nativeCaptureReplacements(pattern, flags, input, replacement);
      const matchIndex = input.indexOf("abc");
      const matchLength = "abc".length;
      expect(nativeMatches).toEqual([{
        index: matchIndex,
        matchLength,
        replacement: native.slice(matchIndex, native.length - (input.length - matchIndex - matchLength)),
      }]);
    }
  });
});

describe("capture materialization limits", () => {
  test("rejects a match with too many capture groups before materializing it", () => {
    const groupCount = 1_025;
    expect(() => collect(`(a)`.repeat(groupCount), "", "a".repeat(groupCount))).toThrow(
      "capture group count",
    );
  });

  test("rejects a large repeated capture before cloning its bytes", () => {
    const input = "a".repeat(2 * 1024 * 1024);
    expect(() => collect("(a+)", "", input)).toThrow("capture bytes");
  });

  test("rejects cumulative capture bytes even below the match-count cap", () => {
    const input = "a".repeat(4_500_000);
    expect(() => collect("(.{9000})", "g", input)).toThrow("capture bytes");
  });

  test("rejects excessive match counts", () => {
    expect(() => collect("a", "g", "a".repeat(1_025))).toThrow("Regex matched more than 1024 times");
  });
});
