#!/usr/bin/env bun
/**
 * Sampler harness: runs the real extractPalette pipeline against local PNGs
 * using sharp instead of a browser canvas. Reports the derived palette, UI
 * schemes, and the character-aware overlay so we can see exactly what each
 * card would produce in the app.
 *
 * Usage:
 *   bun scripts/dev/sample-card.ts ~/Downloads/test-1.png [more...]
 */

import sharp from 'sharp'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

// ── Verbatim port of frontend/src/lib/colorExtraction.ts (browser-free) ──

type RGB = { r: number; g: number; b: number }

interface ReadableColorScheme {
  surface: RGB
  text: RGB
  mutedText: RGB
  accent: RGB
  accentText: RGB
}

interface ImagePalette {
  dominant: RGB
  regions: { top: RGB; center: RGB; bottom: RGB; left: RGB; right: RGB }
  flatness: { top: number; center: number; bottom: number; left: number; right: number; full: number }
  average: RGB
  isLight: boolean
  palette: RGB[]
  diversity: { score: number; isUniform: boolean; usedFallback: boolean }
  ui: { dark: ReadableColorScheme; light: ReadableColorScheme }
}

const DEFAULT_FALLBACK_HUE = 263
const MIN_UI_CONTRAST = 3
const MIN_TEXT_CONTRAST = 4.5
const DARK_SURFACE_MIN_LUM = 24
const DARK_SURFACE_MAX_LUM = 68
const LIGHT_SURFACE_MIN_LUM = 218
const LIGHT_SURFACE_MAX_LUM = 246
const DARK_ACCENT_MIN_LUM = 118
const DARK_ACCENT_MAX_LUM = 210
const LIGHT_ACCENT_MIN_LUM = 54
const LIGHT_ACCENT_MAX_LUM = 154
const LUMINANCE_SKEW_RATIO = 0.64
const SAMPLE_SIZE = 48

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }
function mixColors(c: RGB, t: RGB, w: number): RGB {
  const k = clamp(w, 0, 1)
  return { r: Math.round(c.r + (t.r - c.r) * k), g: Math.round(c.g + (t.g - c.g) * k), b: Math.round(c.b + (t.b - c.b) * k) }
}
function luminance(r: number, g: number, b: number) { return r * 0.2126 + g * 0.7152 + b * 0.0722 }
function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}
function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) }
}
function relativeLuminance(r: number, g: number, b: number) {
  const [rs, gs, bs] = [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}
function contrastRatio(a: RGB, b: RGB) {
  const l1 = relativeLuminance(a.r, a.g, a.b), l2 = relativeLuminance(b.r, b.g, b.b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
function ensureContrast(fg: RGB, bg: RGB, min: number): RGB {
  const cur = contrastRatio(fg, bg); if (cur >= min) return fg
  const bgHsl = rgbToHsl(bg.r, bg.g, bg.b), fgHsl = rgbToHsl(fg.r, fg.g, fg.b)
  const step = bgHsl.l < 50 ? 1 : -1
  let best = fg, bestRatio = cur
  for (let l = fgHsl.l; l >= 0 && l <= 100; l += step) {
    const cand = hslToRgb(fgHsl.h, fgHsl.s, l)
    const ratio = contrastRatio(cand, bg)
    if (ratio >= min) return cand
    if (ratio > bestRatio) { bestRatio = ratio; best = cand }
  }
  return best
}
function constrainLuminance(c: RGB, minLum?: number, maxLum?: number): RGB {
  const lum = luminance(c.r, c.g, c.b)
  if ((minLum === undefined || lum >= minLum) && (maxLum === undefined || lum <= maxLum)) return c
  const hsl = rgbToHsl(c.r, c.g, c.b)
  if (minLum !== undefined && lum < minLum) {
    for (let l = hsl.l + 1; l <= 100; l++) {
      const cand = hslToRgb(hsl.h, hsl.s, l)
      if (luminance(cand.r, cand.g, cand.b) >= minLum) return cand
    }
    return { r: 255, g: 255, b: 255 }
  }
  if (maxLum !== undefined && lum > maxLum) {
    for (let l = hsl.l - 1; l >= 0; l--) {
      const cand = hslToRgb(hsl.h, hsl.s, l)
      if (luminance(cand.r, cand.g, cand.b) <= maxLum) return cand
    }
    return { r: 0, g: 0, b: 0 }
  }
  return c
}

interface DominantResult { color: RGB; flatness: number }
interface BucketStats { count: number; r: number; g: number; b: number }
interface CandidateColor { color: RGB; score: number }
interface LuminanceProfile { mostlyTooDark: boolean; mostlyTooLight: boolean }
interface PixelAnalysis { dominant: DominantResult; average: RGB; diversityScore: number; candidates: CandidateColor[]; luminanceProfile: LuminanceProfile }

function chooseQuantizationStep(d: number) { return d < 12 ? 36 : d < 22 ? 28 : d < 36 ? 22 : 16 }
function colorDistance(a: RGB, b: RGB) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
  const dl = luminance(a.r, a.g, a.b) - luminance(b.r, b.g, b.b)
  return Math.sqrt(dr * dr * 0.35 + dg * dg * 0.45 + db * db * 0.2 + dl * dl * 0.6)
}
function scoreCandidate(c: RGB, w: number) {
  const hsl = rgbToHsl(c.r, c.g, c.b)
  const satW = 0.45 + (hsl.s / 100) * 0.95
  const lP = hsl.l < 12 || hsl.l > 92 ? 0.45 : hsl.l < 20 || hsl.l > 84 ? 0.72 : 1
  return Math.sqrt(Math.max(1, w)) * satW * lP
}

function analyzePixels(data: Uint8ClampedArray): PixelAnalysis {
  let rS = 0, gS = 0, bS = 0, opaque = 0, tooDark = 0, tooLight = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const lum = luminance(r, g, b)
    if (lum < DARK_SURFACE_MIN_LUM) tooDark++
    if (lum > LIGHT_SURFACE_MAX_LUM) tooLight++
    rS += r; gS += g; bS += b; opaque++
  }
  if (opaque === 0) {
    const grey = { r: 128, g: 128, b: 128 }
    return { dominant: { color: grey, flatness: 1 }, average: grey, diversityScore: 0, candidates: [{ color: grey, score: 1 }], luminanceProfile: { mostlyTooDark: false, mostlyTooLight: false } }
  }
  const lumProfile = { mostlyTooDark: tooDark / opaque >= LUMINANCE_SKEW_RATIO, mostlyTooLight: tooLight / opaque >= LUMINANCE_SKEW_RATIO }
  const average = { r: Math.round(rS / opaque), g: Math.round(gS / opaque), b: Math.round(bS / opaque) }
  let devSum = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    devSum += Math.abs(data[i] - average.r) + Math.abs(data[i + 1] - average.g) + Math.abs(data[i + 2] - average.b)
  }
  const avgDev = devSum / (opaque * 3)
  const qStep = chooseQuantizationStep(avgDev)
  const buckets = new Map<string, BucketStats>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const qr = Math.round(r / qStep) * qStep, qg = Math.round(g / qStep) * qStep, qb = Math.round(b / qStep) * qStep
    const k = `${qr}-${qg}-${qb}`, hit = buckets.get(k)
    if (hit) { hit.count++; hit.r += r; hit.g += g; hit.b += b }
    else buckets.set(k, { count: 1, r, g, b })
  }
  let best: BucketStats | null = null
  buckets.forEach((b) => { if (!best || b.count > best.count) best = b })
  if (!best || best.count === 0) {
    const grey = { r: 128, g: 128, b: 128 }
    return { dominant: { color: grey, flatness: 1 }, average, diversityScore: 0, candidates: [{ color: grey, score: 1 }], luminanceProfile: lumProfile }
  }
  const dominant = { color: { r: Math.round(best.r / best.count), g: Math.round(best.g / best.count), b: Math.round(best.b / best.count) }, flatness: best.count / opaque }
  const candidates = Array.from(buckets.values()).map((b) => {
    const color = { r: Math.round(b.r / b.count), g: Math.round(b.g / b.count), b: Math.round(b.b / b.count) }
    return { color, score: scoreCandidate(color, b.count) }
  }).sort((a, b) => b.score - a.score)
  const bucketSpread = clamp(buckets.size / 24, 0, 1)
  const diversityScore = clamp((avgDev / 52) * 0.72 + bucketSpread * 0.28, 0, 1)
  return { dominant, average, diversityScore, candidates, luminanceProfile: lumProfile }
}
function dominantFromData(data: Uint8ClampedArray): DominantResult { return analyzePixels(data).dominant }

