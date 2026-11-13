/**
 * Pure geometry helpers for the lorebook editors.
 *
 * Kept free of React and store imports so they can be unit-tested without a DOM.
 */

/**
 * Legacy chat reservation.
 *
 * Retained because {@link clampHalfEditorWidth} is still exported and pinned by
 * tests, but it is *not* what the live half editor clamps against any more: 240px
 * of chat next to a 1680px editor on a 1920px row is the bug users reported, not
 * a fix for it. {@link DEFAULT_MIN_CHAT_WIDTH} is the real reservation and it is
 * user-configurable — see `LorebookEditorSettings.minChatWidth`.
 */
export const HALF_EDITOR_MIN_CHAT_WIDTH = 240
export const HALF_EDITOR_MIN_WIDTH = 360

/** Default for `LorebookEditorSettings.minChatWidth`. */
export const DEFAULT_MIN_CHAT_WIDTH = 420
/** Default for `LorebookEditorSettings.minEditorPaneWidth`. */
export const DEFAULT_MIN_EDITOR_PANE_WIDTH = 360

export const FULL_EDITOR_MARGIN = 16
export const MOBILE_EDITOR_MAX_WIDTH = 768
export const DEFAULT_FULL_EDITOR_RECT = { x: 48, y: 36, width: 1540, height: 840 }
/**
 * The full editor's floor.
 *
 * Was `{760, 520}`, which existed only because the workspace could not lay itself
 * out any narrower. The `@container lbWorkspace` ladder in
 * `LorebookEditorLayout.module.css` now collapses the books pane, stacks the panes
 * and drops the splitter on the *workspace's* own width, and `resolveResponsiveColumns`
 * sheds entry columns to fit the pane, so the content copes far below 760. The floor
 * is now about usability, not about avoiding overflow.
 */
export const FULL_EDITOR_MIN = { width: 560, height: 420 }

export interface ViewportSize {
  width: number
  height: number
}

/**
 * A remembered width from a wider window would otherwise force the host past the
 * chat row, clipping the editor against both viewport edges.
 *
 * Superseded by {@link resolveHalfEditorLayout} for the live half editor, which
 * takes the reservation as a parameter and reports an `overlay` mode instead of
 * returning a width the row cannot hold. This function keeps its original
 * semantics exactly — including returning `HALF_EDITOR_MIN_WIDTH` on a row too
 * narrow to hold it — so nothing that still calls it changes behaviour.
 */
export function clampHalfEditorWidth(width: number, viewportWidth: number): number {
  const available = Math.max(HALF_EDITOR_MIN_WIDTH, viewportWidth - HALF_EDITOR_MIN_CHAT_WIDTH)
  return Math.round(Math.min(Math.max(HALF_EDITOR_MIN_WIDTH, width), available))
}

export interface HalfEditorLayoutRequest {
  /** The user's stored intent — never written back by this function. */
  requestedWidth: number
  /** Layout px the chat column and the editor host share, measured together. */
  availableWidth: number
  minChatWidth?: number
  minEditorWidth?: number
}

export interface HalfEditorLayout {
  width: number
  /**
   * `docked` — the editor and a usable chat fit side by side.
   * `overlay` — they do not, so the editor takes the whole row *deliberately* and
   * the host advertises it via `data-layout="overlay"`, rather than silently
   * squeezing chat to nothing with nothing on screen explaining why. The stylesheet
   * responds by raising the panel's shadow (it reads as *over* the chat rather than
   * beside it) and dropping the resize handle, which cannot split the row any more.
   */
  mode: 'docked' | 'overlay'
}

const normalize = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback

/**
 * Decides how wide the half-screen editor may actually render.
 *
 * Additive: {@link clampHalfEditorWidth} is untouched, because its "return the
 * editor minimum even when the row cannot hold it" behaviour is pinned by tests
 * and is precisely the behaviour this function replaces.
 *
 * **Invariant, guaranteed by the final clamp below and asserted by a property
 * sweep in `tests/lorebook-editor.test.ts`:**
 *
 * > `min(minEditorWidth, availableWidth) <= width <= availableWidth`
 *
 * That one property is what makes "dragging the editor too far left covers
 * everything" structurally impossible: the returned width can never exceed the
 * row, and can never collapse below the editor's own floor unless the row itself
 * is narrower than that floor.
 */
export function resolveHalfEditorLayout({
  requestedWidth,
  availableWidth,
  minChatWidth = DEFAULT_MIN_CHAT_WIDTH,
  minEditorWidth = DEFAULT_MIN_EDITOR_PANE_WIDTH,
}: HalfEditorLayoutRequest): HalfEditorLayout {
  const available = normalize(availableWidth)
  const chat = normalize(minChatWidth, DEFAULT_MIN_CHAT_WIDTH)
  const editor = normalize(minEditorWidth, DEFAULT_MIN_EDITOR_PANE_WIDTH)
  const floor = Math.min(editor, available)

  const docked = available - chat >= editor
  const requested = normalize(requestedWidth, editor)
  const raw = docked
    ? Math.min(Math.max(requested, editor), available - chat)
    : available

  // Belt and braces: every branch above already satisfies the invariant, but
  // stating it once here means a future branch cannot quietly violate it.
  return {
    width: Math.min(Math.max(raw, floor), available),
    mode: docked ? 'docked' : 'overlay',
  }
}

export function centerEditorRect(
  rect: { width: number; height: number },
  viewport: ViewportSize,
) {
  return {
    x: Math.max(0, Math.round((viewport.width - rect.width) / 2)),
    y: Math.max(0, Math.round((viewport.height - rect.height) / 2)),
    width: rect.width,
    height: rect.height,
  }
}

/**
 * A remembered rectangle from a larger window would otherwise open the full
 * editor wider than the viewport, pushing its panes off both edges.
 */
export function clampEditorRectToViewport(
  rect: { width: number; height: number },
  viewport: ViewportSize,
) {
  return {
    width: Math.max(
      Math.min(FULL_EDITOR_MIN.width, viewport.width),
      Math.min(rect.width, viewport.width - FULL_EDITOR_MARGIN * 2),
    ),
    height: Math.max(
      Math.min(FULL_EDITOR_MIN.height, viewport.height),
      Math.min(rect.height, viewport.height - FULL_EDITOR_MARGIN * 2),
    ),
  }
}

/**
 * Resolve the remembered windowed rectangle without carrying a phone-sized
 * value back onto a desktop viewport. Mobile windowing is never persisted by
 * the live editor, but this recovery also repairs values saved by older builds.
 */
export function resolveWindowedEditorRect(
  rect: { width: number; height: number },
  viewport: ViewportSize,
) {
  const recoveredRect = viewport.width > 900 && rect.width <= MOBILE_EDITOR_MAX_WIDTH
    ? DEFAULT_FULL_EDITOR_RECT
    : rect
  return centerEditorRect(clampEditorRectToViewport(recoveredRect, viewport), viewport)
}
