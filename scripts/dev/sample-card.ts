#!/usr/bin/env bun
/**
 * Sampler harness: runs the real extractPalette pipeline against local PNGs
 * using sharp instead of a browser canvas. Reports the derived palette, UI
 * schemes, swatches, ambient gradient, and the character-aware overlay so we
 * can see exactly what each card would produce in the app.
 *
 * Usage:
 *   bun scripts/dev/sample-card.ts ~/Downloads/test-1.png [more...]
 */

import sharp from 'sharp'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  extractColorsFromRawPixels,
  deriveCharacterOverlay,
  deriveCharacterNameVars,
  rgbToHsl,
  contrastRatio,
  type RGB,
  type ColorExtractionData,
} from '../../src/utils/color-engine'

const SAMPLE_SIZE = 64

function rgb(c: RGB) { return `rgb(${c.r},${c.g},${c.b})` }
function hex(c: RGB) { return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` }
function hsl(c: RGB) { const h = rgbToHsl(c.r, c.g, c.b); return `hsl(${h.h},${h.s}%,${h.l}%)` }
function describe(c: RGB) { return `${hex(c).padEnd(8)} ${hsl(c).padEnd(20)} ${rgb(c).padEnd(18)} lum=${(c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722).toFixed(0).padStart(3)}` }

async function extractPalette(src: string): Promise<ColorExtractionData> {
  const raw = await sharp(src).resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'cover' }).ensureAlpha().raw().toBuffer()
  const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
  return extractColorsFromRawPixels(data, SAMPLE_SIZE, SAMPLE_SIZE, 4)
}

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

  console.log(`\n  swatches:`)
  for (const [name, swatch] of Object.entries(p.swatches)) {
    if (swatch) console.log(`    ${name.padEnd(14)} ${describe(swatch.color)} pop=${swatch.population}`)
    else console.log(`    ${name.padEnd(14)} —`)
  }

  console.log(`\n  ambient:`)
  console.log(`    dark  ${describe(p.ambient.dark)}`)
  console.log(`    light ${describe(p.ambient.light)}`)

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

  const nameVars = deriveCharacterNameVars(p.palette, p.dominant, p.regions, p.flatness, p.average)
  console.log(`\n  characterName vars:`)
  console.log(`    --char-name-dark: ${nameVars.dark}`)
  console.log(`    --char-name-light: ${nameVars.light}`)

  const overlay = deriveCharacterOverlay(p.palette, p.ui)
  console.log(`\n  characterOverlay (applied on top of user theme):`)
  console.log(`    accent hsl       h=${overlay.accent.h} s=${overlay.accent.s} l=${overlay.accent.l}`)
  console.log(`    dark.primary     ${describe(overlayToRgb(overlay.baseColors.primary))}`)
  console.log(`    dark.secondary   ${describe(overlayToRgb(overlay.baseColors.secondary))}`)
  console.log(`    dark.background  ${describe(overlayToRgb(overlay.baseColors.background))}`)
  console.log(`    dark.text        ${describe(overlayToRgb(overlay.baseColors.text))}   contrast vs bg = ${contrastRatio(overlayToRgb(overlay.baseColors.text), overlayToRgb(overlay.baseColors.background)).toFixed(2)}`)
  console.log(`    light.primary    ${describe(overlayToRgb(overlay.baseColorsLight.primary))}`)
  console.log(`    light.secondary  ${describe(overlayToRgb(overlay.baseColorsLight.secondary))}`)
  console.log(`    light.background ${describe(overlayToRgb(overlay.baseColorsLight.background))}`)
  console.log(`    light.text       ${describe(overlayToRgb(overlay.baseColorsLight.text))}   contrast vs bg = ${contrastRatio(overlayToRgb(overlay.baseColorsLight.text), overlayToRgb(overlay.baseColorsLight.background)).toFixed(2)}`)
}

function overlayToRgb(css: string): RGB {
  const m = css.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
  if (!m) return { r: 128, g: 128, b: 128 }
  return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) }
}

const argv = process.argv.slice(2)
const inputs = (argv.length ? argv : ['~/Downloads/test-1.png', '~/Downloads/test-2.png', '~/Downloads/test-3.png'])
  .map((p) => p.startsWith('~') ? resolve(homedir(), p.slice(2)) : resolve(p))

for (const path of inputs) {
  await reportImage(path)
}
