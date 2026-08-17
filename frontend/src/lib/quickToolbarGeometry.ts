/**
 * Geometry for the quick toolbar's persisted rectangle.
 *
 * React-free, store-free and DOM-free on purpose so it unit-tests under a
 * headless `bun test` — importing component files crashes on `window is not
 * defined`. It also declares its own narrow input types rather than importing
 * `@/types/store`, so the settings shape can evolve independently. The shapes
 * are structurally identical to `SurfaceRectPrefs`, so values flow both ways
 * without a cast.
 *
 * The central rule: **the natural size is measured, never derived.** An earlier
 * design computed it from `iconSize + 14`, which is `.item`'s `min-width` and
 * not its width; labels are text up to `max-width: 88px`, and `box-sizing:
 * border-box` plus a 1px border costs another 2px per axis. Any formula
 * under-measures a labelled toolbar by roughly 2.5x. The component measures the
 * nav at runtime and passes the result in as `natural`.
 */

export interface SurfaceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface ToolbarRectBounds {
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
}

export type ToolbarRectOrientation = 'horizontal' | 'vertical'

/**
 * The persisted geometry a free-floating toolbar reads: **one shared position,
 * one box per orientation.**
 *
 * A single shared rect cannot work. `clampSurfaceRect` raises the new
 * orientation's main axis to its measured minimum on a flip but never lowers
 * the stale cross axis, so the rendered box becomes the *union* of both
 * orientations' boxes — a horizontal toolbar pinned to 560x46 flipped to
 * vertical and rendered 560x500.
 *
 * `x`/`y` stay shared and live on `rect` alone: flipping orientation must move
 * nothing. `rect` therefore means "the shared position, plus the *horizontal*
 * extents"; `verticalSize` holds the vertical orientation's extents and has no
 * position of its own, so the two can never disagree about where the toolbar is.
 *
 * Structurally a subset of `QuickToolbarSettings`, so store values flow in
 * without a cast while this module stays store-free.
 */
export interface ToolbarRectPrefs {
  rect: SurfaceRect
  verticalSize: Size
}

/** What the writers return: a patch for `updateSettings`, never a whole row. */
export interface ToolbarRectPatch {
  rect: SurfaceRect
  verticalSize?: Size
}

/**
 * `rect`'s schema version. Bumped to 3 for per-orientation sizes: rows that a
 * resize drag flattened under the shared-rect bug are byte-indistinguishable
 * from deliberately chosen ones, so both are re-auto'd. See
 * `repairToolbarRects`.
 */
export const TOOLBAR_RECT_VERSION = 3

/** The auto sentinel as a size — "measure me", on both axes. */
export const AUTO_TOOLBAR_SIZE: Size = { width: 0, height: 0 }

/** Upper bound on a user-dragged toolbar box, in rendered pixels. */
export const TOOLBAR_MAX: Size = { width: 920, height: 640 }

/**
 * Edge-snap distance. Mirrors the literal `24` in `usePersistentRect.ts`'s
 * commit path; exported so callers and tests share one number.
 */
export const TOOLBAR_SNAP_THRESHOLD = 24

/** Floor for a visible floating toolbar. Matches the V2 card `min-height: 32px`. */
export const TOOLBAR_VISIBLE_MIN_HEIGHT = 32

