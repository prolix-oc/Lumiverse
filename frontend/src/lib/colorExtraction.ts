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

export interface ReadableColorScheme {
  surface: RGB
  text: RGB
  mutedText: RGB
  accent: RGB
  accentText: RGB
}

export interface ColorSwatch {
  color: RGB
  population: number
  hsl: { h: number; s: number; l: number }
}

export interface ColorSwatches {
  vibrant: ColorSwatch | null
  muted: ColorSwatch | null
  darkVibrant: ColorSwatch | null
  lightVibrant: ColorSwatch | null
  darkMuted: ColorSwatch | null
  lightMuted: ColorSwatch | null
}

export interface AmbientGradient {
  dark: RGB
  light: RGB
}

export interface CharacterColorOverlay {
  accent: { h: number; s: number; l: number }
  baseColors: {
    primary: string
    secondary: string
    background: string
    text: string
  }
  baseColorsLight: {
    primary: string
    secondary: string
    background: string
    text: string
  }
}

export interface RegionExtremes {
  darkest: RGB
  lightest: RGB
}

export interface TextZoneCluster {
  /** Mean raw image color of the cluster (pre-composite). */
  color: RGB
  /** Fraction of the band this cluster represents (0–1, run-length deduped). */
  weight: number
  /** Mean row of the cluster as a fraction of image height (0–1). */
  meanY: number
  /** Hero mask opacity at meanY — how much of the image actually shows. */
  alpha: number
}

export interface TextZoneBand {
  clusters: TextZoneCluster[]
}

export interface ImagePalette {
  dominant: RGB
  regions: {
    top: RGB
    center: RGB
    bottom: RGB
    left: RGB
    right: RGB
  }
  /** Per-region flatness score (0–1). High values indicate a monotone/solid
   *  background region that should be deprioritized for color sampling. */
  flatness: {
    top: number
    center: number
    bottom: number
    left: number
    right: number
    full: number
  }
  average: RGB
  isLight: boolean
  palette: RGB[]
  /** New fields added in the palette engine overhaul. Older cached palettes
   *  may not have these, so consumers should treat them as optional. */
  swatches?: ColorSwatches
  ambient?: AmbientGradient
  diversity: {
    score: number
    isUniform: boolean
    usedFallback: boolean
  }
  ui: {
    dark: ReadableColorScheme
    light: ReadableColorScheme
  }
  overlay?: CharacterColorOverlay
  /** Per-region darkest/lightest averages (e.g. bottom.darkest is the average
   *  of the darkest 20% of pixels in the bottom region). Lets consumers pick
   *  text colors that are guaranteed to contrast with the worst-case part of
   *  the region where the text will render. */
  regionExtremes?: {
    top: RegionExtremes
    center: RegionExtremes
    bottom: RegionExtremes
    left: RegionExtremes
    right: RegionExtremes
  }
  /** Color clusters sampled from the hero text overlay's actual footprint
   *  (horizontally centered, lower third of the image), split into a `name`
   *  band and a `meta` band. Weights are run-length deduped so long smooth
   *  gradients don't outvote small distinct features, and each cluster
   *  carries the hero mask's alpha at its mean row so consumers can
   *  composite it with the page surface. */
  textZone?: {
    name: TextZoneBand
    meta: TextZoneBand
  }
}

const DEFAULT_FALLBACK_HUE = 263
const MIN_SEED_CHROMA = 5
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function mixColors(color: RGB, target: RGB, weight: number): RGB {
  const w = clamp(weight, 0, 1)
  return {
    r: Math.round(color.r + (target.r - color.r) * w),
    g: Math.round(color.g + (target.g - color.g) * w),
    b: Math.round(color.b + (target.b - color.b) * w),
  }
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
  // Standard HSL: saturation = d / (max + min) on the dark side, d / (2 - max - min) on the light.
  // The previous expression used d / (max - min) which is just d/d = 1, so every color with
  // lightness ≤ 50% was reported as 100% saturated. That falsely-saturated reading then drove
  // tuneAccentForSurface / deriveSecondaryTone / ensureContrast / constrainLuminance to walk
  // lightness on a pure-saturation hue — producing the neon-blue / neon-orange / cyan blow-outs
  // we see on dark cards.
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  }
}

/** WCAG 2.1 relative luminance (gamma-corrected). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/** WCAG 2.1 contrast ratio between two RGB colors. */
export function contrastRatio(rgb1: RGB, rgb2: RGB): number {
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b)
  const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

// ── Perceptual colour space helpers (CIELAB D65) ──

function srgbToLinear(c: number): number {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgbByte(c: number): number {
  c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(clamp(c * 255, 0, 255))
}

interface LabColor { L: number; a: number; b: number }

function rgbToLab({ r, g, b }: RGB): LabColor {
  const rl = srgbToLinear(r)
  const gl = srgbToLinear(g)
  const bl = srgbToLinear(b)

  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041

  const xp = x / 0.95047
  const yp = y / 1.0
  const zp = z / 1.08883

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)

  const L = 116 * f(yp) - 16
  const a = 500 * (f(xp) - f(yp))
  const cb = 200 * (f(yp) - f(zp))
  return { L, a, b: cb }
}

function labToRgb({ L, a, b }: LabColor): RGB {
  const fy = (L + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200

  const finv = (t: number) => {
    const t3 = Math.pow(t, 3)
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
  }

  const x = finv(fx) * 0.95047
  const y = finv(fy) * 1.0
  const z = finv(fz) * 1.08883

  let r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  let g2 = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
  let b2 = x * 0.0556434 + y * -0.2040259 + z * 1.0572252

  return {
    r: linearToSrgbByte(r),
    g: linearToSrgbByte(g2),
    b: linearToSrgbByte(b2),
  }
}

/** CIE76 perceptual distance in CIELAB (good enough for palette diversity). */
function deltaE(lab1: LabColor, lab2: LabColor): number {
  const dL = lab1.L - lab2.L
  const da = lab1.a - lab2.a
  const db = lab1.b - lab2.b
  return Math.sqrt(dL * dL + da * da + db * db)
}

/** CSS-like hue angle from CIELAB a*b* (0–360). */
function labHue(lab: LabColor): number {
  const deg = (Math.atan2(lab.b, lab.a) * 180) / Math.PI
  return deg < 0 ? deg + 360 : deg
}

/**
 * Adjust a foreground color until it meets a minimum contrast ratio against
 * the given background. Modifies lightness in HSL space while preserving hue
 * and saturation, which keeps the color's character intact.
 */
export function ensureContrast(
  foreground: RGB,
  background: RGB,
  minRatio: number
): RGB {
  const current = contrastRatio(foreground, background)
  if (current >= minRatio) return foreground

  const bgHsl = rgbToHsl(background.r, background.g, background.b)
  const fgHsl = rgbToHsl(foreground.r, foreground.g, foreground.b)

  // Lighten if bg is dark, darken if bg is light
  const step = bgHsl.l < 50 ? 1 : -1
  let bestCandidate = foreground
  let bestRatio = current

  for (let l = fgHsl.l; l >= 0 && l <= 100; l += step) {
    const candidate = hslToRgb(fgHsl.h, fgHsl.s, l)
    const ratio = contrastRatio(candidate, background)
    if (ratio >= minRatio) return candidate
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestCandidate = candidate
    }
  }

  return bestCandidate
}

