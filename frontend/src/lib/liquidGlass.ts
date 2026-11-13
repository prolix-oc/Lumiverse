import type { ThemeConfig } from '@/types/theme'

/**
 * Whether the liquid-glass material should paint.
 *
 * Liquid glass is a second, more expensive layer on top of the frosted
 * `enableGlass` material: it refracts the backdrop with an SVG displacement
 * filter instead of only blurring it. It therefore inherits every one of
 * glass's own gates — plain glass must be on, efficiency rendering must be
 * off (it strips all backdrop filters), and the user must not have asked for
 * reduced motion. Keeping the predicate in one place means the settings panel,
 * the theme applicator, and the SVG filter host can never disagree about
 * whether the effect is live.
 */
export function isLiquidGlassActive(
  config: Pick<ThemeConfig, 'enableGlass' | 'liquidGlass' | 'renderingMode'> | null | undefined,
  prefersReducedMotion: boolean,
): boolean {
  if (!config?.liquidGlass || !config.enableGlass) return false
  if (config.renderingMode === 'efficiency') return false
  return !prefersReducedMotion
}

/**
 * The ten Liquid Glass controls.
 *
 * These are the values the Appearance panel ships, supplied as the source of
 * truth for the material. They are deliberately not the library's own
 * `controls.js` defaults — the panel's settings differ from the demo's on every
 * control — so the material is tuned by them and the library supplies only the
 * maths that consumes them. The vendored copy under `vendor/liquid-glass-js` is
 * left byte-for-byte as published.
 */
export interface LiquidGlassControls {
  edgeIntensity: number
  rimIntensity: number
  baseIntensity: number
  edgeDistance: number
  rimDistance: number
  baseDistance: number
  cornerBoost: number
  rippleEffect: number
  blurRadius: number
  tintOpacity: number
}

export const LIQUID_GLASS_CONTROLS: LiquidGlassControls = {
  edgeIntensity: 0.009,
  rimIntensity: 0.0,
  baseIntensity: 0.011,
  edgeDistance: 0.05,
  rimDistance: 0.5,
  baseDistance: 0.15,
  cornerBoost: 0.1,
  rippleEffect: 0.28,
  blurRadius: 1.0,
  tintOpacity: 0.29,
}

/**
 * Resolution of the generated normal map.
 *
 * The map is a rounded-rectangle lens stretched over each surface with
 * `preserveAspectRatio="none"`, so one image serves every size in the app: a
 * 24px toolbar button and a full-height panel read the same bevel. 192 keeps the
 * ramp smooth while the whole thing stays a few kilobytes, and it is generated
 * once for the process rather than per surface.
 */
const MAP_SIZE = 192

/**
 * Reference surface size, in pixels.
 *
 * The library states its displacement in texture coordinates, so a weight of
 * `w` shifts the backdrop by `w * pageSize` pixels — the refraction scales with
 * the page, not the surface, and a 1200px window gets roughly ten pixels of
 * bevel. Carrying that over verbatim would make the material depend on the
 * window size, so the falloffs are instead evaluated against a fixed reference
 * surface. 400px is the size the bevel is tuned for: large enough that a panel
 * reads as glass, small enough that the app's 24-40px toolbar buttons and menu
 * rows are bevelled rather than swallowed. This is the only place the port
 * departs from the library.
 */
export const REFERENCE = 400

/**
 * Bevel strength.
 *
 * `AMPLITUDE` lifts the shader's dimensionless intensity into the 0..1 channel
 * `feDisplacementMap` reads, and `LENS_SCALE` is the filter's scale. The rendered
 * displacement is their product times the intensity.
 *
 * `LENS_SCALE` is a *fraction of the element*, not a pixel count, because the
 * filter declares `primitiveUnits="objectBoundingBox"` — the only formulation
 * that makes `feImage` fill the element. (With the default user-space units,
 * `feImage` resolves its percentages against the viewport, so every surface
 * would show whichever slice of the map its position happened to fall on, and
 * only elements at the viewport edge would get a rim.) A displacement of `dx`
 * therefore shifts the backdrop by `dx * LENS_SCALE * elementWidth`, and
 * `1 / AMPLITUDE` reproduces the shader's own maths: at the reference width the
 * rim bevel lands on `EDGE_INTENSITY * REFERENCE`, the same few pixels the
 * library gives. `AMPLITUDE` is set so the strongest term (the corner) still
 * fits inside the channel without clipping.
 */
const AMPLITUDE = 4.5
export const LENS_SCALE = 1 / AMPLITUDE

/** Corner radius of the lens, as a fraction of the surface. */
const CORNER_RADIUS = 0.22

/**
 * Signed distance to a rounded rectangle, negative inside, in pixels.
 *
 * The offsets are taken from the shape's centre, which is what the shader does:
 * `abs(pixelCoord - center) - (center - radius)`. Measuring `abs(x)` against the
 * half-extent instead — forgetting that the coordinate runs 0..size rather than
 * -half..+half — puts the shape's centre at the corner and inverts the field.
 */
