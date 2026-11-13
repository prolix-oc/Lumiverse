import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the universal-refraction sweep.
 *
 * Every frosted surface in the app carries `var(--lcs-liquid-filter, )` at the
 * end of its `backdrop-filter`, and one rule inside the `@supports` probe fills
 * that token with the displacement filter. Three things have to stay true or
 * the feature breaks silently:
 *
 *  1. The token must never be given a value outside the probe. An *undefined*
 *     custom property inside `backdrop-filter` invalidates the whole
 *     declaration, so on an engine that cannot displace a backdrop the surface
 *     would lose its blur along with the refraction.
 *  2. Every blurred declaration must carry the token, or that surface stays
 *     un-refracted — invisible in review.
 *  3. No declaration may carry it twice, which would stack two displacement
 *     passes on one element.
 *  4. The SVG defs host must keep a real box. Chromium clips a filter's output
 *     to its host viewport, so collapsing the host to 0x0 makes `feImage`
 *     produce nothing and turns the displacement into a uniform translation of
 *     the entire backdrop — the "everything is shifted" artefact. See the
 *     host-box test below.
 */

const themeDir = import.meta.dir
const srcDir = join(themeDir, '..')

const read = (rel: string) => readFileSync(join(srcDir, rel), 'utf8').replace(/\r\n/g, '\n')

/** Every `.css` module under `src`, excluding the reserved theme files. */
function allModuleCss(): { path: string; css: string }[] {
  const glob = new Bun.Glob('**/*.module.css')
  return [...glob.scanSync({ cwd: srcDir })]
    .sort()
    .map((rel) => ({ path: rel, css: read(rel) }))
}

describe('liquid glass refraction sweep', () => {
  test('does not declare the refraction token in variables.css', () => {
    // It must be filled only by the guarded rule in global.css: a value set
    // here (or in the ungated `html[data-liquid-glass]` rule) would reach
    // engines that cannot displace a backdrop and drop their whole
    // `backdrop-filter` declaration.
    const vars = read('theme/variables.css')
    expect(vars).not.toMatch(/--lcs-liquid-filter\s*:/)
  })

  test('appends the token to every blurred backdrop-filter', () => {
    const missing: string[] = []
    for (const { path, css } of allModuleCss()) {
      // Only the unprefixed property matters for the value; the -webkit- twin
      // is written by hand alongside it and carries the token too.
      const decls = css.match(/^\s*backdrop-filter:\s*[^;]+;/gm) ?? []
      for (const decl of decls) {
        const value = decl.replace(/^\s*backdrop-filter:\s*/, '').replace(/;\s*$/, '')
        if (/\bnone\b/.test(value)) continue
        if (!value.includes('blur(')) continue
        // Slider thumbs paint a dedicated lens instead of the shared one.
        if (value.includes('--lcs-liquid-thumb-blur')) continue
        if (!value.includes('var(--lcs-liquid-filter, )')) {
          missing.push(`${path}: ${value}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('fills the token only inside the @supports probe, so unsupported engines keep their blur', () => {
    const css = read('theme/global.css')
    const start = css.indexOf('@supports (backdrop-filter: url(#liquid-glass-lens))')
    expect(start).toBeGreaterThanOrEqual(0)

    // The ungated `html[data-liquid-glass]` rule may only carry the lens.
    const ungated = css.indexOf('html[data-liquid-glass] {')
    const ungatedBody = css.slice(ungated, css.indexOf('}', ungated))
    expect(ungatedBody).not.toContain('--lcs-liquid-filter')

    const fill = css.indexOf('--lcs-liquid-filter: url(#liquid-glass-lens)')
    expect(fill).toBeGreaterThan(start)

    // The fill must be within the probe's block: find the matching brace.
    const open = css.indexOf('{', start)
    let depth = 0
    let close = -1
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      if (css[i] === '}') {
        depth -= 1
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    expect(close).toBeGreaterThan(fill)
  })

  test('never stacks two displacement passes on one surface', () => {
    const doubled: string[] = []
    for (const { path, css } of allModuleCss()) {
      const decls = css.match(/^\s*backdrop-filter:\s*[^;]+;/gm) ?? []
      for (const decl of decls) {
        const uses = (decl.match(/var\(--lcs-liquid-filter, \)/g) ?? []).length
        if (uses > 1) doubled.push(`${path}: ${decl.trim()}`)
      }
    }
    expect(doubled).toEqual([])
  })

  test('gives the SVG defs host a real box, so feImage is not clipped away', () => {
    const css = read('theme/global.css')
    const rule = css.match(/\.lumiverse-liquid-glass-defs\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const body = rule![1]
    // A zero-sized host is the failure mode: the browser clips the filter's
    // output to it and the normal map comes back empty.
    expect(body).not.toMatch(/width:\s*0(px)?\s*;/)
    expect(body).not.toMatch(/height:\s*0(px)?\s*;/)
    expect(body).toMatch(/position:\s*fixed/)
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/height:\s*100%/)
    // It must never intercept pointer events.
    expect(body).toMatch(/pointer-events:\s*none/)
  })

  test('sizes the filter region to the element, and fills it in bounding-box units', () => {
    // Two things keep the map on the surface. `backdrop-filter` is clipped to
    // the element, so a region wider than the element is discarded. And
    // `feImage` resolves percentages against the viewport under the default
    // user-space units, so a `100%` image would be viewport-sized and each
    // surface would show only the slice it sits on — `primitiveUnits`
    // objectBoundingBox with a 1x1 image is what pins the map to the element.
    const tsx = readFileSync(join(srcDir, 'components/shared/LiquidGlassFilters.tsx'), 'utf8')
    expect(tsx).toMatch(/id="liquid-glass-lens"/)
    expect(tsx).toMatch(/x="0"\s+y="0"\s+width="100%"\s+height="100%"/)
    expect(tsx).toMatch(/primitiveUnits="objectBoundingBox"/)
    expect(tsx).toMatch(/width="1"\s+height="1"/)
    expect(tsx).not.toMatch(/x="-25%"/)
  })
})