/**
 * Adjust a color until its perceptual luminance stays within the requested
 * [minLum, maxLum] bounds (0–255 scale).  This is useful for eye-comfort
 * clamping: dark-mode colors can be capped so they are never blinding, and
 * light-mode colors can be floored so they are never too harsh.
 *
 * The algorithm walks lightness in HSL space (preserving hue/saturation) until
 * the luminance constraint is satisfied.
 */
export function constrainLuminance(
  color: RGB,
  minLum?: number,
  maxLum?: number
): RGB {
  const lum = luminance(color.r, color.g, color.b)

  if (
    (minLum === undefined || lum >= minLum) &&
    (maxLum === undefined || lum <= maxLum)
  ) {
    return color
  }

  const hsl = rgbToHsl(color.r, color.g, color.b)

  // Too dark — lighten
  if (minLum !== undefined && lum < minLum) {
    for (let l = hsl.l + 1; l <= 100; l++) {
      const candidate = hslToRgb(hsl.h, hsl.s, l)
      if (luminance(candidate.r, candidate.g, candidate.b) >= minLum) {
        return candidate
      }
    }
    return { r: 255, g: 255, b: 255 }
  }

  // Too bright — darken
  if (maxLum !== undefined && lum > maxLum) {
    for (let l = hsl.l - 1; l >= 0; l--) {
      const candidate = hslToRgb(hsl.h, hsl.s, l)
      if (luminance(candidate.r, candidate.g, candidate.b) <= maxLum) {
        return candidate
      }
    }
    return { r: 0, g: 0, b: 0 }
  }

  return color
}

/**
 * Parse a CSS colour value into an RGB object.
 * Supports `rgb(r, g, b)`, `rgba(r, g, b, a)`, `#rrggbb`, and `#rgb`.
 * Returns `null` for unrecognised values.
 */
export function parseCssColor(value: string): RGB | null {
  if (!value) return null

  const rgbMatch = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
    }
  }

  const hexMatch = value.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      }
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }

  return null
}

/**
 * Read the effective opaque backing-surface colour of an element by walking
 * up the DOM tree until a non-transparent `background-color` is found.
 * Returns `null` if no opaque surface is found (e.g. everything is transparent).
 */
export function getSurfaceColor(element: Element): RGB | null {
  let el: Element | null = element
  while (el) {
    const style = window.getComputedStyle(el as HTMLElement)
    const bg = style.backgroundColor
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      const parsed = parseCssColor(bg)
      if (parsed) return parsed
    }
    el = el.parentElement
  }
  return null
}

// ── Image loading ──

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    // `decoding = 'async'` lets the browser defer pixel decoding past onload,
    // which can leave drawImage/getImageData reading transparent pixels and
    // collapsing extractPalette into its grey/purple fallback. Await decode()
    // explicitly so the canvas sample only runs once pixels are guaranteed.
    img.decoding = 'async'
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
    img.onload = () => {
      const finish = () => {
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          reject(new Error(`Image decoded with zero dimensions: ${src}`))
          return
        }
        resolve(img)
      }
      // decode() is well-supported (Chrome 64+, FF 63+, Safari 11.1+) but
      // fall back gracefully if it isn't available or rejects spuriously.
      if (typeof img.decode === 'function') {
        img.decode().then(finish).catch(finish)
      } else {
        finish()
      }
    }
    img.src = src
  })
}

// ── Dominant color from pixel data ──

interface DominantResult { color: RGB; flatness: number }
interface BucketStats { count: number; r: number; g: number; b: number }
interface CandidateColor { color: RGB; score: number }
interface PixelAnalysis {
  dominant: DominantResult
  average: RGB
  diversityScore: number
  candidates: CandidateColor[]
  luminanceProfile: LuminanceProfile
}

interface LuminanceProfile {
  mostlyTooDark: boolean
  mostlyTooLight: boolean
}

function chooseQuantizationStep(avgDeviation: number): number {
  if (avgDeviation < 12) return 36
  if (avgDeviation < 22) return 28
  if (avgDeviation < 36) return 22
  return 16
}

function colorDistance(a: RGB, b: RGB): number {
  return deltaE(rgbToLab(a), rgbToLab(b))
}

function scoreCandidate(color: RGB, weight: number): number {
  const lab = rgbToLab(color)
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
  const satWeight = 0.38 + clamp(chroma / 100, 0, 1) * 0.92
  const lightPenalty = lab.L < 8 || lab.L > 96 ? 0.45 : lab.L < 16 || lab.L > 90 ? 0.75 : 1
  return Math.sqrt(Math.max(1, weight)) * satWeight * lightPenalty
}

