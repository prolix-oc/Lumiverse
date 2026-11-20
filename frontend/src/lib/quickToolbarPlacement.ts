/**
 * Placement maths for the quick toolbar's customizer popover.
 *
 * Kept free of React and store imports so it can be unit-tested without a DOM.
 */

export const CUSTOMIZER_WIDTH = 236
/** Gap the caret bridges, so the popover reads as attached to the toolbar. */
export const CUSTOMIZER_GAP = 7
export const CUSTOMIZER_VIEWPORT_MARGIN = 10
const MIN_CUSTOMIZER_HEIGHT = 220

export interface CustomizerAnchor {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface CustomizerPlacement {
  left: number
  top: number
  maxHeight: number
  side: 'below' | 'above' | 'right' | 'left'
  caret: number
}

/**
 * Places the popover flush against the *rendered* toolbar box.
 *
 * It used to be absolutely positioned at `left: 100%` of the toolbar's persisted
 * rectangle, which is wider than the toolbar itself and centres it — hence the
 * dead gap between the two.
 *
 * Every input and every output is in *rendered* (post-zoom) pixels. Callers that
 * write the result back as inline CSS must divide by `--lumiverse-ui-scale`,
 * because `body > *` carries that zoom and CSS offsets there are resolved in
 * pre-zoom layout space. See `SearchableSelect.tsx` for the same compensation.
 */
export function placeCustomizer(
  anchor: CustomizerAnchor,
  vertical: boolean,
  viewport: { width: number; height: number },
  renderedWidth: number = CUSTOMIZER_WIDTH,
): CustomizerPlacement {
  const margin = CUSTOMIZER_VIEWPORT_MARGIN
  const width = renderedWidth
  const maxLeft = Math.max(margin, viewport.width - width - margin)

  if (vertical) {
    const fitsRight = anchor.right + CUSTOMIZER_GAP + width <= viewport.width - margin
    const left = Math.min(
      Math.max(margin, fitsRight ? anchor.right + CUSTOMIZER_GAP : anchor.left - CUSTOMIZER_GAP - width),
      maxLeft,
    )
    const height = Math.min(MIN_CUSTOMIZER_HEIGHT, Math.max(0, viewport.height - margin * 2))
    const top = Math.min(Math.max(margin, anchor.top), Math.max(margin, viewport.height - height - margin))
    const maxHeight = Math.max(0, Math.min(viewport.height - margin * 2, viewport.height - top - margin))
    return {
      left,
      top,
      maxHeight,
      side: fitsRight ? 'right' : 'left',
      // Clamped to the box, or the caret detaches below the popover once the
      // `top` clamp has pushed it away from the toolbar's vertical centre.
      caret: Math.max(14, Math.min(anchor.top + anchor.height / 2 - top, Math.max(14, maxHeight - 14))),
    }
  }

  const spaceBelow = viewport.height - anchor.bottom - CUSTOMIZER_GAP - margin
  const spaceAbove = anchor.top - CUSTOMIZER_GAP - margin
  const below = spaceBelow >= MIN_CUSTOMIZER_HEIGHT || spaceBelow >= spaceAbove
  const preferredHeight = Math.max(MIN_CUSTOMIZER_HEIGHT, below ? spaceBelow : spaceAbove)
  const preferredTop = below
    ? anchor.bottom + CUSTOMIZER_GAP
    : Math.max(margin, anchor.top - CUSTOMIZER_GAP - preferredHeight)

  // On a short viewport neither side can hold the minimum height, and the floor
  // would otherwise push the bottom of the popover — including its reset button —
  // off-screen with no way to scroll it back. Give up the floor before the fold:
  // overlapping the toolbar is recoverable, being off-screen is not.
  const height = Math.min(preferredHeight, Math.max(0, viewport.height - margin * 2))
  const top = Math.max(margin, Math.min(preferredTop, viewport.height - margin - height))
  const left = Math.min(
    Math.max(margin, anchor.left + anchor.width / 2 - width / 2),
    maxLeft,
  )
  return {
    left,
    top,
    maxHeight: Math.max(0, Math.min(height, viewport.height - top - margin)),
    side: below ? 'below' : 'above',
    caret: Math.max(14, Math.min(anchor.left + anchor.width / 2 - left, Math.max(14, width - 14))),
  }
}

/**
 * Reads the `body > *` zoom factor that portaled inline offsets must be divided by.
 *
 * Re-exported, not redefined: `lib/uiScale.ts` is the single implementation. This
 * alias exists because `QuickToolbar.tsx` imports it from here and
 * `tests/quick-toolbar.test.ts` pins that import path. New consumers — anything
 * outside the quick toolbar — should import from `@/lib/uiScale` directly.
 */
export { readUiScale } from './uiScale'
