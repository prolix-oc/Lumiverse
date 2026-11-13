import { describe, expect, test } from "bun:test";
import { readChubFullPath } from "./chub-api.service";

/**
 * Cards acquired at different times record their Chub origin in different
 * places, so a backfill has to resolve all of them to find the source the
 * Identity tab shows. This mirrors the frontend's readChubFullPath.
 */
describe("readChubFullPath", () => {
  test("reads the slug the URL importer stamps", () => {
    expect(readChubFullPath({ _lumiverse_chub_slug: "anonymous/chloe-4e6be6dd378b" })).toBe(
      "anonymous/chloe-4e6be6dd378b",
    );
  });

  test("reads the portable path carried inside the card", () => {
    expect(readChubFullPath({ chub: { full_path: "Anonymous/chloe-4e6be6dd378b" } })).toBe(
      "Anonymous/chloe-4e6be6dd378b",
    );
    expect(readChubFullPath({ chub: { fullPath: "Anonymous/chloe" } })).toBe("Anonymous/chloe");
  });

  test("prefers the card's own path over the importer's stamp", () => {
    const resolved = readChubFullPath({
      chub: { full_path: "Real/card" },
      _lumiverse_chub_slug: "stale/card",
    });
    expect(resolved).toBe("Real/card");
  });

  test.each([
    ["https://chub.ai/characters/Anonymous/chloe", "Anonymous/chloe"],
    ["https://www.chub.ai/characters/Anonymous/chloe", "Anonymous/chloe"],
    ["https://characterhub.org/characters/Anonymous/chloe", "Anonymous/chloe"],
    ["https://chub.ai/Anonymous/chloe", "Anonymous/chloe"],
  ])("parses a full URL: %s", (url, expected) => {
    expect(readChubFullPath({ _lumiverse_chub_slug: url })).toBe(expected);
  });

  test("decodes percent-encoded segments", () => {
    expect(readChubFullPath({ _lumiverse_chub_slug: "https://chub.ai/characters/A%20User/my%20card" })).toBe(
      "A User/my card",
    );
  });

  test("strips surrounding slashes and whitespace", () => {
    expect(readChubFullPath({ _lumiverse_chub_slug: "  /Anonymous/chloe/  " })).toBe("Anonymous/chloe");
  });

  describe("returns null rather than a guess", () => {
    test.each([
      ["undefined", undefined],
      ["null", null],
      ["a string", "Anonymous/chloe"],
      ["an array", []],
      ["no chub provenance", { fav: false }],
      ["empty slug", { _lumiverse_chub_slug: "" }],
      ["whitespace slug", { _lumiverse_chub_slug: "   " }],
      ["non-string slug", { _lumiverse_chub_slug: 42 }],
      ["a non-Chub host", { _lumiverse_chub_slug: "https://example.com/characters/a/b" }],
      ["an unparseable URL", { _lumiverse_chub_slug: "https://" }],
    ])("%s", (_label, extensions) => {
      expect(readChubFullPath(extensions)).toBeNull();
    });
  });

  describe("rejects shapes that would widen the API path", () => {
    // The result is interpolated into `characters/{slug}?full=true`, so a
    // value with the wrong segment count must not reach the request.
    test.each([
      ["one segment", "justacreator"],
      ["three segments", "creator/card/extra"],
      ["traversal", "../../admin/secrets"],
      ["leading slash only", "/"],
    ])("%s", (_label, slug) => {
      expect(readChubFullPath({ _lumiverse_chub_slug: slug })).toBeNull();
    });
  });
});
