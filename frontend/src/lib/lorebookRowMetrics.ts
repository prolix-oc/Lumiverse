/**
 * Row geometry for the virtualized lorebook entry table.
 *
 * React-free, store-free and DOM-free on purpose: this repo has no DOM test
 * environment, so any arithmetic that only exists inside `EntryTable.tsx` cannot
 * be tested for behaviour at all. The component reads the two *inputs* from the
 * DOM (`data-density` on the workspace section, `--lumiverse-font-scale` on
 * `<html>`) and hands them here as plain numbers/strings.
 *
 * Everything below is expressed in **layout** pixels — the same space
 * `@tanstack/virtual-core` works in (`offsetHeight`, `scrollTop`,
 * `scrollTo({ top })`) and the same space the stylesheet is written in. Nothing
 * here is ever divided by `--lumiverse-ui-scale`; that is the `body > * { zoom }`
 * factor and applying it to a layout-pixel estimate would be the bug, not the fix.
 */

export type LorebookRowDensity = 'compact' | 'balanced' | 'spacious'

export const DEFAULT_ENTRY_ROW_DENSITY: LorebookRowDensity = 'compact'

/**
 * Mirrors `.entryRow { min-height }` and its `[data-density="…"]` overrides in
 * `LorebookEditorLayout.module.css`. If someone edits those numbers without
 * editing these, `entryRowPitch` starts lying about the first paint — which is
 * exactly what the `fontScale === 1` test below exists to catch.
 */
export const ENTRY_ROW_MIN_HEIGHT: Record<LorebookRowDensity, number> = {
  compact: 39,
  balanced: 45,
  spacious: 52,
}

/**
 * Mirrors `.entryVirtualRow { padding-bottom }` — the inter-row gap.
 *
 * It lives on the *wrapper* rather than on `.entryRow` (where it used to be a
 * `margin-bottom`) because a child's bottom margin does not contribute to the
 * wrapper's `offsetHeight`. Leaving it as a margin would make every measured row
 * 4px short of its true pitch and the rows would butt together.
 */
export const ENTRY_ROW_GAP = 4

/**
 * The height one row wants when its *content* rather than its `min-height` is
 * what sets it: 5px + 5px padding, 1px + 1px border, and ~22px of controls
 * (number inputs, the type select, the enable switch) whose box grows with
 * `--lumiverse-font-scale`.
 *
 * Deliberately below every `ENTRY_ROW_MIN_HEIGHT` at scale 1, so an unscaled app
 * estimates exactly the CSS constant.
 */
export const ENTRY_ROW_CONTENT_HEIGHT = 34

/** Coerces an unknown `data-density` attribute to a density the CSS actually has. */
export function normalizeRowDensity(raw: string | null | undefined): LorebookRowDensity {
  if (raw === 'compact' || raw === 'balanced' || raw === 'spacious') return raw
  return DEFAULT_ENTRY_ROW_DENSITY
}

/**
 * Coerces a raw `--lumiverse-font-scale` (a CSS custom property, so a string) to
 * a usable multiplier. A missing, zero, negative or non-numeric value means "no
 * scaling" — never `NaN`, which would poison `estimateSize` and make
 * `getTotalSize()` return `NaN` for the whole list.
 */
export function normalizeFontScale(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * First-paint pitch estimate for one row, in layout px, **including the gap**.
 *
 * `estimateSize` only has to be close: the virtualizer replaces it with the real
 * `offsetHeight` of every row it mounts. Being close still matters, because the
 * initial `getTotalSize()` is what sizes the scrollbar, and a badly wrong
 * estimate makes the scrollbar jump the first time the user scrolls.
 */
export function entryRowPitch(
  density: LorebookRowDensity,
  fontScale: number = 1,
): number {
  const scale = normalizeFontScale(fontScale)
  const minHeight = ENTRY_ROW_MIN_HEIGHT[density] ?? ENTRY_ROW_MIN_HEIGHT[DEFAULT_ENTRY_ROW_DENSITY]
  return Math.max(minHeight, Math.ceil(ENTRY_ROW_CONTENT_HEIGHT * scale)) + ENTRY_ROW_GAP
}