function selectDistinctColors(cands: CandidateColor[], desired: number, diversity: number): RGB[] {
  const chosen: RGB[] = []
  const thresholds = [
    diversity > 0.28 ? 68 : diversity > 0.16 ? 54 : diversity > 0.08 ? 40 : 28,
    diversity > 0.28 ? 54 : diversity > 0.16 ? 42 : diversity > 0.08 ? 30 : 22,
    14,
  ]
  for (const t of thresholds) {
    for (const c of cands) {
      if (chosen.length >= desired) return chosen
      if (chosen.some((s) => colorDistance(s, c.color) < 8)) continue
      if (chosen.length === 0 || chosen.every((s) => colorDistance(s, c.color) >= t)) chosen.push(c.color)
    }
  }
  return chosen
}
function pickFallbackHue(d: RGB, a: RGB) {
  const dh = rgbToHsl(d.r, d.g, d.b); if (dh.s >= 16) return dh.h
  const ah = rgbToHsl(a.r, a.g, a.b); if (ah.s >= 12) return ah.h
  return DEFAULT_FALLBACK_HUE
}
function buildFallbackPalette(d: RGB, a: RGB): RGB[] {
  const hue = pickFallbackHue(d, a)
  return [
    hslToRgb(hue, 68, 58),
    hslToRgb((hue + 18) % 360, 46, 42),
    hslToRgb((hue + 340) % 360, 34, 72),
    hslToRgb((hue + 160) % 360, 28, 38),
    hslToRgb((hue + 205) % 360, 16, 84),
  ]
}
function pickReadableTextColor(surface: RGB, tint: RGB, min: number): RGB {
  const lightT = { r: 247, g: 249, b: 252 }, darkT = { r: 17, g: 22, b: 28 }
  const cands = [
    ensureContrast(mixColors(tint, lightT, 0.88), surface, min),
    ensureContrast(mixColors(tint, darkT, 0.88), surface, min),
    ensureContrast(lightT, surface, min),
    ensureContrast(darkT, surface, min),
  ]
  const ranked = cands.map((color) => ({ color, ratio: contrastRatio(color, surface) })).sort((a, b) => b.ratio - a.ratio)
  const prefersLight = relativeLuminance(surface.r, surface.g, surface.b) < 0.36
  const pref = ranked.find(({ color, ratio }) => {
    if (ratio < min) return false
    return prefersLight ? relativeLuminance(color.r, color.g, color.b) > 0.5 : relativeLuminance(color.r, color.g, color.b) < 0.2
  })
  return pref ? pref.color : ranked[0].color
}
function tuneAccentForSurface(accentBase: RGB, surface: RGB, mode: 'dark' | 'light'): RGB {
  const hsl = rgbToHsl(accentBase.r, accentBase.g, accentBase.b)
  let tuned = hslToRgb(hsl.h, clamp(hsl.s, 44, 80), mode === 'dark' ? clamp(hsl.l, 56, 70) : clamp(hsl.l, 34, 48))
  tuned = mode === 'dark' ? constrainLuminance(tuned, DARK_ACCENT_MIN_LUM, DARK_ACCENT_MAX_LUM) : constrainLuminance(tuned, LIGHT_ACCENT_MIN_LUM, LIGHT_ACCENT_MAX_LUM)
  const cont = ensureContrast(tuned, surface, MIN_UI_CONTRAST)
  return mode === 'dark' ? constrainLuminance(cont, DARK_ACCENT_MIN_LUM, DARK_ACCENT_MAX_LUM) : constrainLuminance(cont, LIGHT_ACCENT_MIN_LUM, LIGHT_ACCENT_MAX_LUM)
}
function dedupeColors(colors: RGB[]): RGB[] {
  const out: RGB[] = []
  for (const c of colors) { if (out.some((e) => colorDistance(e, c) < 12)) continue; out.push(c) }
  return out
}
function scoreSurfaceColor(color: RGB, mode: 'dark' | 'light') {
  const lum = luminance(color.r, color.g, color.b), hsl = rgbToHsl(color.r, color.g, color.b)
  const target = mode === 'dark' ? 34 : 228, range = mode === 'dark' ? 138 : 108
  const lumScore = 1 - clamp(Math.abs(lum - target) / range, 0, 1)
  const satPen = mode === 'dark' ? clamp(1 - Math.max(0, hsl.s - 34) / 92, 0.48, 1) : clamp(1 - Math.max(0, hsl.s - 28) / 96, 0.54, 1)
  const extreme = mode === 'dark' ? (lum > 132 ? 0.08 : lum > 96 ? 0.34 : lum < 8 ? 0.82 : 1) : (lum < 92 ? 0.08 : lum < 136 ? 0.36 : lum > 248 ? 0.88 : 1)
  return lumScore * satPen * extreme
}
function pickSurfaceBase(colors: RGB[], average: RGB, mode: 'dark' | 'light'): RGB {
  const cands = dedupeColors([average, ...colors])
  let best = cands[0] ?? average, bestScore = -1
  for (const c of cands) { const s = scoreSurfaceColor(c, mode); if (s > bestScore) { best = c; bestScore = s } }
  return mixColors(best, average, mode === 'dark' ? 0.14 : 0.18)
}
function pickAccentBase(colors: RGB[], surface: RGB): RGB {
  const cands = dedupeColors(colors)
  let best = cands[0] ?? surface, bestScore = -1
  for (const c of cands) {
    const hsl = rgbToHsl(c.r, c.g, c.b)
    const vib = 0.4 + (hsl.s / 100) * 0.95
    const sep = clamp(colorDistance(c, surface) / 120, 0, 1)
    const lP = hsl.l < 10 || hsl.l > 92 ? 0.35 : hsl.l < 18 || hsl.l > 84 ? 0.68 : 1
    const score = vib * (0.42 + sep * 0.9) * lP
    if (score > bestScore) { best = c; bestScore = score }
  }
  return best
}
function deriveReadableScheme(surfaceBase: RGB, accentBase: RGB, mode: 'dark' | 'light', lp: LuminanceProfile): ReadableColorScheme {
  const darkMix = lp.mostlyTooDark ? 0.9 : 0.84
  const lightMix = lp.mostlyTooLight ? 0.94 : 0.9
  let surface = mode === 'dark' ? mixColors(surfaceBase, { r: 18, g: 22, b: 30 }, darkMix) : mixColors(surfaceBase, { r: 248, g: 250, b: 252 }, lightMix)
  surface = mode === 'dark' ? constrainLuminance(surface, DARK_SURFACE_MIN_LUM, DARK_SURFACE_MAX_LUM) : constrainLuminance(surface, LIGHT_SURFACE_MIN_LUM, LIGHT_SURFACE_MAX_LUM)
  const accent = tuneAccentForSurface(accentBase, surface, mode)
  const accentText = pickReadableTextColor(accent, surface, MIN_TEXT_CONTRAST)
  const text = pickReadableTextColor(surface, accentBase, MIN_TEXT_CONTRAST)
  const mutedSeed = mixColors(text, surface, 0.28)
  const mutedText = ensureContrast(mutedSeed, surface, 3.6)
  return { surface, text, mutedText, accent, accentText }
}
function deriveUiSchemes(palette: RGB[], dominant: RGB, average: RGB, lp: LuminanceProfile) {
  const colors = dedupeColors([dominant, average, ...palette])
  const dSurf = pickSurfaceBase(colors, average, 'dark')
  const lSurf = pickSurfaceBase(colors, average, 'light')
  const dAcc = pickAccentBase(colors, dSurf)
  const lAcc = pickAccentBase(colors, lSurf)
  return { dark: deriveReadableScheme(dSurf, dAcc, 'dark', lp), light: deriveReadableScheme(lSurf, lAcc, 'light', lp) }
}

