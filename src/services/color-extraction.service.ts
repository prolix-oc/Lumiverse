/**
 * Server-side color extraction from images using sharp.
 * Mirrors the frontend colorExtraction.ts algorithm but uses
 * sharp's raw pixel data instead of Canvas.
 */

import sharp from "../utils/sharp-config";
import { join } from "path";
import { env } from "../env";
import { getDb } from "../db/connection";

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

export interface ReadableColorScheme {
  surface: RGB;
  text: RGB;
  mutedText: RGB;
  accent: RGB;
  accentText: RGB;
}

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
  palette: RGB[];
  diversity: {
    score: number;
    isUniform: boolean;
    usedFallback: boolean;
  };
  ui: {
    dark: ReadableColorScheme;
    light: ReadableColorScheme;
  };
}

const SAMPLE_SIZE = 48;
const DEFAULT_FALLBACK_HUE = 263;
const MIN_UI_CONTRAST = 3;
const MIN_TEXT_CONTRAST = 4.5;
const DARK_SURFACE_MIN_LUM = 24;
const DARK_SURFACE_MAX_LUM = 68;
const LIGHT_SURFACE_MIN_LUM = 218;
const LIGHT_SURFACE_MAX_LUM = 246;
const DARK_ACCENT_MIN_LUM = 118;
const DARK_ACCENT_MAX_LUM = 210;
const LIGHT_ACCENT_MIN_LUM = 54;
const LIGHT_ACCENT_MAX_LUM = 154;
const LUMINANCE_SKEW_RATIO = 0.64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mixColors(color: RGB, target: RGB, weight: number): RGB {
  const w = clamp(weight, 0, 1);
  return {
    r: Math.round(color.r + (target.r - color.r) * w),
    g: Math.round(color.g + (target.g - color.g) * w),
    b: Math.round(color.b + (target.b - color.b) * w),
  };
}

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

export function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

