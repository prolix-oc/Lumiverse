import { describe, expect, test } from "bun:test";
import {
  detectImageContentType,
  isSupportedProxyImageContentType,
  normalizeImageContentType,
  validateImageMagicBytes,
} from "./image-signature";

describe("image-signature", () => {
  test("normalizes content types and recognizes supported proxied raster formats", () => {
    expect(normalizeImageContentType("image/webp; charset=binary")).toBe("image/webp");
    expect(normalizeImageContentType(null)).toBe("");
    expect(isSupportedProxyImageContentType("image/gif")).toBe(true);
    expect(isSupportedProxyImageContentType("image/svg+xml")).toBe(false);
  });

  test("validates common animated and static raster image signatures", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00]);
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66,
      0x00, 0x00, 0x00, 0x00,
      0x61, 0x76, 0x69, 0x66,
      0x6D, 0x69, 0x66, 0x31,
    ]);

    expect(validateImageMagicBytes(png, "image/png")).toBe(true);
    expect(validateImageMagicBytes(png, "image/apng")).toBe(true);
    expect(validateImageMagicBytes(jpeg, "image/jpeg")).toBe(true);
    expect(validateImageMagicBytes(gif, "image/gif")).toBe(true);
    expect(validateImageMagicBytes(webp, "image/webp")).toBe(true);
    expect(validateImageMagicBytes(avif, "image/avif")).toBe(true);
  });

  test("detects raster image types from bytes when headers are weak or missing", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);

    expect(detectImageContentType(gif)).toBe("image/gif");
    expect(detectImageContentType(webp)).toBe("image/webp");
    expect(detectImageContentType(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull();
  });

  test("rejects mismatched or malformed raster data", () => {
    const random = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00]);

    expect(validateImageMagicBytes(random, "image/gif")).toBe(false);
    expect(validateImageMagicBytes(png, "image/webp")).toBe(false);
    expect(validateImageMagicBytes(new Uint8Array([]), "image/png")).toBe(false);
  });
});
