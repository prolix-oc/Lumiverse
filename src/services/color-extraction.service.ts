/**
 * Server-side color extraction from images using sharp.
 * Mirrors the frontend colorExtraction.ts algorithm but uses
 * sharp's raw pixel data instead of Canvas.
 */

import sharp from "sharp";
import { join } from "path";
import { env } from "../env";
import { getDb } from "../db/connection";

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

export interface ColorExtractionResult {
  dominant: RGB;
  regions: {
    top: RGB;
    center: RGB;
    bottom: RGB;
    left: RGB;
    right: RGB;
  };
  flatness: {
    top: number;
    center: number;
    bottom: number;
    left: number;
    right: number;
    full: number;
  };
  average: RGB;
  isLight: boolean;
  dominantHsl: HSL;
}

const SAMPLE_SIZE = 48;

function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max - min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

interface DominantResult { color: RGB; flatness: number }

function dominantFromPixels(data: Buffer, channels: number, pixelCount: number): DominantResult {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let totalOpaque = 0;

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    // Skip transparent pixels (if alpha channel exists)
    if (channels === 4 && data[offset + 3] < 48) continue;
    totalOpaque++;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const qr = Math.round(r / 24) * 24;
    const qg = Math.round(g / 24) * 24;
    const qb = Math.round(b / 24) * 24;
    const key = `${qr}-${qg}-${qb}`;
    const hit = buckets.get(key);
    if (hit) {
      hit.count += 1;
      hit.r += r;
      hit.g += g;
      hit.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }

  if (!best || best.count === 0) return { color: { r: 128, g: 128, b: 128 }, flatness: 1 };
  const flatness = totalOpaque > 0 ? best.count / totalOpaque : 1;
  return {
    color: {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
    },
    flatness,
  };
}

function averageFromPixels(data: Buffer, channels: number, pixelCount: number): RGB {
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    if (channels === 4 && data[offset + 3] < 48) continue;
    rSum += data[offset];
    gSum += data[offset + 1];
    bSum += data[offset + 2];
    count++;
  }
  if (count === 0) return { r: 128, g: 128, b: 128 };
  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  };
}

interface Region { left: number; top: number; width: number; height: number }

function getRegions(w: number, h: number): Record<string, Region> {
  const tw = Math.floor(w / 3);
  const th = Math.floor(h / 3);
  return {
    top:    { left: tw, top: 0, width: tw, height: th },
    center: { left: tw, top: th, width: tw, height: th },
    bottom: { left: tw, top: th * 2, width: tw, height: th },
    left:   { left: 0, top: th, width: tw, height: th },
    right:  { left: tw * 2, top: th, width: tw, height: th },
  };
}

/**
 * Extract color palette from an image stored in the images table.
 */
export async function extractColorsFromImage(imageId: string): Promise<ColorExtractionResult> {
  // Look up image file path
  const row = getDb().query("SELECT filename FROM images WHERE id = ?").get(imageId) as { filename: string } | null;
  if (!row) throw new Error(`Image not found: ${imageId}`);

  const imagesDir = join(env.dataDir, "images");
  const filePath = join(imagesDir, row.filename);

  // Resize to sample size and extract raw pixel data
  const resized = sharp(filePath).resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "cover" });
  const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels; // 4 (RGBA after ensureAlpha)
  const w = info.width;
  const h = info.height;

  // Full-image analysis
  const pixelCount = w * h;
  const fullResult = dominantFromPixels(data, channels, pixelCount);
  const average = averageFromPixels(data, channels, pixelCount);

  // Per-region analysis
  const regionDefs = getRegions(w, h);
  const regions = {} as ColorExtractionResult["regions"];
  const flatness = { full: fullResult.flatness } as ColorExtractionResult["flatness"];

  for (const [name, rect] of Object.entries(regionDefs)) {
    // Extract region pixels from the raw buffer
    const regionPixels: number[] = [];
    for (let y = rect.top; y < rect.top + rect.height && y < h; y++) {
      for (let x = rect.left; x < rect.left + rect.width && x < w; x++) {
        const offset = (y * w + x) * channels;
        regionPixels.push(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
      }
    }
    const regionBuf = Buffer.from(regionPixels);
    const regionPixelCount = regionPixels.length / channels;
    const result = dominantFromPixels(regionBuf, channels, regionPixelCount);
    (regions as any)[name] = result.color;
    (flatness as any)[name] = result.flatness;
  }

  const isLight = luminance(fullResult.color.r, fullResult.color.g, fullResult.color.b) > 152;
  const dominantHsl = rgbToHsl(fullResult.color.r, fullResult.color.g, fullResult.color.b);

  return { dominant: fullResult.color, regions, flatness, average, isLight, dominantHsl };
}
