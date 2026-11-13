/**
 * Compress a persona avatar to a small WebP blob for multiplayer broadcast.
 *
 * We deliberately send a URL (after uploading this blob), NOT raw bytes over the
 * WS text frame — base64 over JSON would bloat every persona change ~33% and
 * block other events. The server re-hosts the WebP and broadcasts its URL.
 *
 * No WebP encoder exists in the app today (cropImage.ts emits PNG); this uses
 * the browser-native `canvas.toBlob(_, 'image/webp', q)`.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('avatar image load failed'))
    img.src = src
  })
}

/** Draw `img` center-cropped to fill a `size`×`size` square (object-fit: cover). */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number): void {
  const scale = Math.max(size / img.width, size / img.height)
  const w = img.width * scale
  const h = img.height * scale
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
}

/**
 * Compress an avatar at `srcUrl` to a square WebP blob.
 * @param size  output edge in px (default 192 — tiny, ~<15KB, matches the sm tier)
 * @param quality 0..1 (default 0.8)
 */
export async function compressAvatarToWebP(
  srcUrl: string,
  size = 192,
  quality = 0.8,
): Promise<Blob> {
  const img = await loadImage(srcUrl)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  drawCover(ctx, img, size)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('webp encode failed'))),
      'image/webp',
      quality,
    )
  })
}
