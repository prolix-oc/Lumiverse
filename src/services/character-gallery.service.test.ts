import { describe, expect, test } from "bun:test";
import { extractImageUrls } from "./character-gallery.service";

describe("extractImageUrls", () => {
  test("extracts markdown and html image embeds", () => {
    const text = [
      '![Alt](https://example.com/promo.png)',
      '<img src="https://example.com/banner.webp" alt="Banner">',
    ].join("\n");

    expect(extractImageUrls(text)).toEqual([
      "https://example.com/promo.png",
      "https://example.com/banner.webp",
    ]);
  });

  test("extracts bare direct image links and ignores non-image urls", () => {
    const text = [
      "Creator notes: https://example.com/portrait.jpg and https://example.com/readme",
      "Also accepts https://cdn.example.com/artwork.png?size=lg.",
    ].join(" ");

    expect(extractImageUrls(text)).toEqual([
      "https://example.com/portrait.jpg",
      "https://cdn.example.com/artwork.png?size=lg",
    ]);
  });

  test("trims trailing punctuation from bare direct image links", () => {
    const text = "See (https://example.com/scene.avif), [https://example.com/icon.svg].";

    expect(extractImageUrls(text)).toEqual([
      "https://example.com/scene.avif",
      "https://example.com/icon.svg",
    ]);
  });
});