function analyzePixels(data: Uint8ClampedArray): PixelAnalysis {
  let rSum = 0
  let gSum = 0
  let bSum = 0
  let opaqueCount = 0
  let tooDarkCount = 0
  let tooLightCount = 0

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const lum = luminance(r, g, b)
    if (lum < DARK_SURFACE_MIN_LUM) tooDarkCount++
    if (lum > LIGHT_SURFACE_MAX_LUM) tooLightCount++
    rSum += r
    gSum += g
    bSum += b
    opaqueCount++
  }

  if (opaqueCount === 0) {
    const grey = { r: 128, g: 128, b: 128 }
    return {
      dominant: { color: grey, flatness: 1 },
      average: grey,
      diversityScore: 0,
      candidates: [{ color: grey, score: 1 }],
      luminanceProfile: { mostlyTooDark: false, mostlyTooLight: false },
    }
  }

  const luminanceProfile = {
    mostlyTooDark: tooDarkCount / opaqueCount >= LUMINANCE_SKEW_RATIO,
    mostlyTooLight: tooLightCount / opaqueCount >= LUMINANCE_SKEW_RATIO,
  }

  const average = {
    r: Math.round(rSum / opaqueCount),
    g: Math.round(gSum / opaqueCount),
    b: Math.round(bSum / opaqueCount),
  }

  let deviationSum = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    deviationSum += Math.abs(data[i] - average.r)
    deviationSum += Math.abs(data[i + 1] - average.g)
    deviationSum += Math.abs(data[i + 2] - average.b)
  }

  const avgDeviation = deviationSum / (opaqueCount * 3)
  const quantStep = chooseQuantizationStep(avgDeviation)
  const buckets = new Map<string, BucketStats>()

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const qr = Math.round(r / quantStep) * quantStep
    const qg = Math.round(g / quantStep) * quantStep
    const qb = Math.round(b / quantStep) * quantStep
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

  let best: BucketStats | null = null
  buckets.forEach((bucket) => {
    if (!best || bucket.count > best.count) best = bucket
  })

  if (!best || best.count === 0) {
    const grey = { r: 128, g: 128, b: 128 }
    return {
      dominant: { color: grey, flatness: 1 },
      average,
      diversityScore: 0,
      candidates: [{ color: grey, score: 1 }],
      luminanceProfile,
    }
  }

  const dominant = {
    color: {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
    },
    flatness: best.count / opaqueCount,
  }

  const candidates = Array.from(buckets.values())
    .map((bucket) => {
      const color = {
        r: Math.round(bucket.r / bucket.count),
        g: Math.round(bucket.g / bucket.count),
        b: Math.round(bucket.b / bucket.count),
      }
      return {
        color,
        score: scoreCandidate(color, bucket.count),
      }
    })
    .sort((a, b) => b.score - a.score)

  const bucketSpread = clamp(buckets.size / 24, 0, 1)
  const diversityScore = clamp((avgDeviation / 52) * 0.72 + bucketSpread * 0.28, 0, 1)

  return { dominant, average, diversityScore, candidates, luminanceProfile }
}

function dominantFromData(data: Uint8ClampedArray): DominantResult {
  return analyzePixels(data).dominant
}

const HUE_BINS = 12
const LUM_BINS = 5

// ── K-means palette extraction in CIELAB ──

interface LabPixel { lab: LabColor; rgb: RGB; weight: number }

function kMeansPalette(pixels: LabPixel[], k: number, maxIterations = 12): LabColor[] {
  if (pixels.length === 0) return []
  if (k > pixels.length) k = pixels.length
  if (k <= 0) return []

  const quantStep = 24
  const buckets = new Map<string, { lab: LabColor; weight: number }>()
  for (const p of pixels) {
    const key = `${Math.round(p.lab.L / quantStep)}-${Math.round(p.lab.a / quantStep)}-${Math.round(p.lab.b / quantStep)}`
    const existing = buckets.get(key)
    if (existing) {
      existing.weight += p.weight
    } else {
      buckets.set(key, { lab: p.lab, weight: p.weight })
    }
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => b.weight - a.weight)
  const centroids: LabColor[] = sorted.slice(0, k).map((b) => ({ ...b.lab }))

  if (centroids.length === 0) {
    return pixels.slice(0, k).map((p) => ({ ...p.lab }))
  }

  while (centroids.length < k) {
    const source = centroids[centroids.length % sorted.length] ?? pixels[0].lab
    centroids.push({ L: source.L, a: source.a + 5, b: source.b })
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    const sums: LabColor[] = centroids.map(() => ({ L: 0, a: 0, b: 0 }))
    const counts = new Array(centroids.length).fill(0)

    for (const p of pixels) {
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < centroids.length; i++) {
        const d = deltaE(p.lab, centroids[i])
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      sums[bestIdx].L += p.lab.L * p.weight
      sums[bestIdx].a += p.lab.a * p.weight
      sums[bestIdx].b += p.lab.b * p.weight
      counts[bestIdx] += p.weight
    }

    let moved = false
    for (let i = 0; i < centroids.length; i++) {
      if (counts[i] === 0) continue
      const next = {
        L: sums[i].L / counts[i],
        a: sums[i].a / counts[i],
        b: sums[i].b / counts[i],
      }
      if (deltaE(next, centroids[i]) > 0.5) moved = true
      centroids[i] = next
    }

    if (!moved) break
  }

  return centroids
}

function buildKMeansPalette(
  data: Uint8ClampedArray,
  desiredCount: number,
): { palette: RGB[]; populations: number[] } {
  const pixels: LabPixel[] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const rgb: RGB = { r: data[i], g: data[i + 1], b: data[i + 2] }
    pixels.push({ lab: rgbToLab(rgb), rgb, weight: 1 })
  }

  if (pixels.length === 0) return { palette: [], populations: [] }

  const centroids = kMeansPalette(pixels, Math.max(desiredCount + 2, 8))
  const populations = new Array(centroids.length).fill(0)
  for (const p of pixels) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < centroids.length; i++) {
      const d = deltaE(p.lab, centroids[i])
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    populations[bestIdx]++
  }

  const colors = centroids.map((lab) => labToRgb(lab))
  const indexed = colors.map((color, i) => ({ color, population: populations[i] }))
  indexed.sort((a, b) => b.population - a.population)

  return {
    palette: indexed.map((x) => x.color),
    populations: indexed.map((x) => x.population),
  }
}

// ── Swatch classification (Android Palette-style) ──

function classifySwatches(palette: RGB[], populations: number[]): ColorSwatches {
  const swatches = palette.map((color, i) => ({
    color,
    population: populations[i] ?? 0,
    hsl: rgbToHsl(color.r, color.g, color.b),
  }))

  const vibrant = swatches
    .filter((s) => s.hsl.s >= 30 && s.hsl.l >= 30 && s.hsl.l <= 70)
    .sort((a, b) => b.population * b.hsl.s - a.population * a.hsl.s)[0] ?? null

  const muted = swatches
    .filter((s) => s.hsl.s >= 10 && s.hsl.s < 40 && s.hsl.l >= 30 && s.hsl.l <= 80)
    .sort((a, b) => b.population - a.population)[0] ?? null

  const darkVibrant = swatches
    .filter((s) => s.hsl.s >= 30 && s.hsl.l < 40)
    .sort((a, b) => b.population * b.hsl.s - a.population * a.hsl.s)[0] ?? null

  const lightVibrant = swatches
    .filter((s) => s.hsl.s >= 30 && s.hsl.l > 60)
    .sort((a, b) => b.population * b.hsl.s - a.population * a.hsl.s)[0] ?? null

  const darkMuted = swatches
    .filter((s) => s.hsl.s < 40 && s.hsl.l < 40)
    .sort((a, b) => b.population - a.population)[0] ?? null

  const lightMuted = swatches
    .filter((s) => s.hsl.s < 40 && s.hsl.l > 70)
    .sort((a, b) => b.population - a.population)[0] ?? null

  return { vibrant, muted, darkVibrant, lightVibrant, darkMuted, lightMuted }
}

