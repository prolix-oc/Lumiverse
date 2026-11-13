import { describe, expect, test } from 'bun:test'
import {
  isLiquidGlassActive,
  buildNormalMap,
  LIQUID_GLASS_CONTROLS,
  LENS_SCALE,
  REFERENCE,
} from './liquidGlass'
import type { ThemeConfig } from '@/types/theme'

const base: Pick<ThemeConfig, 'enableGlass' | 'liquidGlass' | 'renderingMode'> = {
  enableGlass: true,
  liquidGlass: true,
  renderingMode: 'balanced',
}

describe('isLiquidGlassActive', () => {
  test('activates only when the opt-in flag is set', () => {
    expect(isLiquidGlassActive(base, false)).toBe(true)
    expect(isLiquidGlassActive({ ...base, liquidGlass: false }, false)).toBe(false)
    expect(isLiquidGlassActive({ ...base, liquidGlass: undefined }, false)).toBe(false)
  })

  test('never activates without the frosted glass layer it refracts', () => {
    expect(isLiquidGlassActive({ ...base, enableGlass: false }, false)).toBe(false)
  })

  test('stands down in efficiency mode, which strips backdrop filters', () => {
    expect(isLiquidGlassActive({ ...base, renderingMode: 'efficiency' }, false)).toBe(false)
    expect(isLiquidGlassActive({ ...base, renderingMode: 'quality' }, false)).toBe(true)
    expect(isLiquidGlassActive({ ...base, renderingMode: undefined }, false)).toBe(true)
  })

  test('honours the reduced-motion preference', () => {
    expect(isLiquidGlassActive(base, true)).toBe(false)
  })

  test('treats a missing theme as inactive', () => {
    expect(isLiquidGlassActive(null, false)).toBe(false)
    expect(isLiquidGlassActive(undefined, false)).toBe(false)
  })
})

/**
 * The normal map is what `feDisplacementMap` reads, so its shape is the whole
 * material: near-neutral through the middle, leaning outward at the rim, and
 * stronger at a corner than along a straight edge. The assertions pin those
 * properties rather than exact pixels, so the field can be retuned without
 * rewriting the test.
 */
describe('buildNormalMap', () => {
  const SIZE = 192
  const at = (map: Uint8ClampedArray, x: number, y: number) => ({
    dx: map[(y * SIZE + x) * 4] / 255 - 0.5,
    dy: map[(y * SIZE + x) * 4 + 1] / 255 - 0.5,
  })

  test('is fully opaque so feDisplacementMap reads the whole surface', () => {
    const map = buildNormalMap(LIQUID_GLASS_CONTROLS)
    for (let i = 3; i < map.length; i += 4) expect(map[i]).toBe(255)
  })

  test('is near-neutral through the middle of the surface', () => {
    const map = buildNormalMap(LIQUID_GLASS_CONTROLS)
    // The shader's displacement is radial, so the middle of a wide surface sits
    // close to the neutral: only the vertical component is non-zero there, and
    // the edge falloff has already decayed.
    const { dx } = at(map, SIZE / 2, SIZE / 2)
    expect(Math.abs(dx)).toBeLessThan(0.01)
  })

  test('leans outward on both sides of the surface', () => {
    const map = buildNormalMap(LIQUID_GLASS_CONTROLS)
    const y = SIZE / 2
    // Left half pushes left, right half pushes right. A field that only leaned
    // one way would drag the backdrop instead of refracting it.
    expect(at(map, 4, y).dx).toBeLessThan(-0.02)
    expect(at(map, SIZE - 5, y).dx).toBeGreaterThan(0.02)
  })

  test('leans outward top and bottom too', () => {
    const map = buildNormalMap(LIQUID_GLASS_CONTROLS)
    const x = SIZE / 2
    expect(at(map, x, 4).dy).toBeLessThan(-0.02)
    expect(at(map, x, SIZE - 5).dy).toBeGreaterThan(0.02)
  })

  test('boosts corners above the straight edges', () => {
    const map = buildNormalMap(LIQUID_GLASS_CONTROLS)
    const edge = Math.hypot(at(map, 4, SIZE / 2).dx, at(map, 4, SIZE / 2).dy)
    const corner = Math.hypot(at(map, 6, 6).dx, at(map, 6, 6).dy)
    expect(corner).toBeGreaterThan(edge)
  })

  test('honours the edge distance control', () => {
    const wide = buildNormalMap({ ...LIQUID_GLASS_CONTROLS, edgeDistance: 0.05 })
    const narrow = buildNormalMap({ ...LIQUID_GLASS_CONTROLS, edgeDistance: 0.5 })
    // A larger distance decays faster, so the field is spent closer to the rim.
    // Sampled inside the bevel: further in, the field has decayed below one
    // 8-bit level and the two distances quantise to the same value.
    const wideInner = Math.abs(at(wide, 10, SIZE / 2).dx)
    const narrowInner = Math.abs(at(narrow, 10, SIZE / 2).dx)
    expect(narrowInner).toBeLessThan(wideInner)
  })

  test('honours the corner boost control', () => {
    const none = buildNormalMap({ ...LIQUID_GLASS_CONTROLS, cornerBoost: 0 })
    const some = buildNormalMap({ ...LIQUID_GLASS_CONTROLS, cornerBoost: 0.1 })
    expect(Math.hypot(at(some, 6, 6).dx, at(some, 6, 6).dy)).toBeGreaterThan(
      Math.hypot(at(none, 6, 6).dx, at(none, 6, 6).dy),
    )
  })

  test('honours the rim intensity control, which is zero when shipped', () => {
    const off = buildNormalMap(LIQUID_GLASS_CONTROLS)
    const on = buildNormalMap({ ...LIQUID_GLASS_CONTROLS, rimIntensity: 0.2 })
    expect(Math.abs(at(on, 4, SIZE / 2).dx)).toBeGreaterThan(
      Math.abs(at(off, 4, SIZE / 2).dx),
    )
  })

  test('renders the bevel the shader\'s own maths gives', () => {
    // The library displaces in texture coordinates, so a weight of `w` moves the
    // backdrop `w * size` pixels. `LENS_SCALE` is a fraction of the element (the
    // filter uses objectBoundingBox units), so the rendered shift is
    // `dx * LENS_SCALE * elementWidth`; at the reference width that is
    // `EDGE_INTENSITY * REFERENCE`, as the library gives.
    const map = buildNormalMap(LIQUID_GLASS_CONTROLS)
    const rimPx = Math.abs(at(map, 4, SIZE / 2).dx) * LENS_SCALE * REFERENCE
    const expected = LIQUID_GLASS_CONTROLS.edgeIntensity * REFERENCE
    expect(rimPx).toBeGreaterThan(expected * 0.6)
    expect(rimPx).toBeLessThan(expected * 1.2)
  })
})