/** WCAG 2.1 relative luminance (gamma-corrected). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG 2.1 contrast ratio between two RGB colors. */
export function contrastRatio(rgb1: RGB, rgb2: RGB): number {
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Adjust a foreground color until it meets a minimum contrast ratio against
 * the given background. Modifies lightness in HSL space while preserving hue
 * and saturation.
 */
export function ensureContrast(
  foreground: RGB,
  background: RGB,
  minRatio: number
): RGB {
  const current = contrastRatio(foreground, background);
  if (current >= minRatio) return foreground;

  const bgHsl = rgbToHsl(background.r, background.g, background.b);
  const fgHsl = rgbToHsl(foreground.r, foreground.g, foreground.b);

  const step = bgHsl.l < 50 ? 1 : -1;
  let bestCandidate = foreground;
  let bestRatio = current;

  for (let l = fgHsl.l; l >= 0 && l <= 100; l += step) {
    const candidate = hslToRgb(fgHsl.h, fgHsl.s, l);
    const ratio = contrastRatio(candidate, background);
    if (ratio >= minRatio) return candidate;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

/**
 * Adjust a color until its perceptual luminance stays within the requested
 * [minLum, maxLum] bounds (0–255 scale).  This is useful for eye-comfort
 * clamping: dark-mode colors can be capped so they are never blinding, and
 * light-mode colors can be floored so they are never too harsh.
 */
export function constrainLuminance(
  color: RGB,
  minLum?: number,
  maxLum?: number
): RGB {
  const lum = luminance(color.r, color.g, color.b);

  if (
    (minLum === undefined || lum >= minLum) &&
    (maxLum === undefined || lum <= maxLum)
  ) {
    return color;
  }

  const hsl = rgbToHsl(color.r, color.g, color.b);

  if (minLum !== undefined && lum < minLum) {
    for (let l = hsl.l + 1; l <= 100; l++) {
      const candidate = hslToRgb(hsl.h, hsl.s, l);
      if (luminance(candidate.r, candidate.g, candidate.b) >= minLum) {
        return candidate;
      }
    }
    return { r: 255, g: 255, b: 255 };
  }

  if (maxLum !== undefined && lum > maxLum) {
    for (let l = hsl.l - 1; l >= 0; l--) {
      const candidate = hslToRgb(hsl.h, hsl.s, l);
      if (luminance(candidate.r, candidate.g, candidate.b) <= maxLum) {
        return candidate;
      }
    }
    return { r: 0, g: 0, b: 0 };
  }

  return color;
}

function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

interface DominantResult { color: RGB; flatness: number }

interface BucketStats { count: number; r: number; g: number; b: number }

interface CandidateColor {
  color: RGB;
  score: number;
}

interface PixelAnalysis {
  dominant: DominantResult;
  average: RGB;
  diversityScore: number;
  candidates: CandidateColor[];
  luminanceProfile: LuminanceProfile;
}

interface LuminanceProfile {
  mostlyTooDark: boolean;
  mostlyTooLight: boolean;
}

function chooseQuantizationStep(avgDeviation: number): number {
  if (avgDeviation < 12) return 36;
  if (avgDeviation < 22) return 28;
  if (avgDeviation < 36) return 22;
  return 16;
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const dl = luminance(a.r, a.g, a.b) - luminance(b.r, b.g, b.b);
  return Math.sqrt((dr * dr * 0.35) + (dg * dg * 0.45) + (db * db * 0.2) + (dl * dl * 0.6));
}

function scoreCandidate(color: RGB, weight: number): number {
  const hsl = rgbToHsl(color.r, color.g, color.b);
  const satWeight = 0.45 + (hsl.s / 100) * 0.95;
  const lightPenalty = hsl.l < 12 || hsl.l > 92 ? 0.45 : hsl.l < 20 || hsl.l > 84 ? 0.72 : 1;
  return Math.sqrt(Math.max(1, weight)) * satWeight * lightPenalty;
}

function analyzePixels(data: ArrayLike<number>, channels: number, pixelCount: number): PixelAnalysis {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let opaqueCount = 0;
  let tooDarkCount = 0;
  let tooLightCount = 0;

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    if (channels === 4 && data[offset + 3] < 48) continue;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const lum = luminance(r, g, b);
    if (lum < DARK_SURFACE_MIN_LUM) tooDarkCount++;
    if (lum > LIGHT_SURFACE_MAX_LUM) tooLightCount++;
    rSum += r;
    gSum += g;
    bSum += b;
    opaqueCount++;
  }

  if (opaqueCount === 0) {
    const grey = { r: 128, g: 128, b: 128 };
    return {
      dominant: { color: grey, flatness: 1 },
      average: grey,
      diversityScore: 0,
      candidates: [{ color: grey, score: 1 }],
      luminanceProfile: { mostlyTooDark: false, mostlyTooLight: false },
    };
  }

  const luminanceProfile = {
    mostlyTooDark: tooDarkCount / opaqueCount >= LUMINANCE_SKEW_RATIO,
    mostlyTooLight: tooLightCount / opaqueCount >= LUMINANCE_SKEW_RATIO,
  };

  const average = {
    r: Math.round(rSum / opaqueCount),
    g: Math.round(gSum / opaqueCount),
    b: Math.round(bSum / opaqueCount),
  };

  let deviationSum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    if (channels === 4 && data[offset + 3] < 48) continue;
    deviationSum += Math.abs(data[offset] - average.r);
    deviationSum += Math.abs(data[offset + 1] - average.g);
    deviationSum += Math.abs(data[offset + 2] - average.b);
  }

  const avgDeviation = deviationSum / (opaqueCount * 3);
  const quantStep = chooseQuantizationStep(avgDeviation);
  const buckets = new Map<string, BucketStats>();

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    if (channels === 4 && data[offset + 3] < 48) continue;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const qr = Math.round(r / quantStep) * quantStep;
    const qg = Math.round(g / quantStep) * quantStep;
    const qb = Math.round(b / quantStep) * quantStep;
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

  let best: BucketStats | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }

  if (!best || best.count === 0) {
    const grey = { r: 128, g: 128, b: 128 };
    return {
      dominant: { color: grey, flatness: 1 },
      average,
      diversityScore: 0,
      candidates: [{ color: grey, score: 1 }],
      luminanceProfile,
    };
  }

  const dominant = {
    color: {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
    },
    flatness: best.count / opaqueCount,
  };

  const candidates = Array.from(buckets.values())
    .map((bucket) => {
      const color = {
        r: Math.round(bucket.r / bucket.count),
        g: Math.round(bucket.g / bucket.count),
        b: Math.round(bucket.b / bucket.count),
      };
      return {
        color,
        score: scoreCandidate(color, bucket.count),
      };
    })
    .sort((a, b) => b.score - a.score);

  const bucketSpread = clamp(buckets.size / 24, 0, 1);
  const diversityScore = clamp((avgDeviation / 52) * 0.72 + bucketSpread * 0.28, 0, 1);

  return { dominant, average, diversityScore, candidates, luminanceProfile };
}