interface Region { x: number; y: number; w: number; h: number }
function getRegions(w: number, h: number): Record<string, Region> {
  const tw = Math.floor(w / 3), th = Math.floor(h / 3)
  return {
    top: { x: tw, y: 0, w: tw, h: th },
    center: { x: tw, y: th, w: tw, h: th },
    bottom: { x: tw, y: th * 2, w: tw, h: th },
    left: { x: 0, y: th, w: tw, h: th },
    right: { x: tw * 2, y: th, w: tw, h: th },
  }
}

function sliceRegion(full: Uint8ClampedArray, w: number, rect: Region): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4)
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * w + rect.x) * 4
    out.set(full.subarray(src, src + rect.w * 4), y * rect.w * 4)
  }
  return out
}

async function extractPalette(src: string): Promise<ImagePalette> {
  const raw = await sharp(src).resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' }).ensureAlpha().raw().toBuffer()
  const fullData = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
  const fullAnalysis = analyzePixels(fullData)
  const regionDefs = getRegions(SAMPLE_SIZE, SAMPLE_SIZE)
  const regions = {} as ImagePalette['regions']
  const flatness = { full: fullAnalysis.dominant.flatness } as ImagePalette['flatness']
  const regionCandidates: CandidateColor[] = []
  for (const [name, rect] of Object.entries(regionDefs)) {
    const rd = sliceRegion(fullData, SAMPLE_SIZE, rect)
    const result = dominantFromData(rd)
    ;(regions as any)[name] = result.color
    ;(flatness as any)[name] = result.flatness
    regionCandidates.push({ color: result.color, score: scoreCandidate(result.color, Math.max(1, (rect.w * rect.h) * Math.max(0.35, 1 - result.flatness))) })
  }
  const diversePalette = selectDistinctColors(
    [...fullAnalysis.candidates, ...regionCandidates, { color: fullAnalysis.average, score: scoreCandidate(fullAnalysis.average, SAMPLE_SIZE * SAMPLE_SIZE * 0.18) }],
    5,
    fullAnalysis.diversityScore
  )
  const isUniform = fullAnalysis.diversityScore < 0.16 || flatness.full > 0.56 || diversePalette.length < 3
  const palette = isUniform ? buildFallbackPalette(fullAnalysis.dominant.color, fullAnalysis.average) : diversePalette
  const ui = deriveUiSchemes(palette, fullAnalysis.dominant.color, fullAnalysis.average, fullAnalysis.luminanceProfile)
  const isLight = luminance(fullAnalysis.dominant.color.r, fullAnalysis.dominant.color.g, fullAnalysis.dominant.color.b) > 152
  return {
    dominant: fullAnalysis.dominant.color, regions, flatness, average: fullAnalysis.average, isLight, palette,
    diversity: { score: Number(fullAnalysis.diversityScore.toFixed(3)), isUniform, usedFallback: isUniform },
    ui,
  }
}

