export const QUICK_TOOLBAR_PLACEMENTS = ['floating', 'chat_top_dock'] as const

export type QuickToolbarDockPlacement = (typeof QUICK_TOOLBAR_PLACEMENTS)[number]

/** Press-and-hold (ms) before a toolbar/item pointer starts a drag. Was 1000ms. */
export const QUICK_TOOLBAR_POINTER_HOLD_MS = 500
export const QUICK_TOOLBAR_CHILD_FLEX = '0 0 auto'
export const QUICK_TOOLBAR_DOCK_ID = 'chat_top_dock'

export function normalizeQuickToolbarPlacement(value: unknown): QuickToolbarDockPlacement {
  return value === 'chat_top_dock' ? 'chat_top_dock' : 'floating'
}

export function readQuickToolbarPlacement(settings: {
  quickToolbarPlacement?: unknown
} | null | undefined): QuickToolbarDockPlacement {
  if (!settings || !('quickToolbarPlacement' in settings)) return 'floating'
  return normalizeQuickToolbarPlacement(settings.quickToolbarPlacement)
}

export function isAutoFitToolbarBounds(settings: {
  autoFitBounds?: unknown
} | null | undefined): boolean {
  return settings?.autoFitBounds !== false
}

/** Docked V2 fills leftover chat top-bar width unless the user opts out. */
export function isFillTopDockWidth(settings: {
  fillTopDockWidth?: unknown
} | null | undefined): boolean {
  return settings?.fillTopDockWidth !== false
}

export function isV2IconOnly(settings: {
  v2IconOnly?: unknown
} | null | undefined): boolean {
  return settings?.v2IconOnly === true
}

export function isHiddenInChatTopDock(settings: {
  hideInChatTopDock?: unknown
} | null | undefined): boolean {
  return settings?.hideInChatTopDock === true
}

/** Native ChatView ListChecks stays unless the user explicitly turns it off. */
export function isShowNativeSelectMessages(settings: {
  showNativeSelectMessages?: unknown
} | null | undefined): boolean {
  return settings?.showNativeSelectMessages !== false
}

/** Native ChatView ArrowUp (Go to oldest message) stays unless the user explicitly turns it off. */
export function isShowNativeScrollToTop(settings: {
  showNativeScrollToTop?: unknown
} | null | undefined): boolean {
  return settings?.showNativeScrollToTop !== false
}

/** Native ChatView List (Browse messages) stays unless the user explicitly turns it off. */
export function isShowNativeBrowseMessages(settings: {
  showNativeBrowseMessages?: unknown
} | null | undefined): boolean {
  return settings?.showNativeBrowseMessages !== false
}

export function isOpaqueToolbarBackdrop(settings: {
  opaqueToolbarBackdrop?: unknown
} | null | undefined): boolean {
  return settings?.opaqueToolbarBackdrop === true
}

/** Floating fill is edge-to-edge. Manual drag clamps to the viewport, not a 24px inset. */
export const FLOATING_V2_VIEWPORT_MARGIN = 0

export type DockBudgetSampleState = {
  accepted: number
  pending: number | null
  pendingCount: number
}

export const EMPTY_DOCK_BUDGET_STATE: DockBudgetSampleState = {
  accepted: 0,
  pending: null,
  pendingCount: 0,
}

/** Ignore 0/NaN. Grow immediately. Accept shrink only after two close samples. */
export function acceptDockedV2BudgetSample(
  sample: number,
  state: DockBudgetSampleState,
): DockBudgetSampleState {
  if (!Number.isFinite(sample) || sample <= 0) return state
  const next = Math.round(sample)
  if (!(state.accepted > 0)) {
    return { accepted: next, pending: null, pendingCount: 0 }
  }
  const delta = next - state.accepted
  if (Math.abs(delta) <= 1) {
    return { accepted: state.accepted, pending: null, pendingCount: 0 }
  }
  if (delta > 1) {
    return { accepted: next, pending: null, pendingCount: 0 }
  }
  if (state.pending == null || Math.abs(next - state.pending) > 1) {
    return { accepted: state.accepted, pending: next, pendingCount: 1 }
  }
  const count = state.pendingCount + 1
  if (count >= 2) {
    return { accepted: Math.round(state.pending), pending: null, pendingCount: 0 }
  }
  return { accepted: state.accepted, pending: state.pending, pendingCount: count }
}

