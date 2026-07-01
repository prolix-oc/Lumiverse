import { describe, expect, test } from "bun:test";
import { extractChubGalleryUrls } from "./chub-api.service";

describe("extractChubGalleryUrls", () => {
  test("reads gallery urls from primary_image_path entries", () => {
    const urls = extractChubGalleryUrls({
      count: 3,
      nodes: [
        { primary_image_path: "https://images.characterhub.org/gallery/a.webp" },
        { primary_image_path: "https://images.characterhub.org/gallery/b.webp" },
        { primary_image_path: "https://images.characterhub.org/gallery/a.webp" },
      ],
    });

    expect(urls).toEqual([
      "https://images.characterhub.org/gallery/a.webp",
      "https://images.characterhub.org/gallery/b.webp",
    ]);
  });

  test("ignores invalid gallery nodes", () => {
    const urls = extractChubGalleryUrls({
      nodes: [
        null,
        {},
        { primary_image_path: 42 },
        { image_path: "https://images.characterhub.org/gallery/c.webp" },
      ],
    });

    expect(urls).toEqual(["https://images.characterhub.org/gallery/c.webp"]);
  });
});
