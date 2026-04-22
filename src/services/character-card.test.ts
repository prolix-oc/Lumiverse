import { describe, expect, test } from "bun:test";
import { embedPngTextChunk } from "./character-export.service";
import { detectCharacterImportFormat, extractCardFromPng } from "./character-card.service";

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

    const mislabeledFile = new File([pngWithCard], "mobile-upload.jpg", { type: "image/jpeg" });

    expect(await detectCharacterImportFormat(mislabeledFile)).toBe("png");
    await expect(extractCardFromPng(mislabeledFile)).resolves.toMatchObject({ name: "Mobile PNG Test" });
  });
});