// ── Character-aware overlay derivation (port of characterTheme.ts) ──

const REF_DARK_BG: RGB = { r: 10, g: 10, b: 15 }
const REF_LIGHT_BG: RGB = { r: 250, g: 250, b: 252 }
const DARK_MODE_MAX_LUM = 215
const LIGHT_MODE_MIN_LUM = 50
const MIN_VIBRANT_SAT = 20

function pickMostVibrant(p: ImagePalette) {
  const cands: { rgb: RGB; flat: number }[] = [
    { rgb: p.dominant, flat: p.flatness.full },
    { rgb: p.regions.top, flat: p.flatness.top },
    { rgb: p.regions.center, flat: p.flatness.center },
    { rgb: p.regions.bottom, flat: p.flatness.bottom },
    { rgb: p.regions.left, flat: p.flatness.left },
    { rgb: p.regions.right, flat: p.flatness.right },
    { rgb: p.average, flat: 0 },
    ...p.palette.map((rgb) => ({ rgb, flat: 0 })),
  ]
  let best: { h: number; s: number; l: number } | null = null, bestScore = -1
  for (const { rgb, flat } of cands) {
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    const lP = hsl.l < 15 ? 0.3 : hsl.l > 85 ? 0.4 : 1
    const flatP = flat > 0.5 ? Math.max(0.1, 1 - flat) : 1
    const score = hsl.s * lP * flatP
    if (score > bestScore) { bestScore = score; best = hsl }
  }
  if (!best || best.s < MIN_VIBRANT_SAT) {
    const fb = rgbToHsl(p.dominant.r, p.dominant.g, p.dominant.b)
    return { h: fb.h, s: Math.max(fb.s, 45), l: 55 }
  }
  return best
}
function deriveCharacterNameVars(p: ImagePalette) {
  const hsl = pickMostVibrant(p)
  const darkS = clamp(hsl.s + 10, 45, 80)
  let darkL = clamp(hsl.l, 72, 85)
  const lightS = clamp(hsl.s + 15, 50, 85)
  let lightL = clamp(hsl.l, 25, 38)
  let darkRgb = ensureContrast(hslToRgb(hsl.h, darkS, darkL), REF_DARK_BG, MIN_TEXT_CONTRAST)
  darkRgb = constrainLuminance(darkRgb, undefined, DARK_MODE_MAX_LUM)
  darkL = rgbToHsl(darkRgb.r, darkRgb.g, darkRgb.b).l
  let lightRgb = ensureContrast(hslToRgb(hsl.h, lightS, lightL), REF_LIGHT_BG, MIN_TEXT_CONTRAST)
  lightRgb = constrainLuminance(lightRgb, LIGHT_MODE_MIN_LUM, undefined)
  lightL = rgbToHsl(lightRgb.r, lightRgb.g, lightRgb.b).l
  return {
    'char-name-dark': `hsl(${hsl.h}, ${darkS}%, ${darkL}%)`,
    'char-name-light': `hsl(${hsl.h}, ${lightS}%, ${lightL}%)`,
    'vibrant-source': `h=${hsl.h} s=${hsl.s} l=${hsl.l}`,
  }
}
function deriveSecondaryTone(seed: RGB, surface: RGB, mode: 'dark' | 'light'): RGB {
  const hsl = rgbToHsl(seed.r, seed.g, seed.b)
  let sec = hslToRgb(hsl.h, clamp(hsl.s, mode === 'dark' ? 20 : 16, mode === 'dark' ? 58 : 48), mode === 'dark' ? clamp(hsl.l, 42, 60) : clamp(hsl.l, 30, 46))
  sec = ensureContrast(sec, surface, MIN_TEXT_CONTRAST)
  return mode === 'dark' ? constrainLuminance(sec, undefined, DARK_MODE_MAX_LUM) : constrainLuminance(sec, LIGHT_MODE_MIN_LUM, undefined)
}
function deriveCharacterOverlay(p: ImagePalette) {
  const da = p.ui.dark.accent, la = p.ui.light.accent
  const ph = rgbToHsl(da.r, da.g, da.b)
  const secSeed = p.palette[1] ?? p.regions.center
  const secD = deriveSecondaryTone(secSeed, p.ui.dark.surface, 'dark')
  const secL = deriveSecondaryTone(secSeed, p.ui.light.surface, 'light')
  return {
    accent: { h: ph.h, s: ph.s, l: ph.l },
    dark: { primary: da, secondary: secD, background: p.ui.dark.surface, text: p.ui.dark.text },
    light: { primary: la, secondary: secL, background: p.ui.light.surface, text: p.ui.light.text },
  }
}

