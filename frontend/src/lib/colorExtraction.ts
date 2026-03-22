/**
 * Multi-region color extraction from images.
 *
 * Samples several regions of an image and returns a rich palette:
 *   - dominant: overall most common color
 *   - regions: per-region dominant colors (top, center, bottom, left, right)
 *   - average: simple average across all sampled pixels
 *   - isLight: whether the dominant color is perceived as light
 */

export type RGB = { r: number; g: number; b: number }

export interface ImagePalette {
  dominant: RGB
  regions: {
    top: RGB
    center: RGB
    bottom: RGB
    left: RGB
    right: RGB
  }
  average: RGB
  isLight: boolean
}

// ── Public helpers ──

export function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

export function shiftTowards(color: RGB, target: RGB, weight: number): RGB {
  const w = Math.max(0, Math.min(1, weight))
  return {
    r: Math.round(color.r + (target.r - color.r) * w),
    g: Math.round(color.g + (target.g - color.g) * w),
    b: Math.round(color.b + (target.b - color.b) * w),
  }
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max - min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

// ── Image loading ──

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// ── Dominant color from pixel data ──

function dominantFromData(data: Uint8ClampedArray): RGB {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const qr = Math.round(r / 24) * 24
    const qg = Math.round(g / 24) * 24
    const qb = Math.round(b / 24) * 24
    const key = `${qr}-${qg}-${qb}`
    const hit = buckets.get(key)
    if (hit) {
      hit.count += 1
      hit.r += r
      hit.g += g
      hit.b += b
    } else {
      buckets.set(key, { count: 1, r, g, b })
    }
  }

  let best: { count: number; r: number; g: number; b: number } | null = null
  buckets.forEach((bucket) => {
    if (!best || bucket.count > best.count) best = bucket
  })

  if (!best || best.count === 0) return { r: 128, g: 128, b: 128 }
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  }
}

function averageFromData(data: Uint8ClampedArray): RGB {
  let rSum = 0, gSum = 0, bSum = 0, count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    rSum += data[i]
    gSum += data[i + 1]
    bSum += data[i + 2]
    count++
  }
  if (count === 0) return { r: 128, g: 128, b: 128 }
  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  }
}

// ── Region sampling ──

const SAMPLE_SIZE = 48

interface Region { x: number; y: number; w: number; h: number }

function getRegions(w: number, h: number): Record<string, Region> {
  const third_w = Math.floor(w / 3)
  const third_h = Math.floor(h / 3)
  return {
    top:    { x: third_w, y: 0, w: third_w, h: third_h },
    center: { x: third_w, y: third_h, w: third_w, h: third_h },
    bottom: { x: third_w, y: third_h * 2, w: third_w, h: third_h },
    left:   { x: 0, y: third_h, w: third_w, h: third_h },
    right:  { x: third_w * 2, y: third_h, w: third_w, h: third_h },
  }
}

// ── Main extraction ──

export async function extractPalette(src: string): Promise<ImagePalette> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    const grey: RGB = { r: 128, g: 128, b: 128 }
    return { dominant: grey, regions: { top: grey, center: grey, bottom: grey, left: grey, right: grey }, average: grey, isLight: false }
  }

  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

  // Full-image analysis
  const fullData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  const dominant = dominantFromData(fullData)
  const average = averageFromData(fullData)

  // Per-region analysis
  const regionDefs = getRegions(SAMPLE_SIZE, SAMPLE_SIZE)
  const regions = {} as ImagePalette['regions']
  for (const [name, rect] of Object.entries(regionDefs)) {
    const regionData = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data
    ;(regions as any)[name] = dominantFromData(regionData)
  }

  const isLight = luminance(dominant.r, dominant.g, dominant.b) > 152

  return { dominant, regions, average, isLight }
}

/**
 * Lightweight single-color extraction (backwards compatible with original).
 */
export async function extractDominantColor(src: string): Promise<RGB> {
  const palette = await extractPalette(src)
  return palette.dominant
}
