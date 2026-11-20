import { describe, expect, test } from "bun:test";
import { applyRegexTrimStrings } from "./regex-trim";

describe("applyRegexTrimStrings", () => {
  test("ignores empty trim strings", () => {
    expect(applyRegexTrimStrings("hello world", [""])).toBe("hello world");
  });

  test("continues trimming occurrences formed by earlier removals", () => {
    expect(applyRegexTrimStrings("bbcc", ["bc"])).toBe("");
  });
});
