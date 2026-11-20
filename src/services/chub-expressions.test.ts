import { describe, expect, test } from "bun:test";
import { extractChubExpressionAssets } from "./chub-api.service";

/**
 * The shape below is copied from a real `?full=true` response
 * (Anonymous/chloe-4e6be6dd378b), trimmed to three of its 28 entries. Chub
 * publishes expression packs as a separate authenticated zip, which made them
 * look unreachable — but the labelled URLs ride along in the payload the
 * importer already fetches.
 */
function chubNode(expressions: unknown, extras: Record<string, unknown> = {}) {
  return {
    id: 2225508,
    definition: {
      name: "Chloe",
      extensions: {
        fav: false,
        chub: {
          id: 2225508,
          full_path: "Anonymous/chloe-4e6be6dd378b",
          expressions,
          ...extras,
        },
      },
    },
  };
}

const REAL_PACK = {
  version: "default",
  compressed: "",
  is_default: true,
  expressions: {
    joy: "https://avatars.charhub.io/avatars/uploads/images/gallery/file/8e4aaf78-dc0f-4fc8-a1a8-d433148f4b69/30c35708-8594-41ca-b008-967b7defbd04.png",
    anger: "https://avatars.charhub.io/avatars/uploads/images/gallery/file/14e4ea31-2224-4233-8d8c-3a770a0aa818/0ca06ac6-e48d-4ae2-bfbd-6d4f22789afc.png",
    embarrassment:
      "https://avatars.charhub.io/avatars/uploads/images/gallery/file/03bb57c7-9ba2-4475-8d4e-d581513cb5f7/5d5d6084-77b9-4ee8-8010-5ce923bbae35.png",
  },
};

describe("extractChubExpressionAssets", () => {
  test("reads labelled URLs out of a real Chub payload", () => {
    const assets = extractChubExpressionAssets(chubNode(REAL_PACK));
    expect(assets).toHaveLength(3);
    expect(assets.map((a) => a.label).sort()).toEqual(["anger", "embarrassment", "joy"]);
    expect(assets.find((a) => a.label === "joy")?.url).toBe(REAL_PACK.expressions.joy);
  });

  test("labels survive verbatim, since they key the expression mapping", () => {
    const assets = extractChubExpressionAssets(
      chubNode({ expressions: { "very happy": "https://example.com/a.png" } }),
    );
    expect(assets[0]?.label).toBe("very happy");
  });

  test("trims surrounding whitespace on labels and URLs", () => {
    const assets = extractChubExpressionAssets(
      chubNode({ expressions: { "  joy  ": "  https://example.com/a.png  " } }),
    );
    expect(assets).toEqual([{ label: "joy", url: "https://example.com/a.png" }]);
  });

  test("ignores the surrounding version/compressed fields", () => {
    // Only the inner map matters; an unfamiliar wrapper must not disable import.
    const assets = extractChubExpressionAssets(
      chubNode({ version: "v9-unknown", compressed: "SOMEBLOB", is_default: false, expressions: REAL_PACK.expressions }),
    );
    expect(assets).toHaveLength(3);
  });

  describe("returns nothing rather than guessing", () => {
    test.each([
      ["no node", undefined],
      ["null node", null],
      ["no definition", { id: 1 }],
      ["no extensions", { definition: {} }],
      ["no chub extension", { definition: { extensions: {} } }],
      ["no expressions block", { definition: { extensions: { chub: {} } } }],
      ["empty map", { definition: { extensions: { chub: { expressions: { expressions: {} } } } } }],
      ["map is an array", { definition: { extensions: { chub: { expressions: { expressions: [] } } } } }],
      ["map is a string", { definition: { extensions: { chub: { expressions: { expressions: "x" } } } } }],
    ])("%s", (_label, node) => {
      expect(extractChubExpressionAssets(node)).toEqual([]);
    });
  });

  test("skips entries that are not usable image URLs", () => {
    const assets = extractChubExpressionAssets(
      chubNode({
        expressions: {
          good: "https://example.com/good.png",
          insecure: "http://example.com/bad.png",
          relative: "/avatars/bad.png",
          dataUri: "data:image/png;base64,AAAA",
          notAString: 42,
          empty: "",
          "   ": "https://example.com/blank-label.png",
        },
      }),
    );
    expect(assets).toEqual([{ label: "good", url: "https://example.com/good.png" }]);
  });

  test("does not confuse the generic Expression Packs extension for a pack", () => {
    // related_extensions points at a shared community extension, not the
    // character's own images — it must not produce assets.
    const assets = extractChubExpressionAssets(
      chubNode(undefined, {
        extensions: [
          {
            extension_id: 2108776,
            extension_path: "extensions/BartlebyTheScrivener/expressions-extension-768927333d4d",
          },
        ],
      }),
    );
    expect(assets).toEqual([]);
  });
});
