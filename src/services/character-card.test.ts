import { describe, expect, test } from "bun:test";
import { embedPngTextChunk } from "./character-export.service";
import {
  detectCharacterImportFormat,
  extractCardFromPng,
  normalizeJannyCharacterInput,
  resolveInlineAssetReferences,
} from "./character-card.service";

const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

describe("character card import format detection", () => {
  test("prefers PNG bytes over incorrect mobile MIME metadata", async () => {
    const cardJson = JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { name: "Mobile PNG Test" },
    });
    const pngWithCard = embedPngTextChunk(
      Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
      "ccv3",
      Buffer.from(cardJson, "utf-8").toString("base64"),
    );

    const mislabeledFile = new File([new Uint8Array(pngWithCard)], "mobile-upload.jpg", { type: "image/jpeg" });

    expect(await detectCharacterImportFormat(mislabeledFile)).toBe("png");
    await expect(extractCardFromPng(mislabeledFile)).resolves.toMatchObject({ name: "Mobile PNG Test" });
  });
});

describe("normalizeJannyCharacterInput", () => {
  test("moves Janny creator notes out of personality and leaves personality blank", () => {
    expect(normalizeJannyCharacterInput({
      name: "Janny Test",
      description: "Visible personality text",
      personality: "OOC creator notes",
    })).toMatchObject({
      name: "Janny Test",
      description: "Visible personality text",
      personality: "",
      creator_notes: "OOC creator notes",
    });
  });

  test("falls back to the imported personality field for description when needed", () => {
    expect(normalizeJannyCharacterInput({
      name: "Janny Fallback",
      personality: "Imported site personality",
    })).toMatchObject({
      name: "Janny Fallback",
      description: "Imported site personality",
      personality: "",
      creator_notes: "Imported site personality",
    });
  });
});

describe("resolveInlineAssetReferences", () => {
  test("keeps portable gallery URIs while resolving ordinary CharX asset names", () => {
    const assetMap = new Map([
      ["assets/other/image/gallery_portable.webp", "local-gallery-image"],
      ["assets/other/image/expression.webp", "local-expression-image"],
    ]);

    expect(resolveInlineAssetReferences({
      first_mes: "![Scene](gallery://portable) ![Smile](expression.webp)",
    }, assetMap)).toEqual({
      first_mes: "![Scene](gallery://portable) ![Smile](/api/v1/images/local-expression-image)",
    });
  });
});
