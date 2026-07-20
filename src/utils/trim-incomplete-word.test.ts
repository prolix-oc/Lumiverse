import { describe, expect, test } from "bun:test";
import { trimIncompleteTrailingWord } from "./trim-incomplete-word";

describe("trimIncompleteTrailingWord", () => {
  test("removes a trailing word that ends a cut-off stream", () => {
    expect(trimIncompleteTrailingWord("The lantern flick")).toBe("The lantern");
  });

  test("preserves completed boundaries", () => {
    expect(trimIncompleteTrailingWord("The lantern flickered. ")).toBe("The lantern flickered. ");
    expect(trimIncompleteTrailingWord("The lantern flickered.")).toBe("The lantern flickered.");
  });

  test("uses word segmentation for non-Latin scripts", () => {
    expect(trimIncompleteTrailingWord("これは途中の応答です")).toBe("これは途中の応答");
  });
});