function selectDistinctColors(candidates: CandidateColor[], desiredCount: number, diversityScore: number): RGB[] {
  if (candidates.length === 0) return []

  const baseThreshold =
    diversityScore > 0.32 ? 24 :
    diversityScore > 0.18 ? 18 :
    diversityScore > 0.08 ? 13 :
    8

  const scored = candidates
    .map((c) => {
      const lab = rgbToLab(c.color)
      const hue = labHue(lab)
      const lumBin = Math.min(LUM_BINS - 1, Math.max(0, Math.floor(lab.L / (100 / LUM_BINS))))
      const hueBin = Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS))
      return { ...c, lab, hue, lumBin, hueBin }
    })
    .sort((a, b) => b.score - a.score)

  type Item = (typeof scored)[number]
  const chosen: Item[] = []

  function tooClose(item: Item): boolean {
    return chosen.some((sel) => deltaE(sel.lab, item.lab) < 8)
  }

  function passesMinDistance(item: Item, minDist: number): boolean {
    if (chosen.length === 0) return true
    return chosen.every((sel) => deltaE(sel.lab, item.lab) >= minDist)
  }

  while (chosen.length < desiredCount) {
    const minDist = Math.max(6, baseThreshold - chosen.length * 3)

    const hueCounts = new Array(HUE_BINS).fill(0)
    const lumCounts = new Array(LUM_BINS).fill(0)
    for (const c of chosen) {
      hueCounts[c.hueBin]++
      lumCounts[c.lumBin]++
    }

    let best: Item | null = null
    let bestPriority = -Infinity

    for (const item of scored) {
      if (tooClose(item)) continue
      if (!passesMinDistance(item, minDist)) continue

      let priority = item.score
      if (hueCounts[item.hueBin] === 0) priority += 85
      else if (hueCounts[item.hueBin] === 1) priority += 35
      if (lumCounts[item.lumBin] === 0) priority += 65
      else if (lumCounts[item.lumBin] === 1) priority += 20

      if (priority > bestPriority) {
        bestPriority = priority
        best = item
      }
    }

    if (best) {
      chosen.push(best)
      continue
    }

    let relaxedAdded: Item | null = null
    const relaxed = Math.max(4, minDist * 0.55)
    for (const item of scored) {
      if (tooClose(item)) continue
      if (chosen.length === 0 || chosen.every((sel) => deltaE(sel.lab, item.lab) >= relaxed)) {
        relaxedAdded = item
        break
      }
    }

    if (relaxedAdded) {
      chosen.push(relaxedAdded)
      continue
    }

    if (chosen.length === 0) {
      chosen.push(scored[0])
      continue
    }

    break
  }

  return chosen.map((c) => c.color)
}

function pickFallbackHue(dominant: RGB, average: RGB): number {
  const candidates = [
    { color: dominant, weight: 1.0 },
    { color: average, weight: 0.7 },
  ]

  let bestHue = DEFAULT_FALLBACK_HUE
  let bestScore = -1

  for (const { color, weight } of candidates) {
    const lab = rgbToLab(color)
    const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
    const hsl = rgbToHsl(color.r, color.g, color.b)
    const lPenalty =
      hsl.l < 10 ? 0.1 :
      hsl.l > 88 ? 0.2 :
      hsl.l < 22 || hsl.l > 78 ? 0.6 : 1
    const score = chroma * lPenalty * weight
    if (score > bestScore) {
      bestScore = score
      bestHue = hsl.h
    }
  }

  return bestHue
}

function pickSeedHue(palette: RGB[], dominant: RGB, average: RGB): number {
  const vibrant = dedupeColors([...palette])
    .map((c) => ({ color: c, hsl: rgbToHsl(c.r, c.g, c.b) }))
    .filter((c) => c.hsl.s >= 26 && c.hsl.l >= 18 && c.hsl.l <= 82)
    .sort((a, b) => b.hsl.s - a.hsl.s)[0]
  if (vibrant) return vibrant.hsl.h

  const chromatic = dedupeColors([dominant, average, ...palette])
    .map((c) => ({ color: c, lab: rgbToLab(c), hsl: rgbToHsl(c.r, c.g, c.b) }))
    .filter((c) => c.hsl.l >= 8 && c.hsl.l <= 92)
    .sort((a, b) => {
      const ca = Math.sqrt(a.lab.a * a.lab.a + a.lab.b * a.lab.b)
      const cb = Math.sqrt(b.lab.a * b.lab.a + b.lab.b * b.lab.b)
      return cb - ca
    })[0]
  if (chromatic && Math.sqrt(chromatic.lab.a ** 2 + chromatic.lab.b ** 2) >= MIN_SEED_CHROMA) {
    return chromatic.hsl.h
  }

  return pickFallbackHue(dominant, average)
}

function deriveSurfaceFromSeed(seedHue: number, mode: 'dark' | 'light'): RGB {
  const sat = mode === 'dark' ? 10 : 6
  const light = mode === 'dark' ? 13 : 94
  const rgb = hslToRgb(seedHue, sat, light)
  return mode === 'dark'
    ? constrainLuminance(rgb, DARK_SURFACE_MIN_LUM, DARK_SURFACE_MAX_LUM)
    : constrainLuminance(rgb, LIGHT_SURFACE_MIN_LUM, LIGHT_SURFACE_MAX_LUM)
}

function buildFallbackPalette(dominant: RGB, average: RGB): RGB[] {
  const hue = pickFallbackHue(dominant, average)
  return [
    hslToRgb(hue, 72, 55),
    hslToRgb((hue + 30) % 360, 52, 42),
    hslToRgb((hue + 90) % 360, 58, 62),
    hslToRgb((hue + 180) % 360, 42, 38),
    hslToRgb((hue + 270) % 360, 36, 72),
  ]
}

