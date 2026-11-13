import { describe, expect, test } from "bun:test";
import { getAssociativeRegexAppend } from "./prompt-assembly.service";

describe("associative regex prompt append", () => {
  test("reads only bounded action content from message metadata", () => {
    expect(getAssociativeRegexAppend({
      associative_regex_append: [
        { content: "Take the north trail", action_id: "north" },
        { content: "Pack a lantern", action_id: "lantern" },
        { content: 42 },
      ],
    })).toBe("Take the north trail\nPack a lantern");
  });

  test("ignores malformed metadata", () => {
    expect(getAssociativeRegexAppend({ associative_regex_append: "visible" })).toBe("");
    expect(getAssociativeRegexAppend(undefined)).toBe("");
  });
});
