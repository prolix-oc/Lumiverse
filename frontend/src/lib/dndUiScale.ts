import { CSS, type Transform } from '@dnd-kit/utilities'

/**
 * Build a `translate3d` string from a `useSortable` transform, compensating for
 * the CSS `zoom: var(--lumiverse-ui-scale)` applied to `body > *` (see
 * theme/reset.css). Pointer events come in at post-zoom (rendered) pixels but
 * CSS transforms on a zoomed element are applied in pre-zoom (layout) space,
 * so without dividing by the scale the dragged card moves faster than the
 * cursor at UI scales > 1 and drifts behind at scales < 1.
 */
export function uiScaledTransform(transform: Transform | null): string | undefined {
  if (!transform) return CSS.Transform.toString(transform)
  const uiScale = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
  ) || 1
  if (uiScale === 1) return CSS.Transform.toString(transform)
  return CSS.Transform.toString({
    ...transform,
    x: transform.x / uiScale,
    y: transform.y / uiScale,
  })
}