function pickReadableTextColor(surface: RGB, tint: RGB, minRatio: number): RGB {
  const lightTarget = { r: 247, g: 249, b: 252 }
  const darkTarget = { r: 17, g: 22, b: 28 }
  const candidates = [
    ensureContrast(mixColors(tint, lightTarget, 0.88), surface, minRatio),
    ensureContrast(mixColors(tint, darkTarget, 0.88), surface, minRatio),
    ensureContrast(lightTarget, surface, minRatio),
    ensureContrast(darkTarget, surface, minRatio),
  ]
  const ranked = candidates
    .map((color) => ({ color, ratio: contrastRatio(color, surface) }))
    .sort((a, b) => b.ratio - a.ratio)
  const prefersLightText = relativeLuminance(surface.r, surface.g, surface.b) < 0.36
  const preferred = ranked.find(({ color, ratio }) => {
    if (ratio < minRatio) return false
    return prefersLightText ? relativeLuminance(color.r, color.g, color.b) > 0.5 : relativeLuminance(color.r, color.g, color.b) < 0.2
  })

  if (preferred) return preferred.color
  return ranked[0].color
}

function tuneAccentForSurface(accentBase: RGB, surface: RGB, mode: 'dark' | 'light'): RGB {
  const accentHsl = rgbToHsl(accentBase.r, accentBase.g, accentBase.b)
  let tuned = hslToRgb(
    accentHsl.h,
    clamp(accentHsl.s, 32, 88),
    mode === 'dark' ? clamp(accentHsl.l, 42, 74) : clamp(accentHsl.l, 26, 40),
  )

  tuned = mode === 'dark'
    ? constrainLuminance(tuned, DARK_ACCENT_MIN_LUM, DARK_ACCENT_MAX_LUM)
    : constrainLuminance(tuned, LIGHT_ACCENT_MIN_LUM, LIGHT_ACCENT_MAX_LUM)

  const contrasted = ensureContrast(tuned, surface, MIN_UI_CONTRAST)
  return mode === 'dark'
    ? constrainLuminance(contrasted, DARK_ACCENT_MIN_LUM, DARK_ACCENT_MAX_LUM)
    : constrainLuminance(contrasted, LIGHT_ACCENT_MIN_LUM, LIGHT_ACCENT_MAX_LUM)
}

function dedupeColors(colors: RGB[]): RGB[] {
  const unique: RGB[] = []
  for (const color of colors) {
    if (unique.some((existing) => colorDistance(existing, color) < 9)) continue
    unique.push(color)
  }
  return unique
}

function pickAccentBase(colors: RGB[], surface: RGB, seedHue: number): RGB {
  const candidates = dedupeColors(colors)
  let best = candidates[0] ?? surface
  let bestScore = -1

  const surfaceLab = rgbToLab(surface)

  for (const candidate of candidates) {
    const hsl = rgbToHsl(candidate.r, candidate.g, candidate.b)
    const lab = rgbToLab(candidate)
    const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
    const vibrancy = clamp(chroma / 60, 0, 1) * 0.8 + (hsl.s / 100) * 0.6

    const rawHueDiff = Math.abs(hsl.h - seedHue)
    const hueDiff = Math.min(rawHueDiff, 360 - rawHueDiff)
    const hueMatch = 1 - clamp(hueDiff / 90, 0, 1)
    const separation = clamp(deltaE(lab, surfaceLab) / 140, 0, 1)
    const lightPenalty = hsl.l < 10 || hsl.l > 92 ? 0.35 : hsl.l < 18 || hsl.l > 84 ? 0.68 : 1

    const score = hueMatch * 2.0 + vibrancy * 1.2 + separation * 0.5 + lightPenalty
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return best
}

function deriveReadableScheme(
  surfaceBase: RGB,
  accentBase: RGB,
  mode: 'dark' | 'light',
  _luminanceProfile: LuminanceProfile
): ReadableColorScheme {
  const surface = mode === 'dark'
    ? constrainLuminance(surfaceBase, DARK_SURFACE_MIN_LUM, DARK_SURFACE_MAX_LUM)
    : constrainLuminance(surfaceBase, LIGHT_SURFACE_MIN_LUM, LIGHT_SURFACE_MAX_LUM)

  const accent = tuneAccentForSurface(accentBase, surface, mode)
  let accentText = pickReadableTextColor(accent, surface, MIN_TEXT_CONTRAST)
  accentText = ensureContrast(accentText, accent, MIN_TEXT_CONTRAST)
  let text = pickReadableTextColor(surface, accentBase, MIN_TEXT_CONTRAST)
  text = ensureContrast(text, surface, MIN_TEXT_CONTRAST)
  const mutedSeed = mixColors(text, surface, 0.28)
  const mutedText = ensureContrast(mutedSeed, surface, 3.6)

  return { surface, text, mutedText, accent, accentText }
}

function deriveUiSchemes(
  palette: RGB[],
  dominant: RGB,
  average: RGB,
  luminanceProfile: LuminanceProfile = { mostlyTooDark: false, mostlyTooLight: false }
): { dark: ReadableColorScheme; light: ReadableColorScheme } {
  const colors = dedupeColors([dominant, average, ...palette])
  const seedHue = pickSeedHue(palette, dominant, average)

  const darkSurfaceBase = deriveSurfaceFromSeed(seedHue, 'dark')
  const lightSurfaceBase = deriveSurfaceFromSeed(seedHue, 'light')

  const vibrant = colors
    .map((c) => ({ color: c, hsl: rgbToHsl(c.r, c.g, c.b) }))
    .filter((c) => c.hsl.s >= 26 && c.hsl.l >= 18 && c.hsl.l <= 82)
    .sort((a, b) => b.hsl.s - a.hsl.s)[0]

  const darkAccentBase = vibrant
    ? tuneAccentForSurface(vibrant.color, darkSurfaceBase, 'dark')
    : pickAccentBase(colors, darkSurfaceBase, seedHue)
  const lightAccentBase = vibrant
    ? tuneAccentForSurface(vibrant.color, lightSurfaceBase, 'light')
    : pickAccentBase(colors, lightSurfaceBase, seedHue)

  return {
    dark: deriveReadableScheme(darkSurfaceBase, darkAccentBase, 'dark', luminanceProfile),
    light: deriveReadableScheme(lightSurfaceBase, lightAccentBase, 'light', luminanceProfile),
  }
}

// ── Ambient gradient colors (Apple Music / YouTube Ambient Mode style) ──

function deriveAmbientGradient(
  palette: RGB[],
  dominant: RGB,
  average: RGB,
  swatches: ColorSwatches
): AmbientGradient {
  const seed = swatches.vibrant?.color ?? swatches.muted?.color ?? dominant

  const darkBase = rgbToLab(seed)
  const dark = labToRgb({
    L: clamp(darkBase.L * 0.55, 12, 28),
    a: darkBase.a * 0.85,
    b: darkBase.b * 0.85,
  })

  const lightBase = rgbToLab(seed)
  const light = labToRgb({
    L: clamp(lightBase.L * 1.25 + 18, 220, 245),
    a: lightBase.a * 0.35,
    b: lightBase.b * 0.35,
  })

  return {
    dark: mixColors(dark, average, 0.15),
    light: mixColors(light, average, 0.22),
  }
}

// ── Character-aware overlay ──

const REF_DARK_BG: RGB = { r: 10, g: 10, b: 15 }
const REF_LIGHT_BG: RGB = { r: 250, g: 250, b: 252 }
const DARK_MODE_MAX_LUM = 215
const LIGHT_MODE_MIN_LUM = 50
const MIN_VIBRANT_SAT = 20

function pickMostVibrant(
  palette: RGB[],
  dominant: RGB,
  regions: ImagePalette['regions'],
  flatness: ImagePalette['flatness'],
  average: RGB
): { h: number; s: number; l: number } {
  const candidates: Array<{ rgb: RGB; flatness: number }> = [
    { rgb: dominant, flatness: flatness.full },
    { rgb: regions.top, flatness: flatness.top },
    { rgb: regions.center, flatness: flatness.center },
    { rgb: regions.bottom, flatness: flatness.bottom },
    { rgb: regions.left, flatness: flatness.left },
    { rgb: regions.right, flatness: flatness.right },
    { rgb: average, flatness: 0 },
    ...palette.map((rgb) => ({ rgb, flatness: 0 })),
  ]

  let best: { h: number; s: number; l: number } | null = null
  let bestScore = -1

  for (const { rgb, flatness: flat } of candidates) {
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    const lPenalty = hsl.l < 15 ? 0.3 : hsl.l > 85 ? 0.4 : 1
    const flatPenalty = flat > 0.5 ? Math.max(0.1, 1 - flat) : 1
    const score = hsl.s * lPenalty * flatPenalty
    if (score > bestScore) {
      bestScore = score
      best = hsl
    }
  }

  if (!best || best.s < MIN_VIBRANT_SAT) {
    const fallback = rgbToHsl(dominant.r, dominant.g, dominant.b)
    return { h: fallback.h, s: Math.max(fallback.s, 45), l: 55 }
  }

  return best
}

export function deriveCharacterNameVarsFromPalette(palette: ImagePalette): { dark: string; light: string } {
  const hsl = pickMostVibrant(palette.palette, palette.dominant, palette.regions, palette.flatness, palette.average)

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
    dark: `hsl(${hsl.h}, ${darkS}%, ${darkL}%)`,
    light: `hsl(${hsl.h}, ${lightS}%, ${lightL}%)`,
  }
}