function roundedRectDistance(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const qx = Math.abs(x - halfWidth) - (halfWidth - radius)
  const qy = Math.abs(y - halfHeight) - (halfHeight - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - radius
}

/**
 * Evaluate the library's fragment shader into an RGBA normal map.
 *
 * This is `Container`'s fragment `main`, term for term. For each pixel it takes
 * the signed distance inside the rounded rectangle, turns that into the three
 * falloffs — `exp(-d * edgeDistance)` for the edge, `exp(-d * rimDistance)` for
 * the rim, and `1 - exp(-d * baseDistance)` for the base — weights them by their
 * intensities, adds the corner boost, and displaces along the shape normal:
 *
 *   base  = u_warp > 0.5 ? baseFalloff * baseIntensity : 0
 *   total = base + edgeFalloff * edgeIntensity + rimFalloff * rimIntensity
 *   total += exp(-cornerNormalized * 0.3) * cornerBoost
 *   ripple = sin(distFromEdge / REFERENCE * 25) * rippleEffect * rimFalloff
 *   textureCoord += shapeNormal * total + perpendicular * ripple
 *
 * Two details are easy to get wrong and are reproduced deliberately. The normal
 * is radial — `normalize(coord - center)`, not the gradient of the distance
 * field — so an edge is pushed straight out from the centre. And the corner term
 * keys off `max(min(x, 1-x), min(y, 1-y))`, which is near zero only where the
 * pixel is close to two edges at once, so it lights corners and leaves a straight
 * edge alone.
 *
 * The rim term and the ripple are both multiplied by `rimIntensity` in the
 * shader, so at the shipped value of 0 neither contributes — but both stay in the
 * maths, so raising the control brings them back. `u_warp` gates the base term and
 * is off, so the base does not contribute either.
 */
export function buildNormalMap(controls: LiquidGlassControls): Uint8ClampedArray<ArrayBuffer> {
  const n = MAP_SIZE
  const data = new Uint8ClampedArray(new ArrayBuffer(n * n * 4))
  const radius = CORNER_RADIUS * n
  const scale = REFERENCE / n

  for (let py = 0; py < n; py += 1) {
    for (let px = 0; px < n; px += 1) {
      const u = (px + 0.5) / n
      const v = (py + 0.5) / n

      // Distance inside the shape, in reference pixels.
      const d = -roundedRectDistance(u * n, v * n, n / 2, n / 2, radius)
      const distFromEdge = Math.max(d, 0) * scale

      const edgeFalloff = Math.exp(-distFromEdge * controls.edgeDistance)
      const rimFalloff = Math.exp(-distFromEdge * controls.rimDistance)
      const baseFalloff = 1 - Math.exp(-distFromEdge * controls.baseDistance)

      // The base term rides on the shader's centre warp, which is off.
      const base = 0
      let total = base + edgeFalloff * controls.edgeIntensity + rimFalloff * controls.rimIntensity

      const cornerProximityX = Math.min(u, 1 - u)
      const cornerProximityY = Math.min(v, 1 - v)
      const cornerNormalized = Math.max(cornerProximityX, cornerProximityY) * REFERENCE
      total += Math.exp(-cornerNormalized * 0.3) * controls.cornerBoost

      // The ripple runs perpendicular to the normal, so it shears the backdrop
      // along the edge rather than pushing it outward. Its sine is taken over the
      // distance measured in reference surfaces, which is the shader's own
      // normalisation (it divides by the smaller resolution axis). Inert at the
      // shipped rimIntensity of 0, kept so the control stays live.
      const ripple =
        Math.sin((distFromEdge / REFERENCE) * 25) * controls.rippleEffect * rimFalloff

      // Radial shape normal, as the shader computes it. Undefined at the exact
      // centre, where the intensity is zero anyway, so it is left at zero there.
      const nx = u - 0.5
      const ny = v - 0.5
      const len = Math.hypot(nx, ny)
      const sx = len > 0 ? nx / len : 0
      const sy = len > 0 ? ny / len : 0

      const dx = (sx * total - sy * ripple) * AMPLITUDE
      const dy = (sy * total + sx * ripple) * AMPLITUDE

      const i = (py * n + px) * 4
      data[i] = Math.round(Math.min(1, Math.max(0, 0.5 + dx)) * 255)
      data[i + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + dy)) * 255)
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  return data
}

/**
 * Encode the normal map as a PNG data URI, memoised.
 *
 * PNG rather than an inline SVG because the field is computed per pixel and SVG
 * cannot express it declaratively; a data URI keeps the filter self-contained
 * with no request to make and nothing to cache-bust. The map is identical for
 * every surface, so it is built once.
 */
let cachedMapUri: string | null = null

export function liquidGlassNormalMapUri(
  controls: LiquidGlassControls = LIQUID_GLASS_CONTROLS,
): string {
  if (cachedMapUri) return cachedMapUri
  const canvas = document.createElement('canvas')
  canvas.width = MAP_SIZE
  canvas.height = MAP_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.putImageData(new ImageData(buildNormalMap(controls), MAP_SIZE, MAP_SIZE), 0, 0)
  cachedMapUri = canvas.toDataURL('image/png')
  return cachedMapUri
}
