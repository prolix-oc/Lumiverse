import { describe, expect, test } from "bun:test";
import {
  createGalleryImageReference,
  createCanonicalGalleryImageReference,
  findCanonicalGalleryImageReference,
  findGalleryImageReference,
  galleryArchiveStem,
  galleryReferenceFromArchivePath,
  normalizeGalleryImageReferenceName,
  parseGalleryImageReference,
  parseCanonicalGalleryImageReference,
  remapGreetingBackgrounds,
} from "./gallery-image-reference";

describe("portable gallery image references", () => {
  test("round-trips a gallery token through its CharX archive path", () => {
    const token = "0198c28e-09a7-7000-8000-000000000001";
    const reference = createGalleryImageReference(token);

    expect(reference).toBe(`gallery://${token}`);
    expect(parseGalleryImageReference(reference)).toBe(token);
    expect(galleryArchiveStem(token)).toBe(`gallery_${token}`);
    expect(galleryReferenceFromArchivePath(`assets/other/image/gallery_${token}.webp`)).toBe(reference);
  });

  test("prefers the gallery item's own reference before an imported alias", () => {
    const map = {
      "gallery://imported": "image-1",
      "gallery://local": "image-1",
    };
    expect(findGalleryImageReference(map, "image-1", "local")).toBe("gallery://local");
    expect(findGalleryImageReference(map, "image-1", "missing")).toBe("gallery://imported");
  });

  test("selects human-readable character-scoped image slots", () => {
    const map = {
      "gallery://0198c28e-09a7-7000-8000-000000000001": "image-id",
      "gallery://image-2": "image-id",
      "gallery://image-1": "other-image",
    };
    expect(createCanonicalGalleryImageReference(3)).toBe("gallery://image-3");
    expect(parseCanonicalGalleryImageReference("gallery://image-2")).toBe(2);
    expect(findCanonicalGalleryImageReference(map, "image-id")).toBe("gallery://image-2");
  });

  test("rejects paths that cannot be safe archive names", () => {
    expect(parseGalleryImageReference("gallery://../escape")).toBeNull();
    expect(galleryReferenceFromArchivePath("assets/other/image/not_gallery.png")).toBeNull();
  });

  test("normalizes friendly custom names into portable tokens", () => {
    expect(normalizeGalleryImageReferenceName("  Gallery://Hero's R\u00e9sum\u00e9  ")).toBe("heros-resume");
    expect(normalizeGalleryImageReferenceName("Beach___Scene.png")).toBe("beach___scene.png");
    expect(() => normalizeGalleryImageReferenceName("--- \ud83c\udf0a ---")).toThrow(
      "Reference name must contain at least one letter or number",
    );
  });

  test("round-trips greeting backgrounds through portable gallery references", () => {
    const localBackgrounds = {
      0: "old-main-image-id",
      2: "old-alternate-image-id",
      future: { preserved: true },
    };
    const portable = remapGreetingBackgrounds(localBackgrounds, new Map([
      ["old-main-image-id", "gallery://image-1"],
      ["old-alternate-image-id", "gallery://image-4"],
    ]));

    expect(portable).toEqual({
      0: "gallery://image-1",
      2: "gallery://image-4",
      future: { preserved: true },
    });
    expect(remapGreetingBackgrounds(portable, new Map([
      ["gallery://image-1", "new-main-image-id"],
      ["gallery://image-4", "new-alternate-image-id"],
    ]))).toEqual({
      0: "new-main-image-id",
      2: "new-alternate-image-id",
      future: { preserved: true },
    });
    expect(localBackgrounds).toEqual({
      0: "old-main-image-id",
      2: "old-alternate-image-id",
      future: { preserved: true },
    });
  });
});