function deriveSecondaryTone(seed: RGB, surface: RGB, mode: 'dark' | 'light'): RGB {
  const hsl = rgbToHsl(seed.r, seed.g, seed.b)
  let secondary = hslToRgb(
    hsl.h,
    clamp(hsl.s, mode === 'dark' ? 20 : 16, mode === 'dark' ? 58 : 48),
    mode === 'dark' ? clamp(hsl.l, 42, 60) : clamp(hsl.l, 30, 46)
  )

  secondary = ensureContrast(secondary, surface, MIN_TEXT_CONTRAST)
  return mode === 'dark'
    ? constrainLuminance(secondary, undefined, DARK_MODE_MAX_LUM)
    : constrainLuminance(secondary, LIGHT_MODE_MIN_LUM, undefined)
}

export function deriveCharacterOverlayFromPalette(palette: ImagePalette): CharacterColorOverlay {
  const darkAccent = palette.ui.dark.accent
  const lightAccent = palette.ui.light.accent
  const primaryHsl = rgbToHsl(darkAccent.r, darkAccent.g, darkAccent.b)

  const secondarySeed = palette.palette[1] ?? palette.palette[0] ?? darkAccent
  const secondaryDark = deriveSecondaryTone(secondarySeed, palette.ui.dark.surface, 'dark')
  const secondaryLight = deriveSecondaryTone(secondarySeed, palette.ui.light.surface, 'light')

  return {
    accent: { h: primaryHsl.h, s: primaryHsl.s, l: primaryHsl.l },
    baseColors: {
      primary: rgbToCss(darkAccent),
      secondary: rgbToCss(secondaryDark),
      background: rgbToCss(palette.ui.dark.surface),
      text: rgbToCss(palette.ui.dark.text),
    },
    baseColorsLight: {
      primary: rgbToCss(lightAccent),
      secondary: rgbToCss(secondaryLight),
      background: rgbToCss(palette.ui.light.surface),
      text: rgbToCss(palette.ui.light.text),
    },
  }
}

function rgbToCss(color: RGB): string {
  return `rgb(${color.r} ${color.g} ${color.b})`
}

// ── Region sampling ──

const SAMPLE_SIZE = 64

interface Region { x: number; y: number; w: number; h: number }

/**
 * Compute the average of the darkest `percentile` and lightest `percentile`
 * pixels in a region. This is more robust than the absolute min/max because it
 * ignores tiny specks and gives a representative extreme color for the region.
 */
function regionExtremesFromData(data: Uint8ClampedArray, percentile = 0.2): RegionExtremes {
  const pixels: { rgb: RGB; lum: number }[] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const rgb: RGB = { r: data[i], g: data[i + 1], b: data[i + 2] }
    const lum = luminance(rgb.r, rgb.g, rgb.b)
    pixels.push({ rgb, lum })
  }

  if (pixels.length === 0) {
    const grey: RGB = { r: 128, g: 128, b: 128 }
    return { darkest: grey, lightest: grey }
  }

  pixels.sort((a, b) => a.lum - b.lum)
  const count = Math.max(1, Math.floor(pixels.length * percentile))
  const darkest = pixels.slice(0, count)
  const lightest = pixels.slice(-count)

  const average = (arr: typeof darkest) => ({
    r: Math.round(arr.reduce((s, p) => s + p.rgb.r, 0) / arr.length),
    g: Math.round(arr.reduce((s, p) => s + p.rgb.g, 0) / arr.length),
    b: Math.round(arr.reduce((s, p) => s + p.rgb.b, 0) / arr.length),
  })

  return { darkest: average(darkest), lightest: average(lightest) }
}