/** A finite, non-negative reading of an axis; anything else means "unknown". */
function axis(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function visibleHeightFloor(value?: number): number {
  return Math.max(TOOLBAR_VISIBLE_MIN_HEIGHT, axis(value ?? 0))
}

/**
 * The auto sentinel: a non-positive extent on either axis means "size me from
 * my content". Non-finite values (a corrupted or hand-edited settings row)
 * count as auto too, because the alternative is an `NaN` width reaching CSS.
 */
export function isAutoRect(rect: SurfaceRect): boolean {
  return axis(rect.width) === 0 || axis(rect.height) === 0
}

/**
 * Substitutes the measured natural size on whichever axes are auto. Each axis
 * is decided independently, so a half-pinned rect (dragged wide, auto height)
 * keeps the width the user chose. An explicit rect passes through untouched.
 *
 * Height never resolves to 0 for a painted floating box: a wiped auto sentinel
 * plus an unmeasured `natural` would otherwise become `--quick-toolbar-height:
 * 0px`. When `natural.height` is known it is the hug size; `minHeight` is only
 * the unmeasured fallback and must not raise a measured row (no 32+18 chrome).
 */
export function resolveToolbarRect(
  rect: SurfaceRect,
  natural: Size,
  minHeight: number = TOOLBAR_VISIBLE_MIN_HEIGHT,
): SurfaceRect {
  const width = axis(rect.width) || axis(natural.width)
  const height = axis(rect.height) || axis(natural.height) || visibleHeightFloor(minHeight)
  return { x: rect.x, y: rect.y, width, height }
}

/**
 * The box the given orientation owns: the shared `x`/`y` from `rect`, and the
 * extents that orientation last had.
 *
 * The position is read from `rect` unconditionally — `verticalSize` carries no
 * position, which is what makes "flipping never teleports the toolbar" a
 * property of the shape rather than of a synchronisation rule someone has to
 * remember. The extents pass through untouched, so the auto sentinel (a
 * non-positive width/height) still means auto, independently per orientation.
 */
export function selectToolbarRect(
  prefs: ToolbarRectPrefs,
  orientation: ToolbarRectOrientation,
): SurfaceRect {
  const { x, y } = prefs.rect
  if (orientation !== 'vertical') {
    return { x, y, width: prefs.rect.width, height: prefs.rect.height }
  }
  // `?? AUTO_TOOLBAR_SIZE` is not dead: an imported or hand-edited row can be
  // missing the key, and an `undefined.width` here would white-screen the app.
  const size = prefs.verticalSize ?? AUTO_TOOLBAR_SIZE
  return { x, y, width: size.width, height: size.height }
}

/**
 * Pins a size for `orientation` — a resize drag — while moving the shared
 * position. The *other* orientation's extents are deliberately absent from the
 * patch, so they survive untouched.
 */
export function withToolbarRect(
  prefs: ToolbarRectPrefs,
  orientation: ToolbarRectOrientation,
  next: SurfaceRect,
): ToolbarRectPatch {
  if (orientation === 'vertical') {
    return {
      rect: { ...prefs.rect, x: next.x, y: next.y },
      verticalSize: { width: next.width, height: next.height },
    }
  }
  return { rect: { x: next.x, y: next.y, width: next.width, height: next.height } }
}

/**
 * Moves the toolbar without pinning anything. Both orientations keep whatever
 * they had — including the auto sentinel, so auto-fit survives a move drag and
 * the window-resize commits `usePersistentRect` fires on its own.
 */
export function withToolbarPosition(
  prefs: ToolbarRectPrefs,
  position: { x: number; y: number },
): ToolbarRectPatch {
  return { rect: { ...prefs.rect, x: position.x, y: position.y } }
}

/**
 * Bounds for `usePersistentRect`: the toolbar may never be dragged smaller than
 * its own content, nor larger than `TOOLBAR_MAX`.
 *
 * The max is raised to the min when a huge `natural` would otherwise exceed it.
 * An inverted clamp corrupts `clampSurfaceRect` (`usePersistentRect.ts:38`),
 * whose `Math.min(Math.max(w, minWidth), maxWidth)` silently returns `maxWidth`
 * — i.e. a toolbar narrower than its own buttons — when `maxWidth < minWidth`.
 *
 * `minHeight` is the measured icon row when `natural.height` is known, so N/S
 * shrink can reach hug. An unmeasured natural used to publish `{ minHeight: 0 }`,
 * which made a 0-height box legal in `clampSurfaceRect`; only then does the
 * fallback floor apply.
 */
export function toolbarRectBounds(
  natural: Size,
  minHeightFloor: number = TOOLBAR_VISIBLE_MIN_HEIGHT,
): ToolbarRectBounds {
  const minWidth = axis(natural.width)
  const minHeight = axis(natural.height) || visibleHeightFloor(minHeightFloor)
  return {
    minWidth,
    minHeight,
    maxWidth: Math.max(TOOLBAR_MAX.width, minWidth),
    maxHeight: Math.max(TOOLBAR_MAX.height, minHeight),
  }
}

/**
 * Rewrites a persisted rect to the auto sentinel while preserving the position
 * the user may have dragged the toolbar to. Used by the `rectVersion`
 * migration and by "reset current variant".
 */
export function migrateToolbarRect(rect: SurfaceRect): SurfaceRect {
  return { x: rect.x, y: rect.y, width: 0, height: 0 }
}

/**
 * The `rectVersion` repair, as a pure function so `loadSettings`' one-shot
 * migration is actually unit-testable.
 *
 * Returns the input **by identity** when the row is already at
 * `TOOLBAR_RECT_VERSION`, which is how the caller decides whether to write:
 * `if (next !== qt)`. So it fires exactly once per row and is idempotent, and a
 * first-time visitor — who has no stored row at all, so the caller never calls
 * this — triggers no write.
 *
 * Version 3 re-autos **both** orientations. Known and accepted cost: a row
 * flattened by a resize drag under the shared-rect bug is byte-identical to a
 * size someone deliberately pinned, so a user who chose a size loses it once,
 * on one load, and gets auto-fit back. That is strictly better than leaving a
 * silently-wrong box that only a re-drag can clear. `verticalSize` is reset too
 * even though the key is new to this version: it costs nothing for a real
 * upgrade (the merge already backfills the sentinel) and keeps the repair
 * honestly meaning "reset every orientation" for any future bump.
 */
export function repairToolbarRects<
  T extends { rectVersion?: number; rect?: SurfaceRect; verticalSize?: Size },
>(settings: T, defaults: ToolbarRectPrefs): T {
  if (settings.rectVersion === TOOLBAR_RECT_VERSION) return settings
  return {
    ...settings,
    rectVersion: TOOLBAR_RECT_VERSION,
    rect: migrateToolbarRect(settings.rect ?? defaults.rect),
    verticalSize: { ...defaults.verticalSize },
    // The spread of a generic is not assignable to `T` on its own; every
    // property written here is declared by `T`'s constraint.
  } as T
}

/**
 * Mirrors the edge snap in `usePersistentRect.ts`'s `commit` (the `snapToEdge`
 * block). Re-derived here so the invariant "a snapped toolbar sits flush at
 * `viewportWidth - width`" is asserted by this module's tests: if a future edit
 * to the hook breaks it, the two implementations disagree and the test fails.
 *
 * Returns the input rect unchanged when neither edge is within `threshold`.
 */
export function snapRectToViewportEdge(
  rect: SurfaceRect,
  viewportWidth: number,
  threshold: number = TOOLBAR_SNAP_THRESHOLD,
): SurfaceRect {
  const left = rect.x
  const right = viewportWidth - (rect.x + rect.width)
  if (Math.min(left, right) > threshold) return rect
  return { ...rect, x: left <= right ? 0 : Math.max(0, viewportWidth - rect.width) }
}