function dominantFromPixels(data: ArrayLike<number>, channels: number, pixelCount: number): DominantResult {
  return analyzePixels(data, channels, pixelCount).dominant;
}

function selectDistinctColors(candidates: CandidateColor[], desiredCount: number, diversityScore: number): RGB[] {
  const chosen: RGB[] = [];
  const thresholds = [
    diversityScore > 0.28 ? 68 : diversityScore > 0.16 ? 54 : diversityScore > 0.08 ? 40 : 28,
    diversityScore > 0.28 ? 54 : diversityScore > 0.16 ? 42 : diversityScore > 0.08 ? 30 : 22,
    14,
  ];

  for (const threshold of thresholds) {
    for (const candidate of candidates) {
      if (chosen.length >= desiredCount) return chosen;
      if (chosen.some((selected) => colorDistance(selected, candidate.color) < 8)) continue;
      if (chosen.length === 0 || chosen.every((selected) => colorDistance(selected, candidate.color) >= threshold)) {
        chosen.push(candidate.color);
      }
    }
  }

  return chosen;
}

function pickFallbackHue(dominant: RGB, average: RGB): number {
  const dominantHsl = rgbToHsl(dominant.r, dominant.g, dominant.b);
  if (dominantHsl.s >= 16) return dominantHsl.h;
  const averageHsl = rgbToHsl(average.r, average.g, average.b);
  if (averageHsl.s >= 12) return averageHsl.h;
  return DEFAULT_FALLBACK_HUE;
}

function buildFallbackPalette(dominant: RGB, average: RGB): RGB[] {
  const hue = pickFallbackHue(dominant, average);
  return [
    hslToRgb(hue, 68, 58),
    hslToRgb((hue + 18) % 360, 46, 42),
    hslToRgb((hue + 340) % 360, 34, 72),
    hslToRgb((hue + 160) % 360, 28, 38),
    hslToRgb((hue + 205) % 360, 16, 84),
  ];
}

function pickReadableTextColor(surface: RGB, tint: RGB, minRatio: number): RGB {
  const lightTarget = { r: 247, g: 249, b: 252 };
  const darkTarget = { r: 17, g: 22, b: 28 };
  const candidates = [
    ensureContrast(mixColors(tint, lightTarget, 0.88), surface, minRatio),
    ensureContrast(mixColors(tint, darkTarget, 0.88), surface, minRatio),
    ensureContrast(lightTarget, surface, minRatio),
    ensureContrast(darkTarget, surface, minRatio),
  ];
  const ranked = candidates
    .map((color) => ({ color, ratio: contrastRatio(color, surface) }))
    .sort((a, b) => b.ratio - a.ratio);
  const prefersLightText = relativeLuminance(surface.r, surface.g, surface.b) < 0.36;
  const preferred = ranked.find(({ color, ratio }) => {
    if (ratio < minRatio) return false;
    return prefersLightText ? relativeLuminance(color.r, color.g, color.b) > 0.5 : relativeLuminance(color.r, color.g, color.b) < 0.2;
  });

  if (preferred) return preferred.color;
  return ranked[0].color;
}