// ── Hero text-zone sampling ──

/** The hero text overlay (`.heroMeta`) sits over the lower-center of the hero
 *  image: horizontally centered with page padding, starting at ~70% of image
 *  height (margin-top: -45% of *width* over a 2:3 image). The name is the
 *  topmost element; edit button / creator / tags flow below it. */
const TEXT_ZONE_X0 = 0.10
const TEXT_ZONE_X1 = 0.90
const TEXT_ZONE_NAME_Y0 = 0.68
const TEXT_ZONE_NAME_Y1 = 0.82
const TEXT_ZONE_META_Y1 = 1.0
const TEXT_ZONE_LAB_STEP = 10
const TEXT_ZONE_MIN_WEIGHT = 0.05
const TEXT_ZONE_MAX_CLUSTERS = 8

/**
 * Opacity of `.heroImage`'s CSS mask at a given fraction of image height.
 * Mirrors `mask-image: linear-gradient(to bottom, black 55%, rgba(0,0,0,0.5) 75%, transparent 95%)`.
 */
export function heroMaskAlpha(y: number): number {
  if (y <= 0.55) return 1
  if (y < 0.75) return 1 - 0.5 * ((y - 0.55) / 0.2)
  if (y < 0.95) return 0.5 * (1 - (y - 0.75) / 0.2)
  return 0
}

function extractTextZoneBand(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  y0Frac: number,
  y1Frac: number
): TextZoneBand {
  const x0 = Math.max(0, Math.floor(TEXT_ZONE_X0 * width))
  const x1 = Math.min(width, Math.ceil(TEXT_ZONE_X1 * width))
  const y0 = Math.max(0, Math.floor(y0Frac * height))
  const y1 = Math.min(height, Math.ceil(y1Frac * height))

  interface Bucket { weight: number; r: number; g: number; b: number; y: number }
  const buckets = new Map<string, Bucket>()

  for (let y = y0; y < y1; y++) {
    let runKey: string | null = null
    let runLen = 0
    let runR = 0
    let runG = 0
    let runB = 0

    const flush = () => {
      if (runKey === null || runLen === 0) return
      // A run of consecutive similar pixels is one visual feature — weight it
      // by sqrt(runLength) so long smooth gradients don't outvote the small
      // distinct elements (line art, strokes) the text actually overlaps.
      const w = Math.sqrt(runLen)
      const invLen = 1 / runLen
      const bucket = buckets.get(runKey)
      if (bucket) {
        bucket.weight += w
        bucket.r += runR * invLen * w
        bucket.g += runG * invLen * w
        bucket.b += runB * invLen * w
        bucket.y += y * w
      } else {
        buckets.set(runKey, {
          weight: w,
          r: runR * invLen * w,
          g: runG * invLen * w,
          b: runB * invLen * w,
          y: y * w,
        })
      }
      runKey = null
      runLen = 0
      runR = 0
      runG = 0
      runB = 0
    }

    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 48) {
        flush()
        continue
      }
      const lab = rgbToLab({ r: data[i], g: data[i + 1], b: data[i + 2] })
      const key = `${Math.round(lab.L / TEXT_ZONE_LAB_STEP)}-${Math.round(lab.a / TEXT_ZONE_LAB_STEP)}-${Math.round(lab.b / TEXT_ZONE_LAB_STEP)}`
      if (key === runKey) {
        runLen++
        runR += data[i]
        runG += data[i + 1]
        runB += data[i + 2]
      } else {
        flush()
        runKey = key
        runLen = 1
        runR = data[i]
        runG = data[i + 1]
        runB = data[i + 2]
      }
    }
    flush()
  }

  let total = 0
  buckets.forEach((b) => { total += b.weight })
  if (total === 0) return { clusters: [] }

  const significant = Array.from(buckets.values())
    .filter((b) => b.weight / total >= TEXT_ZONE_MIN_WEIGHT)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TEXT_ZONE_MAX_CLUSTERS)

  let sigTotal = 0
  significant.forEach((b) => { sigTotal += b.weight })

  return {
    clusters: significant.map((b) => {
      const meanY = (b.y / b.weight + 0.5) / height
      return {
        color: {
          r: Math.round(b.r / b.weight),
          g: Math.round(b.g / b.weight),
          b: Math.round(b.b / b.weight),
        },
        weight: b.weight / sigTotal,
        meanY,
        alpha: heroMaskAlpha(meanY),
      }
    }),
  }
}

/**
 * Sample the hero text footprint from a raw RGBA buffer into cluster
 * statistics for the name and meta bands. Pure — works on any RGBA buffer
 * (canvas `getImageData` in the browser, sharp raw output in tooling).
 */
export function extractTextZoneFromData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { name: TextZoneBand; meta: TextZoneBand } {
  return {
    name: extractTextZoneBand(data, width, height, TEXT_ZONE_NAME_Y0, TEXT_ZONE_NAME_Y1),
    meta: extractTextZoneBand(data, width, height, TEXT_ZONE_NAME_Y1, TEXT_ZONE_META_Y1),
  }
}

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

/** Count opaque pixels in a raw RGBA buffer using the same alpha cutoff as analyzePixels. */
function countOpaquePixels(data: Uint8ClampedArray): number {
  let count = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] >= 48) count++
  }
  return count
}

/**
 * Draw `img` into `canvas` and return the full RGBA buffer, retrying across
 * animation frames if the read comes back fully transparent.
 *
 * Even after `img.decode()` resolves, some browsers will paint the next
 * `drawImage`/`getImageData` as fully transparent if the texture hasn't been
 * uploaded yet (cache miss after eviction, slow GPU upload, hidden tab waking,
 * etc.). When that happens analyzePixels falls through to grey, which makes
 * `extractPalette` treat the result as a "uniform" image, which triggers the
 * `DEFAULT_FALLBACK_HUE` (263 — a vivid blue/violet). That cascade is what
 * causes character-aware themes to randomly flip the whole UI super blue.
 *
 * We retry a few times with a frame yield in between, then give up and throw
 * — the caller treats throws as "do not apply overlay", which preserves the
 * user's existing theme instead of poisoning it with the fallback hue.
 */
