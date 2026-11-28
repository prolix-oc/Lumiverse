import { expect, test } from "bun:test";
import { imagesRoutes } from "./images.routes";
import { animatedPng, animatedWebp } from "../utils/animated-image.test-fixtures";
import sharp from "../utils/sharp-config";

test.each(['png', 'webp'])('returns an animated %s crop without persisting an image', async type => {
  const form = new FormData();
  form.append('image', new File([new Uint8Array(type === 'png' ? animatedPng() : await animatedWebp())], `avatar.${type}`));
  form.append('crop', JSON.stringify({ x: 4, y: 4, width: 8, height: 8, outputWidth: 32, outputHeight: 32 }));
  const response = await imagesRoutes.request('/crop-animated', { method: 'POST', body: form });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/webp');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({ width: 32, height: 32, pages: 2, loop: 3, delay: [100, 250] });
});

test('rejects missing files, invalid crop bounds and excessive output sizes', async () => {
  for (const crop of [null, { x: -1, y: 0, width: 8, height: 8, outputWidth: 32, outputHeight: 32 }, { outputWidth: 99999, outputHeight: 32 }]) {
    const form = new FormData();
    form.append('image', new File([new Uint8Array(animatedPng())], 'avatar.png'));
    form.append('crop', JSON.stringify(crop));
    expect((await imagesRoutes.request('/crop-animated', { method: 'POST', body: form })).status).toBe(400);
  }
  expect((await imagesRoutes.request('/crop-animated', { method: 'POST', body: new FormData() })).status).toBe(400);
});