// ── Reporter ──

function rgb(c: RGB) { return `rgb(${c.r},${c.g},${c.b})` }
function hex(c: RGB) { return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` }
function hsl(c: RGB) { const h = rgbToHsl(c.r, c.g, c.b); return `hsl(${h.h},${h.s}%,${h.l}%)` }
function describe(c: RGB) { return `${hex(c).padEnd(8)} ${hsl(c).padEnd(20)} ${rgb(c).padEnd(18)} lum=${luminance(c.r,c.g,c.b).toFixed(0).padStart(3)}` }

async function reportImage(path: string) {
  const p = await extractPalette(path)
  console.log(`\n${'='.repeat(78)}\n  ${path}\n${'='.repeat(78)}`)
  console.log(`\n  dominant         ${describe(p.dominant)}`)
  console.log(`  average          ${describe(p.average)}`)
  console.log(`  diversity        score=${p.diversity.score} isUniform=${p.diversity.isUniform} usedFallback=${p.diversity.usedFallback}`)
  console.log(`  flatness.full    ${p.flatness.full.toFixed(3)}`)
  console.log(`\n  regions:`)
  for (const r of ['top', 'center', 'bottom', 'left', 'right'] as const) {
    console.log(`    ${r.padEnd(7)} flat=${p.flatness[r].toFixed(3)}  ${describe(p.regions[r])}`)
  }
  console.log(`\n  palette (${p.palette.length}):`)
  p.palette.forEach((c, i) => console.log(`    [${i}] ${describe(c)}`))

  for (const mode of ['dark', 'light'] as const) {
    const s = p.ui[mode]
    const surf = s.surface
    console.log(`\n  ui.${mode}:`)
    console.log(`    surface     ${describe(s.surface)}`)
    console.log(`    accent      ${describe(s.accent)}   contrast vs surface = ${contrastRatio(s.accent, surf).toFixed(2)}`)
    console.log(`    accentText  ${describe(s.accentText)}   contrast vs accent  = ${contrastRatio(s.accentText, s.accent).toFixed(2)}`)
    console.log(`    text        ${describe(s.text)}   contrast vs surface = ${contrastRatio(s.text, surf).toFixed(2)}`)
    console.log(`    mutedText   ${describe(s.mutedText)}   contrast vs surface = ${contrastRatio(s.mutedText, surf).toFixed(2)}`)
  }

  const nameVars = deriveCharacterNameVars(p)
  console.log(`\n  characterName vars:`)
  for (const [k, v] of Object.entries(nameVars)) console.log(`    --${k}: ${v}`)

  const overlay = deriveCharacterOverlay(p)
  console.log(`\n  characterOverlay (applied on top of user theme):`)
  console.log(`    accent hsl       h=${overlay.accent.h} s=${overlay.accent.s} l=${overlay.accent.l}`)
  console.log(`    dark.primary     ${describe(overlay.dark.primary)}`)
  console.log(`    dark.secondary   ${describe(overlay.dark.secondary)}`)
  console.log(`    dark.background  ${describe(overlay.dark.background)}`)
  console.log(`    dark.text        ${describe(overlay.dark.text)}   contrast vs bg = ${contrastRatio(overlay.dark.text, overlay.dark.background).toFixed(2)}`)
  console.log(`    light.primary    ${describe(overlay.light.primary)}`)
  console.log(`    light.secondary  ${describe(overlay.light.secondary)}`)
  console.log(`    light.background ${describe(overlay.light.background)}`)
  console.log(`    light.text       ${describe(overlay.light.text)}   contrast vs bg = ${contrastRatio(overlay.light.text, overlay.light.background).toFixed(2)}`)
}

const argv = process.argv.slice(2)
const inputs = (argv.length ? argv : ['~/Downloads/test-1.png', '~/Downloads/test-2.png', '~/Downloads/test-3.png'])
  .map((p) => p.startsWith('~') ? resolve(homedir(), p.slice(2)) : resolve(p))

for (const path of inputs) {
  await reportImage(path)
}
