import { describe, expect, test } from "bun:test";
import { extractBotBooruGalleryUrls } from "./botbooru-api.service";

describe("extractBotBooruGalleryUrls", () => {
  test("extracts approved full-resolution downloads in API order", () => {
    expect(extractBotBooruGalleryUrls({
      images: [
        {
          id: 12614,
          status: "approved",
          download_url: "/mini-gallery/12614/download.png",
          preview_url: "/mini-gallery/12614/preview/480?v=abc",
        },
        {
          id: 12615,
          status: "approved",
          download_url: "/mini-gallery/12615/download.png",
        },
      ],
    })).toEqual([
      "https://botbooru.com/mini-gallery/12614/download.png",
      "https://botbooru.com/mini-gallery/12615/download.png",
    ]);
  });

  test("falls back to the raw image and rejects unsafe or unavailable entries", () => {
    expect(extractBotBooruGalleryUrls({
      images: [
        { status: "pending", download_url: "/mini-gallery/1/download.png" },
        { status: "approved", url: "/mini-gallery/2?v=rev" },
        { status: "approved", download_url: "https://example.com/image.png" },
        { status: "approved", download_url: "/mini-gallery/2?v=rev" },
        null,
      ],
    })).toEqual(["https://botbooru.com/mini-gallery/2?v=rev"]);
  });

  test("returns an empty list for malformed payloads", () => {
    expect(extractBotBooruGalleryUrls(null)).toEqual([]);
    expect(extractBotBooruGalleryUrls({ images: {} })).toEqual([]);
  });
});
