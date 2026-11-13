import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
let hasTransformers = false;
try { require.resolve("@huggingface/transformers"); hasTransformers = true; } catch { /* optional LanceDB dependency */ }

test.skipIf(!hasTransformers)("LanceDB's older Transformers consumer can decode, resize and crop with the Sharp override", () => {
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", `
    // Transformers 3.0.2 detects browsers by 'self', which Bun also exposes.
    // Select its Node image implementation in this isolated compatibility test.
    delete globalThis.self;
    const { RawImage } = await import('@huggingface/transformers');
    const { default: sharp } = await import('sharp');
    const bytes = await sharp({ create: { width: 9, height: 7, channels: 3, background: 'red' } }).png().toBuffer();
    const original = await RawImage.fromBlob(new Blob([bytes], { type: 'image/png' }));
    const resized = await original.resize(4, 3);
    const cropped = await resized.crop([0, 0, 2, 2]);
    console.log(JSON.stringify({ width: resized.width, height: resized.height, channels: resized.channels,
      cropped: [cropped.width, cropped.height], firstPixel: [...resized.data.slice(0, 3)] }));
  `], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ width: 4, height: 3, channels: 3,
    cropped: [3, 3], firstPixel: [255, 0, 0] });
});
