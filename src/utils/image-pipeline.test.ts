import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "./sharp-config";
import type { Metadata } from "sharp";
import { detectImageContentType } from "./image-signature";
import {
  convertImageToPng,
  readImageMetadata,
  resizeInsideToWebp,
  writeInsideAvif,
  writeInsideWebp,
} from "./image-pipeline";

const workDir = mkdtempSync(join(tmpdir(), "lumiverse-bun-image-test-"));
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("Bun-native image pipeline", () => {
  test("reads metadata and converts supported bitmap inputs", async () => {
    expect(await readImageMetadata(onePixelPng)).toMatchObject({
      width: 1,
      height: 1,
      format: "png",
    });

    const webp = await resizeInsideToWebp(onePixelPng, 32, 32, 80, {
      withoutEnlargement: true,
    });
    expect(await readImageMetadata(webp)).toMatchObject({
      width: 1,
      height: 1,
      format: "webp",
    });

    const png = await convertImageToPng(webp);
    expect((await readImageMetadata(png)).format).toBe("png");
  });

  test("writes WebP output without buffering it in the caller", async () => {
    const destination = join(workDir, "thumbnail.webp");
    await writeInsideWebp(onePixelPng, destination, 32, 32, 80, {
      withoutEnlargement: true,
    });
    expect(await readImageMetadata(destination)).toMatchObject({
      width: 1,
      height: 1,
      format: "webp",
    });
  });

  test("writes AVIF output through Sharp", async () => {
    const destination = join(workDir, "thumbnail.avif");
    await writeInsideAvif(onePixelPng, destination, 32, 32, 54, {
      withoutEnlargement: true,
    });
    const bytes = Buffer.from(await Bun.file(destination).arrayBuffer());
    expect(detectImageContentType(bytes)).toBe("image/avif");
    expect(await sharp(bytes).metadata()).toMatchObject({
      format: "heif",
      compression: "av1",
    });
    expect(await readImageMetadata(destination)).toMatchObject({
      width: 1,
      height: 1,
      format: "avif",
    });
  });

  test("reports AVIF consistently when metadata falls back to Sharp", async () => {
    const destination = join(workDir, "fallback.avif");
    await writeInsideAvif(onePixelPng, destination, 32, 32, 54, {
      withoutEnlargement: true,
    });
    const bytes = Buffer.from(await Bun.file(destination).arrayBuffer());
    const nativeMetadata = spyOn(Bun.Image.prototype, "metadata")
      .mockRejectedValue(new Error("Native metadata unavailable"));
    try {
      for (const input of [destination, bytes]) {
        expect(await readImageMetadata(input)).toEqual({ width: 1, height: 1, format: "avif" });
      }
    } finally {
      nativeMetadata.mockRestore();
    }
  });

  test.each([["HEVC", "hevc"], ["unknown", undefined]] as const)("keeps %s HEIF metadata distinct from AVIF", async (_label, compression) => {
    const nativeMetadata = spyOn(Bun.Image.prototype, "metadata")
      .mockRejectedValue(new Error("Native metadata unavailable"));
    const fallbackMetadata = spyOn(sharp.prototype, "metadata")
      .mockResolvedValue({ format: "heif", compression, width: 1, height: 1 } as Metadata);
    try {
      expect(await readImageMetadata(onePixelPng)).toEqual({ width: 1, height: 1, format: "heif" });
    } finally {
      fallbackMetadata.mockRestore();
      nativeMetadata.mockRestore();
    }
  });

  test("falls back to Sharp for formats outside Bun.Image", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="red"/></svg>',
    );
    expect(await readImageMetadata(svg)).toMatchObject({
      width: 12,
      height: 8,
      format: "svg",
    });
    const webp = await resizeInsideToWebp(svg, 6, 6, 80);
    expect(await readImageMetadata(webp)).toMatchObject({
      width: 6,
      height: 4,
      format: "webp",
    });
  });
});
