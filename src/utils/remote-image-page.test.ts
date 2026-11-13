import { describe, expect, test } from "bun:test";
import { extractRemoteImageUrlFromHtml } from "./remote-image-page";

describe("remote-image-page", () => {
  test("prefers og/twitter image metadata from shared page URLs", () => {
    const html = [
      "<!doctype html>",
      "<html><head>",
      '<meta property="og:image" content="https://media.tenor.com/abc123/tenor.gif">',
      '<meta name="twitter:image" content="https://media.tenor.com/abc123/tenor.webp">',
      "</head><body></body></html>",
    ].join("");

    expect(extractRemoteImageUrlFromHtml("https://tenor.com/view/example-gif-123", html)).toBe(
      "https://media.tenor.com/abc123/tenor.gif",
    );
  });

  test("resolves relative metadata URLs against the page URL", () => {
    const html = '<html><head><meta property="og:image" content="/images/preview.webp"></head></html>';

    expect(extractRemoteImageUrlFromHtml("https://example.com/posts/demo", html)).toBe(
      "https://example.com/images/preview.webp",
    );
  });

  test("falls back to image tags when metadata is absent", () => {
    const html = [
      "<html><body>",
      '<img src="/assets/logo.svg" alt="logo">',
      '<img src="https://cdn.example.com/animated/banner.webp" alt="banner">',
      "</body></html>",
    ].join("");

    expect(extractRemoteImageUrlFromHtml("https://example.com/post", html)).toBe(
      "https://cdn.example.com/animated/banner.webp",
    );
  });

  test("returns null when the page exposes no usable http image URLs", () => {
    const html = '<html><head><meta property="og:image" content="data:image/gif;base64,AAAA"></head></html>';

    expect(extractRemoteImageUrlFromHtml("https://example.com/post", html)).toBeNull();
  });
});
