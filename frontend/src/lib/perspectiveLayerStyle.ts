import type { CSSProperties } from 'react'

export function getPerspectiveLayerStyle(index: number, total: number, intensity: number, minimumCardWidth: number): CSSProperties {
  const frontness = total <= 1 ? 1 : index / (total - 1)
  const clampedIntensity = Math.max(0, Math.min(1.5, intensity))

  const motionX = clampedIntensity * (2 + frontness * 11)
  const motionY = clampedIntensity * (2 + frontness * 11)
  const motionDepth = clampedIntensity * (-1 + frontness * 4)
  const tiltAmount = clampedIntensity * (0.15 + frontness * 0.85)
  const originDepth = -12 + frontness * 58
  const hoverDepthTarget = clampedIntensity * (1 + frontness * 18)

  // CSS reserves 8% on each horizontal edge and 12% vertically, leaving room
  // below bottom-anchored artwork when the phone tilts towards the viewer.
  // Use the smaller horizontal reserve for this conservative coverage bound.
  const halfCard = minimumCardWidth / 2
  const halfDiagonal = halfCard * Math.sqrt(2)
  const maxTranslate = Math.hypot(motionX, motionY)
  const maxRotationOffset = (Math.abs(tiltAmount) * Math.PI / 180) * halfDiagonal
  const requiredOverscan = (maxTranslate + maxRotationOffset) / halfCard
  const functionalScale = (1 + requiredOverscan) / 1.16
  const baseScale = 1.015
  const activeScale = Math.max(baseScale, Math.min(1.18, functionalScale))

  return {
    '--layer-origin-depth': `${originDepth}px`,
    // Keep the base separate: an inline --layer-scale would override the CSS
    // that activates the coverage scale for hover and device motion.
    '--layer-base-scale': baseScale.toFixed(3),
    '--layer-hover-depth-target': `${hoverDepthTarget}px`,
    '--layer-hover-scale': activeScale.toFixed(3),
    '--layer-motion-x': `${motionX}px`,
    '--layer-motion-y': `${motionY}px`,
    '--layer-motion-depth': `${motionDepth}px`,
    '--layer-tilt-amount': `${tiltAmount}deg`,
    '--layer-tilt-amount-neg': `${-tiltAmount}deg`,
  } as CSSProperties
}
