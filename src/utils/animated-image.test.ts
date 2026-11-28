import { describe, expect, test } from "bun:test";
import sharp from "./sharp-config";
import { animatedPng, animatedWebp } from "./animated-image.test-fixtures";
import { imageAnimationType } from "../shared/image-animation";
import { transformAnimatedImage } from "./animated-image";

const options = { width: 8, height: 8, quality: 100 };
const pixel = async (bytes: Buffer, frame: number, x = 0, y = 0) => {
  const { data, info } = await sharp(bytes, { page: frame }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
};
const closeColor = (actual: number[], expected: number[]) => actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(5));

describe("animated avatars", () => {
  test.each(['apng', 'webp'] as const)('resizes and crops %s while preserving frames, delays and finite loops', async type => {
    const source = type === 'apng' ? animatedPng() : await animatedWebp();
    expect(imageAnimationType(source)).toBe(type);
    for (const crop of [undefined, { x: 4, y: 4, width: 8, height: 8 }]) {
      const result = await transformAnimatedImage(source, { ...options, crop });
      expect(await sharp(result).metadata()).toMatchObject({ width: 8, height: 8, pages: 2, loop: 3, delay: [100, 250] });
      closeColor(await pixel(result, 0), [255, 0, 0, 255]);
      closeColor(await pixel(result, 1), [0, 0, 255, 255]);
    }
  });

  test('excludes a separate default poster from APNG animation', async () => {
    const result = await transformAnimatedImage(animatedPng(undefined, true), options);
    expect((await sharp(result).metadata()).pages).toBe(2);
    closeColor(await pixel(result, 0), [255, 0, 0, 255]);
  });

  test('applies partial-frame alpha blending and restores previous/background disposal', async () => {
    const result = await transformAnimatedImage(animatedPng([
      { color: [255, 0, 0, 255] },
      { color: [0, 0, 255, 128], width: 8, height: 16, blend: 1, dispose: 2 },
      { color: [0, 255, 0, 255], x: 8, width: 8, height: 16, dispose: 1 },
      { color: [0, 0, 255, 255], width: 8, height: 8 },
    ]), { ...options, width: 16, height: 16 });
    closeColor(await pixel(result, 1), [127, 0, 128, 255]);
    closeColor(await pixel(result, 2), [255, 0, 0, 255]);
    expect((await pixel(result, 3, 12, 12))[3]).toBe(0);
    closeColor(await pixel(result, 3), [0, 0, 255, 255]);
  });

  test('rejects invalid bounds, truncated data and oversized frame declarations', async () => {
    await expect(transformAnimatedImage(animatedPng(), { ...options, crop: { x: -1, y: 0, width: 1, height: 1 } })).rejects.toThrow('crop bounds');
    await expect(transformAnimatedImage(animatedPng().subarray(0, -15), options)).rejects.toThrow();
    await expect(transformAnimatedImage(animatedPng(Array.from({ length: 1001 }, () => ({ color: [0, 0, 0, 255] }))), options)).rejects.toThrow('too large');
    await expect(transformAnimatedImage(Buffer.from('not an image'), options)).rejects.toThrow('Expected an animated');
    expect(imageAnimationType(Buffer.from('metadata acTL ANIM'))).toBeNull();
  });
});
