import { describe, expect, test } from "bun:test";
import {
  createGalleryImageReference,
  createCanonicalGalleryImageReference,
  findCanonicalGalleryImageReference,
  findGalleryImageReference,
  galleryArchiveStem,
  galleryReferenceFromArchivePath,
  parseGalleryImageReference,
  parseCanonicalGalleryImageReference,
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
});
