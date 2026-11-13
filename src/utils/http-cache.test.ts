import { describe, expect, test } from "bun:test";
import { ifNoneMatchSatisfies } from "./http-cache";

describe("ifNoneMatchSatisfies", () => {
  test("uses weak comparison for If-None-Match validators", () => {
    expect(ifNoneMatchSatisfies('"preset-1"', 'W/"preset-1"')).toBe(true);
    expect(ifNoneMatchSatisfies('W/"preset-1"', '"preset-1"')).toBe(true);
    expect(ifNoneMatchSatisfies('"other", W/"preset-1"', 'W/"preset-1"')).toBe(true);
  });

  test("rejects unequal validators while honoring wildcard", () => {
    expect(ifNoneMatchSatisfies('W/"other"', 'W/"preset-1"')).toBe(false);
    expect(ifNoneMatchSatisfies("*", 'W/"preset-1"')).toBe(true);
  });
});