async function sampleImageData(
  img: HTMLImageElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  src: string
): Promise<Uint8ClampedArray> {
  const maxAttempts = 3
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve())
        } else {
          setTimeout(resolve, 16)
        }
      })
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    if (countOpaquePixels(data) > 0) return data
  }
  throw new Error(`Image rendered with no opaque pixels after ${maxAttempts} attempts: ${src}`)
}

export async function extractPalette(src: string): Promise<ImagePalette> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    const grey: RGB = { r: 128, g: 128, b: 128 }
    const flatRegions = { top: 1, center: 1, bottom: 1, left: 1, right: 1, full: 1 }
    const fallbackPalette = buildFallbackPalette(grey, grey)
    const fallbackUi = deriveUiSchemes(fallbackPalette, grey, grey)
    const fallbackSwatches = classifySwatches(fallbackPalette, fallbackPalette.map(() => 1))
    const fallbackAmbient = deriveAmbientGradient(fallbackPalette, grey, grey, fallbackSwatches)
    const fallbackOverlay = deriveCharacterOverlayFromPalette({
      dominant: grey,
      regions: { top: grey, center: grey, bottom: grey, left: grey, right: grey },
      flatness: flatRegions,
      average: grey,
      isLight: false,
      palette: fallbackPalette,
      swatches: fallbackSwatches,
      ambient: fallbackAmbient,
      diversity: { score: 0, isUniform: true, usedFallback: true },
      ui: fallbackUi,
      overlay: { accent: { h: 0, s: 0, l: 0 }, baseColors: { primary: '', secondary: '', background: '', text: '' }, baseColorsLight: { primary: '', secondary: '', background: '', text: '' } },
    })
    const fallbackExtremes: RegionExtremes = { darkest: grey, lightest: grey }
    const fallbackTextZone: TextZoneBand = {
      clusters: [{ color: grey, weight: 1, meanY: 0.85, alpha: heroMaskAlpha(0.85) }],
    }
    return {
      dominant: grey,
      regions: { top: grey, center: grey, bottom: grey, left: grey, right: grey },
      flatness: flatRegions,
      average: grey,
      isLight: false,
      palette: fallbackPalette,
      swatches: fallbackSwatches,
      ambient: fallbackAmbient,
      diversity: { score: 0, isUniform: true, usedFallback: true },
      ui: fallbackUi,
      overlay: fallbackOverlay,
      regionExtremes: {
        top: fallbackExtremes,
        center: fallbackExtremes,
        bottom: fallbackExtremes,
        left: fallbackExtremes,
        right: fallbackExtremes,
      },
      textZone: { name: fallbackTextZone, meta: fallbackTextZone },
    }
  }

  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE

  // Full-image analysis. sampleImageData verifies we actually painted opaque
  // pixels before we derive anything — otherwise we'd silently fall into the
  // blue/violet fallback hue and stamp it onto the UI.
  const fullData = await sampleImageData(img, canvas, ctx, src)
  const fullAnalysis = analyzePixels(fullData)

  // Per-region analysis
  const regionDefs = getRegions(SAMPLE_SIZE, SAMPLE_SIZE)
  const regions = {} as ImagePalette['regions']
  const flatness = { full: fullAnalysis.dominant.flatness } as ImagePalette['flatness']
  const regionCandidates: CandidateColor[] = []
  const regionExtremes = {} as NonNullable<ImagePalette['regionExtremes']>
  for (const [name, rect] of Object.entries(regionDefs)) {
    const regionData = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data
    const result = dominantFromData(regionData)
    ;(regions as any)[name] = result.color
    ;(flatness as any)[name] = result.flatness
    ;(regionExtremes as any)[name] = regionExtremesFromData(regionData)
    regionCandidates.push({
      color: result.color,
      score: scoreCandidate(result.color, Math.max(1, (rect.w * rect.h) * Math.max(0.35, 1 - result.flatness))),
    })
  }

  const textZone = extractTextZoneFromData(fullData, SAMPLE_SIZE, SAMPLE_SIZE)

  const { palette: kMeansPalette, populations } = buildKMeansPalette(fullData, 6)

  const diversePalette = selectDistinctColors(
    [
      ...kMeansPalette.map((color, i) => ({ color, score: scoreCandidate(color, populations[i] ?? 1) })),
      ...fullAnalysis.candidates,
      ...regionCandidates,
      { color: fullAnalysis.average, score: scoreCandidate(fullAnalysis.average, SAMPLE_SIZE * SAMPLE_SIZE * 0.18) },
    ],
    5,
    fullAnalysis.diversityScore,
  )

  const isUniform = fullAnalysis.diversityScore < 0.16 || flatness.full > 0.72 || diversePalette.length < 3
  const palette = isUniform
    ? buildFallbackPalette(fullAnalysis.dominant.color, fullAnalysis.average)
    : diversePalette
  const ui = deriveUiSchemes(palette, fullAnalysis.dominant.color, fullAnalysis.average, fullAnalysis.luminanceProfile)
  const swatches = classifySwatches(palette, isUniform ? palette.map(() => 1) : populations)
  const ambient = deriveAmbientGradient(palette, fullAnalysis.dominant.color, fullAnalysis.average, swatches)
  const overlay = deriveCharacterOverlayFromPalette({
    dominant: fullAnalysis.dominant.color,
    regions,
    flatness,
    average: fullAnalysis.average,
    isLight: false,
    palette,
    swatches,
    ambient,
    diversity: { score: 0, isUniform, usedFallback: isUniform },
    ui,
    overlay: { accent: { h: 0, s: 0, l: 0 }, baseColors: { primary: '', secondary: '', background: '', text: '' }, baseColorsLight: { primary: '', secondary: '', background: '', text: '' } },
  })
  const isLight = luminance(fullAnalysis.dominant.color.r, fullAnalysis.dominant.color.g, fullAnalysis.dominant.color.b) > 152

  return {
    dominant: fullAnalysis.dominant.color,
    regions,
    flatness,
    average: fullAnalysis.average,
    isLight,
    palette,
    swatches,
    ambient,
    diversity: {
      score: Number(fullAnalysis.diversityScore.toFixed(3)),
      isUniform,
      usedFallback: isUniform,
    },
    ui,
    overlay,
    regionExtremes,
    textZone,
  }
}

/**
 * Lightweight single-color extraction (backwards compatible with original).
 */
export async function extractDominantColor(src: string): Promise<RGB> {
  const palette = await extractPalette(src)
  return palette.dominant
}