function tuneAccentForSurface(accentBase: RGB, surface: RGB, mode: "dark" | "light"): RGB {
  const accentHsl = rgbToHsl(accentBase.r, accentBase.g, accentBase.b);
  let tuned = hslToRgb(
    accentHsl.h,
    clamp(accentHsl.s, 44, 80),
    mode === "dark" ? clamp(accentHsl.l, 56, 70) : clamp(accentHsl.l, 34, 48),
  );

  tuned = mode === "dark"
    ? constrainLuminance(tuned, DARK_ACCENT_MIN_LUM, DARK_ACCENT_MAX_LUM)
    : constrainLuminance(tuned, LIGHT_ACCENT_MIN_LUM, LIGHT_ACCENT_MAX_LUM);

  const contrasted = ensureContrast(tuned, surface, MIN_UI_CONTRAST);
  return mode === "dark"
    ? constrainLuminance(contrasted, DARK_ACCENT_MIN_LUM, DARK_ACCENT_MAX_LUM)
    : constrainLuminance(contrasted, LIGHT_ACCENT_MIN_LUM, LIGHT_ACCENT_MAX_LUM);
}

function dedupeColors(colors: RGB[]): RGB[] {
  const unique: RGB[] = [];
  for (const color of colors) {
    if (unique.some((existing) => colorDistance(existing, color) < 12)) continue;
    unique.push(color);
  }
  return unique;
}

function scoreSurfaceColor(color: RGB, mode: "dark" | "light"): number {
  const lum = luminance(color.r, color.g, color.b);
  const hsl = rgbToHsl(color.r, color.g, color.b);
  const targetLum = mode === "dark" ? 34 : 228;
  const lumRange = mode === "dark" ? 138 : 108;
  const lumScore = 1 - clamp(Math.abs(lum - targetLum) / lumRange, 0, 1);
  const satPenalty = mode === "dark"
    ? clamp(1 - Math.max(0, hsl.s - 34) / 92, 0.48, 1)
    : clamp(1 - Math.max(0, hsl.s - 28) / 96, 0.54, 1);
  const extremePenalty = mode === "dark"
    ? lum > 132 ? 0.08 : lum > 96 ? 0.34 : lum < 8 ? 0.82 : 1
    : lum < 92 ? 0.08 : lum < 136 ? 0.36 : lum > 248 ? 0.88 : 1;
  return lumScore * satPenalty * extremePenalty;
}

function pickSurfaceBase(colors: RGB[], average: RGB, mode: "dark" | "light"): RGB {
  const candidates = dedupeColors([average, ...colors]);
  let best = candidates[0] ?? average;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreSurfaceColor(candidate, mode);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return mixColors(best, average, mode === "dark" ? 0.14 : 0.18);
}