export function resolveFloatingV2Rail(args: {
  fill: boolean
  uiScale: number
  dockRect?: { left: number; top: number; width: number } | null
  columnRect?: { left: number; top: number; width: number } | null
  viewport: { left: number; top: number; width: number }
}): { x: number; y: number; width: number } {
  const scale = args.uiScale > 0 ? args.uiScale : 1
  const viewportRail = {
    x: args.viewport.left / scale,
    y: args.viewport.top / scale,
    width: Math.max(0, args.viewport.width / scale),
  }
  // Full-screen fill deliberately paints the viewport. Its explicit opt-out
  // keeps the original dock/column rail available for floating V2 auto-fit.
  if (args.fill) {
    return {
      x: 0,
      y: args.viewport.top / scale,
      width: Math.max(0, args.viewport.width / scale),
    }
  }
  if (args.dockRect && args.dockRect.width > 0) {
    return {
      x: args.dockRect.left / scale,
      y: args.dockRect.top / scale,
      width: args.dockRect.width / scale,
    }
  }
  if (args.columnRect && args.columnRect.width > 0) {
    return {
      x: args.columnRect.left / scale,
      y: args.columnRect.top / scale,
      width: args.columnRect.width / scale,
    }
  }
  return viewportRail
}

/** Resolve the JS-measured paint width for floating V2 without CSS viewport units. */
export function resolveFloatingV2PaintWidth(args: {
  fill: boolean
  railWidth: number
  contentWidth: number
}): number {
  const railWidth = Number.isFinite(args.railWidth) && args.railWidth > 0 ? args.railWidth : 0
  const contentWidth = Number.isFinite(args.contentWidth) && args.contentWidth > 0 ? args.contentWidth : 0
  return args.fill ? railWidth : Math.min(railWidth || contentWidth, contentWidth || railWidth)
}

export const TOOLBAR_LABEL_SIZE_MIN = 9
export const TOOLBAR_LABEL_SIZE_MAX = 18
/** Card strip floor — matches `.cardStrip .card { min-height: max(32px, icon + 12px) }`. */
export const TOOLBAR_VISIBLE_MIN_HEIGHT = 32
export const TOOLBAR_CARD_ICON_PAD = 12
/** Default `.toolbar` 4px block padding + 8px handles + 1px borders. */
export const TOOLBAR_CHROME_HEIGHT = 18

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveExtent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Sliders ship `min={9}` / `max={18}`; keep every writer on that range. */
export function clampLabelSize(n: unknown): number {
  return Math.min(TOOLBAR_LABEL_SIZE_MAX, Math.max(TOOLBAR_LABEL_SIZE_MIN, finiteNumber(n, TOOLBAR_LABEL_SIZE_MIN)))
}

/** Card `max(32, icon + 12)` plus chrome so an unmeasured auto-fit box cannot collapse to 0. */
export function visibleToolbarHeightFloor(iconSize?: unknown, chrome?: unknown): number {
  const icon = positiveExtent(iconSize)
  const chromeHeight = typeof chrome === 'number' && Number.isFinite(chrome) && chrome >= 0
    ? chrome
    : TOOLBAR_CHROME_HEIGHT
  return Math.max(TOOLBAR_VISIBLE_MIN_HEIGHT, icon + TOOLBAR_CARD_ICON_PAD) + chromeHeight
}

/** Auto-fit with no measured height must keep a positive floor through `clampSurfaceRect`. */
export function shouldKeepVisible({
  autoFitBounds,
  natural,
  naturalHeight,
}: {
  autoFitBounds?: unknown
  natural?: { height?: number }
  naturalHeight?: number
}): boolean {
  if (autoFitBounds === false) return false
  return positiveExtent(natural?.height ?? naturalHeight) === 0
}

/**
 * Auto-fit / metrics-change may switch to the measured box, but never while
 * `natural` is still `{0,0}` — that path wipes the usable rect to the auto
 * sentinel and paints `--quick-toolbar-height: 0px`.
 */
export function shouldUseNaturalToolbarSize({
  autoFitBounds,
  contentMetricsChanged,
  natural,
  naturalHeight,
}: {
  autoFitBounds?: unknown
  contentMetricsChanged: boolean
  natural?: { width?: number; height?: number }
  naturalHeight?: number
}): boolean {
  if (autoFitBounds === false && !contentMetricsChanged) return false
  const height = natural?.height ?? naturalHeight
  if (height !== undefined && positiveExtent(height) === 0) return false
  if (natural && positiveExtent(natural.width) === 0 && positiveExtent(natural.height) === 0) return false
  return autoFitBounds !== false || contentMetricsChanged
}
