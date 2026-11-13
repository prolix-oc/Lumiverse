import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { activeDeviceThemeControls, resolveDeviceTheme, useDeviceThemeControls } from '@/lib/deviceThemeControls'
import { isLiquidGlassActive, liquidGlassNormalMapUri, LENS_SCALE } from '@/lib/liquidGlass'

/**
 * SVG filter definitions for the liquid-glass material.
 *
 * The filter is inlined once for the whole document and referenced by id from
 * CSS, because CSS has no way to declare `feDisplacementMap`.
 *
 * The normal map is generated rather than declared: it is the coverage field of
 * `dashersw/liquid-glass-js`, evaluated in JavaScript and encoded as a PNG data
 * URI. It has to be an image because an SVG filter used as a `backdrop-filter`
 * has no `SourceAlpha` to differentiate — the backdrop is not an element, so
 * there is no shape to take a gradient of. `feImage` is the one shape input such
 * a filter does honour, and `feDisplacementMap` then refracts the backdrop
 * through whatever it supplies.
 *
 * The filter is applied by CSS as `backdrop-filter`, never as `filter`: only
 * `backdrop-filter` reaches what is behind an element, and `filter` would
 * displace the surface's own text instead.
 *
 * Rendered only while the effect is active, so the chain costs nothing when the
 * user has not opted in. `url(#…)` on a missing id is a no-op, so the markup is
 * safe to unmount at any time.
 */
export default function LiquidGlassFilters() {
  const theme = useStore((s) => s.theme)
  const deviceControls = useDeviceThemeControls(activeDeviceThemeControls)
  const config = resolveDeviceTheme(theme, deviceControls)
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  if (!isLiquidGlassActive(config, reducedMotion)) return null

  const normalMap = liquidGlassNormalMapUri()
  if (!normalMap) return null

  return (
    <svg className="lumiverse-liquid-glass-defs" aria-hidden="true" focusable="false">
      <defs>
        {/* The region is the element itself, and `objectBoundingBox` primitives
            make the map fill it.

            Both parts are load-bearing. `backdrop-filter` is clipped to the
            element's border box, so a region larger than the element is
            discarded. And `feImage` resolves percentages against the *viewport*,
            not the element: with the default user-space units a `100%` image is
            viewport-sized, so every surface shows whichever slice of the map it
            happens to sit on and only elements at the viewport edge get a rim.
            `primitiveUnits="objectBoundingBox"` makes the image exactly 1x1 of
            the element, so the lens lands on the surface wherever it is.

            The PNG encodes displacement in sRGB. The default linearRGB turns
            neutral 128 into ~0.216, translating even the flat map interior. */}
        <filter
          id="liquid-glass-lens"
          x="0"
          y="0"
          width="100%"
          height="100%"
          primitiveUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feImage
            x="0"
            y="0"
            width="1"
            height="1"
            preserveAspectRatio="none"
            result="normalMap"
            href={normalMap}
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="normalMap"
            scale={LENS_SCALE}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  )
}