function pickAccentBase(colors: RGB[], surface: RGB): RGB {
  const candidates = dedupeColors(colors);
  let best = candidates[0] ?? surface;
  let bestScore = -1;

  for (const candidate of candidates) {
    const hsl = rgbToHsl(candidate.r, candidate.g, candidate.b);
    const vibrancy = 0.4 + (hsl.s / 100) * 0.95;
    const separation = clamp(colorDistance(candidate, surface) / 120, 0, 1);
    const lightPenalty = hsl.l < 10 || hsl.l > 92 ? 0.35 : hsl.l < 18 || hsl.l > 84 ? 0.68 : 1;
    const score = vibrancy * (0.42 + separation * 0.9) * lightPenalty;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function deriveReadableScheme(
  surfaceBase: RGB,
  accentBase: RGB,
  mode: "dark" | "light",
  luminanceProfile: LuminanceProfile,
): ReadableColorScheme {
  const darkMixWeight = luminanceProfile.mostlyTooDark ? 0.9 : 0.84;
  const lightMixWeight = luminanceProfile.mostlyTooLight ? 0.94 : 0.9;
  let surface = mode === "dark"
    ? mixColors(surfaceBase, { r: 18, g: 22, b: 30 }, darkMixWeight)
    : mixColors(surfaceBase, { r: 248, g: 250, b: 252 }, lightMixWeight);

  surface = mode === "dark"
    ? constrainLuminance(surface, DARK_SURFACE_MIN_LUM, DARK_SURFACE_MAX_LUM)
    : constrainLuminance(surface, LIGHT_SURFACE_MIN_LUM, LIGHT_SURFACE_MAX_LUM);

  const accent = tuneAccentForSurface(accentBase, surface, mode);
  const accentText = pickReadableTextColor(accent, surface, MIN_TEXT_CONTRAST);
  const text = pickReadableTextColor(surface, accentBase, MIN_TEXT_CONTRAST);
  const mutedSeed = mixColors(text, surface, 0.28);
  const mutedText = ensureContrast(mutedSeed, surface, 3.6);

  return { surface, text, mutedText, accent, accentText };
}

function deriveUiSchemes(
  palette: RGB[],
  dominant: RGB,
  average: RGB,
  luminanceProfile: LuminanceProfile = { mostlyTooDark: false, mostlyTooLight: false },
): { dark: ReadableColorScheme; light: ReadableColorScheme } {
  const colors = dedupeColors([dominant, average, ...palette]);
  const darkSurfaceBase = pickSurfaceBase(colors, average, "dark");
  const lightSurfaceBase = pickSurfaceBase(colors, average, "light");
  const darkAccentBase = pickAccentBase(colors, darkSurfaceBase);
  const lightAccentBase = pickAccentBase(colors, lightSurfaceBase);
  return {
    dark: deriveReadableScheme(darkSurfaceBase, darkAccentBase, "dark", luminanceProfile),
    light: deriveReadableScheme(lightSurfaceBase, lightAccentBase, "light", luminanceProfile),
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
export function extractColorsFromRawPixels(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
): ColorExtractionResult {
  const pixelCount = width * height;
  const fullAnalysis = analyzePixels(data, channels, pixelCount);
  const regionDefs = getRegions(width, height);
  const regions = {} as ColorExtractionResult["regions"];
  const flatness = { full: fullAnalysis.dominant.flatness } as ColorExtractionResult["flatness"];
  const regionCandidates: CandidateColor[] = [];

  for (const [name, rect] of Object.entries(regionDefs)) {
    const regionPixels: number[] = [];
    for (let y = rect.top; y < rect.top + rect.height && y < height; y++) {
      for (let x = rect.left; x < rect.left + rect.width && x < width; x++) {
        const offset = (y * width + x) * channels;
        for (let channel = 0; channel < channels; channel++) {
          regionPixels.push(data[offset + channel]);
        }
      }
    }

    const regionPixelCount = regionPixels.length / channels;
    const result = dominantFromPixels(regionPixels, channels, regionPixelCount);
    (regions as any)[name] = result.color;
    (flatness as any)[name] = result.flatness;

    regionCandidates.push({
      color: result.color,
      score: scoreCandidate(result.color, Math.max(1, regionPixelCount * Math.max(0.35, 1 - result.flatness))),
    });
  }

  const diversePalette = selectDistinctColors(
    [
      ...fullAnalysis.candidates,
      ...regionCandidates,
      { color: fullAnalysis.average, score: scoreCandidate(fullAnalysis.average, pixelCount * 0.18) },
    ],
    5,
    fullAnalysis.diversityScore,
  );

  const isUniform = fullAnalysis.diversityScore < 0.16 || flatness.full > 0.56 || diversePalette.length < 3;
  const usedFallback = isUniform;
  const palette = usedFallback
    ? buildFallbackPalette(fullAnalysis.dominant.color, fullAnalysis.average)
    : diversePalette;
  const ui = deriveUiSchemes(palette, fullAnalysis.dominant.color, fullAnalysis.average, fullAnalysis.luminanceProfile);
  const dominantHsl = rgbToHsl(fullAnalysis.dominant.color.r, fullAnalysis.dominant.color.g, fullAnalysis.dominant.color.b);
  const isLight = luminance(fullAnalysis.dominant.color.r, fullAnalysis.dominant.color.g, fullAnalysis.dominant.color.b) > 152;

  return {
    dominant: fullAnalysis.dominant.color,
    regions,
    flatness,
    average: fullAnalysis.average,
    isLight,
    dominantHsl,
    palette,
    diversity: {
      score: Number(fullAnalysis.diversityScore.toFixed(3)),
      isUniform,
      usedFallback,
    },
    ui,
  };
}

export async function extractColorsFromImage(imageId: string): Promise<ColorExtractionResult> {
  const row = getDb().query("SELECT filename FROM images WHERE id = ?").get(imageId) as { filename: string } | null;
  if (!row) throw new Error(`Image not found: ${imageId}`);

  const imagesDir = join(env.dataDir, "images");
  const filePath = join(imagesDir, row.filename);
  const resized = sharp(filePath).resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "cover" });
  const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  return extractColorsFromRawPixels(data, info.width, info.height, info.channels);
}
