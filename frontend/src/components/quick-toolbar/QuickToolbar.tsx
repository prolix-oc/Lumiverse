import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  GripVertical,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  Pin,
  RotateCcw,
  Search,
  SlidersHorizontal,
  User,
} from 'lucide-react'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { isMobileViewportOrDevice, shouldHideQuickToolbarWhenOverlaid } from '@/lib/uiProductivityDefaults'
import { useLorebookWorkspaceOverlayOpen } from '@/lib/lorebookWorkspaceVisibility'
import { usePersistentRect, type DragMode } from '@/hooks/usePersistentRect'
import {
  resolveToolbarRect,
  selectToolbarRect,
  toolbarRectBounds,
  withToolbarPosition,
  withToolbarRect,
  type Size,
} from '@/lib/quickToolbarGeometry'
import {
  CUSTOMIZER_WIDTH,
  placeCustomizer,
  readUiScale,
  type CustomizerPlacement,
} from '@/lib/quickToolbarPlacement'
import { isSurfaceActive, type ToolbarUiState } from '@/lib/quickToolbarToggle'
import { canMoveWithinFiltered, filterActionIds } from '@/lib/toolbarActionSearch'
import { useStore } from '@/store'
import type { QuickToolbarDensity, SettingsWriteSource, SurfaceRectPrefs } from '@/types/store'
import styles from './QuickToolbar.module.css'
import QuickToolbarCustomizeModal from './QuickToolbarCustomizeModal'
import {
  isAutoFitToolbarBounds,
  isV2IconOnly,
  QUICK_TOOLBAR_CHILD_FLEX,
  QUICK_TOOLBAR_DOCK_ID,
  readQuickToolbarPlacement,
  shouldUseNaturalToolbarSize,
} from './quickToolbarDock'
import { createCoalescedLayoutScheduler } from './toolbarLayoutBatch'
import { createPointerHoldController, isExplicitToolbarDragTarget } from './toolbarPointerHold'
import { useQuickToolbarActions, type ToolbarAction } from './useQuickToolbarActions'
import { useQuickToolbarContext } from './useQuickToolbarContext'

const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/** Glyph sizes that are toolbar *chrome* rather than action icons. */
const GRIP_GLYPH = 16
const CHEVRON_GLYPH = 14

/**
 * CSS Modules run with `localsConvention: 'camelCaseOnly'`, so `.resize_n` is
 * only exported as `resizeN`. Indexing by the source name silently returned
 * `undefined`, which left every handle at 0x0 and made the toolbar unresizable.
 */
const RESIZE_HANDLE_CLASS: Record<(typeof RESIZE_HANDLES)[number], string> = {
  n: styles.resizeN,
  s: styles.resizeS,
  e: styles.resizeE,
  w: styles.resizeW,
  ne: styles.resizeNe,
  nw: styles.resizeNw,
  se: styles.resizeSe,
  sw: styles.resizeSw,
}

/** Below this width the popover is unusable, so the modal takes over. */
const MODAL_ONLY_WIDTH = 760

function useToolbarIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(isMobileViewportOrDevice)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const pointerQuery = window.matchMedia?.('(pointer: coarse)')
    const update = () => setIsMobile(isMobileViewportOrDevice())
    window.addEventListener('resize', update)
    pointerQuery?.addEventListener('change', update)
    return () => {
      window.removeEventListener('resize', update)
      pointerQuery?.removeEventListener('change', update)
    }
  }, [])

  return isMobile
}

export function QuickToolbar() {
  const {
    settings,
    updateSettings,
    actionCatalog,
    actionById,
    actions,
    visibleIds,
    orderedIds,
    catalogOrder,
    moveActionWithin,
    toggleAction,
    resetCurrentVariant,
  } = useQuickToolbarActions()
  const cardContext = useQuickToolbarContext()
  const [customizing, setCustomizing] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  /**
   * Icon-list search text. Component-local and never persisted: a filter is a
   * transient reading aid, and a stored one would silently hide icons the next
   * time the popover opened.
   */
  const [iconQuery, setIconQuery] = useState('')
  const [placement, setPlacement] = useState<CustomizerPlacement | null>(null)
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLElement | null>(null)
  const measureRailRef = useRef<HTMLDivElement | null>(null)
  const measureButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const customizeButtonRef = useRef<HTMLButtonElement | null>(null)
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const overflowPopoverRef = useRef<HTMLDivElement | null>(null)
  const overflowSearchRef = useRef<HTMLInputElement | null>(null)
  const customizerRef = useRef<HTMLDivElement | null>(null)
  const dragModeRef = useRef<DragMode | null>(null)
  const eventSuppressClickRef = useRef(false)
  const [failedProfilePortraitUrl, setFailedProfilePortraitUrl] = useState<string | null>(null)

  // The pressed affordance needs live UI state; the *decision* is made from a
  // `getState()` snapshot at click time inside `useQuickToolbarActions`.
  const drawerOpen = useStore((state) => state.drawerOpen)
  const drawerTab = useStore((state) => state.drawerTab)
  const settingsModalOpen = useStore((state) => state.settingsModalOpen)
  const settingsActiveView = useStore((state) => state.settingsActiveView)
  const characterEditorOpen = useStore((state) => Boolean(state.editingCharacterId))
  const lorebookHalfEditorOpen = useStore((state) => state.lorebookHalfEditor.open)
  const lorebookWorkspaceOpen = useLorebookWorkspaceOverlayOpen()
  const isMobile = useToolbarIsMobile()
  const activeCharacter = useStore((state) => state.characters.find((character) => character.id === state.activeCharacterId))
  const profilePortraitUrl = getCharacterAvatarThumbUrl(activeCharacter)
  useEffect(() => {
    setFailedProfilePortraitUrl(null)
  }, [profilePortraitUrl])
  /**
   * U1: the single-slot store modal, and *only* it.
   *
   * `store/slices/ui.ts` keeps the screen-owning modals in `activeModal` (`:7`)
   * and the Settings modal in a separate `settingsModalOpen` boolean (`:13`) —
   * `openSettings` never writes `activeModal`. Reading this field therefore
   * cannot see Settings, the drawer, the command palette or this toolbar's own
   * customizer, which is what makes "pressing Settings buries the toolbar so it
   * cannot be pressed again to close" structurally impossible rather than merely
   * untested.
   */
  const activeModal = useStore((state) => state.activeModal)
  /**
   * Whether the user pressed the edge tab to bring the toolbar back over the
   * modal that is currently up. Deliberately not persisted, and reset below
   * whenever `activeModal` changes, so a restore lasts exactly one modal.
   */
  const [restoredOverModal, setRestoredOverModal] = useState(false)
  const uiState = useMemo<ToolbarUiState>(
    () => ({ drawerOpen, drawerTab, settingsModalOpen, settingsActiveView }),
    [drawerOpen, drawerTab, settingsModalOpen, settingsActiveView],
  )

  // Visual variant is independent of dock placement. Absent/legacy/invalid
  // `quickToolbarPlacement` values resolve to floating so a V2 card strip can
  // still float and a V1 pill rail can still sit in `chat_top_dock`.
  const v2 = settings.variant === 'v2-settings-adjacent'
  const dockPlacement = readQuickToolbarPlacement(settings as { quickToolbarPlacement?: unknown })
  const docked = dockPlacement === 'chat_top_dock'
  const freePosition = !docked
  const anchored = v2
  const iconSize = anchored ? settings.v2IconSize : settings.iconSize
  const orientation = anchored ? 'horizontal' : settings.orientation
  const vertical = orientation === 'vertical'
  // `scale` used to be a `transform: scale()`, which does not affect layout — so
  // the rect, the rendered box and the handle positions all disagreed. It is now
  // a multiplier on the content metrics. V2 never scaled (`.toolbarAnchored` set
  // `transform: none`) and must not start.
  const rawScale = anchored ? 1 : settings.scale
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1
  const renderedIconSize = Math.round(iconSize * scale)

  // A-B2: `usePersistentRect`'s re-clamp effect lists `rect` by *object
  // identity*. A freshly built object on every render would loop
  // render → effect → setDraftRect → render, without bound. Both memos below
  // key on scalars only, so the hook sees a stable object.
  const naturalWidth = natural.width
  const naturalHeight = natural.height
  const autoFitBounds = isAutoFitToolbarBounds(settings as { autoFitBounds?: unknown })
  const contentMetricsKey = `${iconSize}:${anchored ? settings.v2LabelTextSize : settings.labelTextSize}:${anchored ? settings.v2LabelVisible !== false : settings.labelVisible}`
  const metricsAtPinRef = useRef(contentMetricsKey)
  const useNaturalSize = shouldUseNaturalToolbarSize({
    autoFitBounds,
    contentMetricsChanged: metricsAtPinRef.current !== contentMetricsKey,
  })
  // Per-orientation extents, one shared position. A single rect made a flip
  // render the *union* of both orientations' boxes: `clampSurfaceRect` raises
  // the new main axis to its measured minimum and never lowers the stale cross
  // axis, so a pinned 560x46 horizontal toolbar came back 560x500 as a vertical.
  // `orientation` is a dep for exactly that reason.
  const resolvedRect = useMemo(() => {
    const selected = selectToolbarRect(settings, orientation)
    return resolveToolbarRect(
      useNaturalSize ? { ...selected, width: 0, height: 0 } : selected,
      { width: naturalWidth, height: naturalHeight },
    )
  }, [settings, orientation, naturalWidth, naturalHeight, useNaturalSize])
  const bounds = useMemo(
    () => toolbarRectBounds({ width: naturalWidth, height: naturalHeight }),
    [naturalWidth, naturalHeight],
  )

  const handleCommit = useCallback((next: SurfaceRectPrefs, source: SettingsWriteSource) => {
    const mode = dragModeRef.current
    dragModeRef.current = null
    // A-S6: the hook also commits on every *window* resize (`keepInViewport`).
    // Writing width/height from there would silently pin an auto-fitting
    // toolbar to whatever size it happened to have at that moment, so only a
    // handle drag — the user actually asking for a size — pins one. A move drag
    // repositions without pinning, which keeps auto-fit alive after a drag too.
    const pinsSize = mode !== null && mode !== 'move'
    const persisted = useStore.getState().quickToolbarSettings
    // A resize pins the size of the orientation being resized and nothing else,
    // so the other orientation keeps whatever it had — including its auto
    // sentinel. A move writes the shared position only.
    if (source !== 'user-interaction') return
    if (pinsSize) metricsAtPinRef.current = contentMetricsKey
    updateSettings(pinsSize
      ? withToolbarRect(persisted, orientation, next)
      : withToolbarPosition(persisted, next))
  }, [contentMetricsKey, orientation, updateSettings])

  const persistentRect = usePersistentRect({
    rect: resolvedRect,
    bounds,
    // The same expression `--quick-toolbar-rotation` is built from below, so the
    // handles' maths and the painted transform can never disagree. Without it a
    // 90°-rotated toolbar's east handle still consumed only `dx`, so dragging it
    // in the direction it visibly points did nothing.
    rotationDeg: freePosition ? settings.rotationDeg : 0,
    snapToEdge: settings.snapToEdge,
    onCommit: handleCommit,
  })

  const beginDrag = useCallback((mode: DragMode, event: ReactPointerEvent) => {
    dragModeRef.current = mode
    persistentRect.startDrag(mode, event)
  }, [persistentRect])
  const beginDragRef = useRef(beginDrag)
  beginDragRef.current = beginDrag
  const freePositionRef = useRef(freePosition)
  freePositionRef.current = freePosition

  const holdRef = useRef<ReturnType<typeof createPointerHoldController> | null>(null)
  if (holdRef.current === null) {
    holdRef.current = createPointerHoldController((point) => {
      if (!freePositionRef.current) return
      beginDragRef.current('move', {
        preventDefault() {},
        clientX: point.clientX,
        clientY: point.clientY,
      } as ReactPointerEvent)
    })
  }

  const beginExplicitDrag = useCallback((mode: DragMode, event: ReactPointerEvent) => {
    holdRef.current?.cancel()
    beginDrag(mode, event)
  }, [beginDrag])

  /**
   * Measures the toolbar's *natural* extent — the size it wants to be.
   *
   * It cannot be computed: `iconSize + 14` is `.item`'s `min-width` and not its
   * width, `.itemLabel` is text up to `max-width: 88px`, and `box-sizing:
   * border-box` plus a 1px border costs another 2px per axis. And it cannot be
   * read straight off the nav either, because the nav now *fills* the persisted
   * rect. So the root is flagged `data-measuring` for exactly one synchronous
   * read, during which CSS unconstrains the nav to `max-content`; nothing paints
   * in between. The result is published as `--quick-toolbar-natural-width/
   * -height` so CSS and JS cannot diverge.
   */
  const measureNatural = useCallback(() => {
    const root = rootRef.current
    const node = toolbarRef.current
    if (!root || !node) return
    root.setAttribute('data-measuring', 'true')
    // `getBoundingClientRect` flushes style + layout, so this reads the
    // unconstrained box even though the attribute was set a statement ago.
    const box = node.getBoundingClientRect()
    root.removeAttribute('data-measuring')
    // Rendered pixels: `body > *` carries `zoom: var(--lumiverse-ui-scale)`,
    // while the rect is in the zoom layer's own layout units.
    const uiScale = readUiScale()
    const width = Math.ceil(box.width / uiScale)
    const height = Math.ceil(box.height / uiScale)
    if (!(width > 0) || !(height > 0)) return
    setNatural((previous) => (
      previous.width === width && previous.height === height ? previous : { width, height }
    ))
  }, [])

  const measureNaturalRef = useRef(measureNatural)
  measureNaturalRef.current = measureNatural
  const measureV2FitRef = useRef<() => void>(() => {})
  const anchoredRef = useRef(anchored)
  anchoredRef.current = anchored
  const layoutBatchRef = useRef(createCoalescedLayoutScheduler(() => {
    if (anchoredRef.current) measureV2FitRef.current()
    else measureNaturalRef.current()
  }))

  // Content settings move the natural size; the viewport can cap it through the
  // narrow-screen `max-width`. ResizeObserver callbacks are coalesced to one
  // layout batch per frame so icon/label changes remasure without observer loops.
  useLayoutEffect(() => {
    if (docked && !anchored) return
    if (!anchored) layoutBatchRef.current.schedule()
    const onResize = () => layoutBatchRef.current.schedule()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [
    actions.length,
    anchored,
    docked,
    iconSize,
    measureNatural,
    orientation,
    scale,
    settings.labelTextSize,
    settings.labelVisible,
    contentMetricsKey,
  ])

  useEffect(() => () => {
    layoutBatchRef.current.cancel()
    holdRef.current?.cancel()
  }, [])

  const [fitReady, setFitReady] = useState(false)
  const [visibleActionIds, setVisibleActionIds] = useState<string[]>([])
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [overflowQuery, setOverflowQuery] = useState('')
  const [overflowPlacement, setOverflowPlacement] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
    side: CustomizerPlacement['side']
    caret: number
  } | null>(null)

  /** Measures real pill widths, then exposes only the configured prefix that fits. */
  const measureV2Fit = useCallback(() => {
    if (!anchored) return
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const uiScale = readUiScale()
    const toLayoutWidth = (node: HTMLElement | null, fallback: number) => {
      const renderedWidth = node?.getBoundingClientRect().width ?? 0
      return renderedWidth > 0 ? renderedWidth / uiScale : fallback
    }
    // `clientWidth` is a layout-space measurement. Every rect-derived width is
    // divided by the UI zoom so the fit calculation never mixes coordinate spaces.
    const toolbarWidth = toolbar.clientWidth || toLayoutWidth(toolbar, 0)
    if (!(toolbarWidth > 0)) {
      const next = actions.map((action) => action.id)
      setVisibleActionIds((previous) => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next)
      setFitReady(true)
      return
    }
    const customizeWidth = toLayoutWidth(customizeButtonRef.current, 36)
    const overflowWidth = toLayoutWidth(overflowButtonRef.current, 56)
    const gap = 6
    const widths = actions.map((action) => {
      const measured = toLayoutWidth(measureButtonRefs.current.get(action.id) ?? null, 0)
      return measured > 0 ? measured : Math.max(72, action.label.length * 7 + 48)
    })
    const cardTotal = (count: number) => widths.slice(0, count).reduce((sum, width) => sum + width, 0) + Math.max(0, count - 1) * gap
    const fitsAll = cardTotal(actions.length) + gap + customizeWidth <= toolbarWidth
    const available = toolbarWidth - customizeWidth - gap - (fitsAll ? 0 : overflowWidth + gap)
    let count = 0
    while (count < actions.length && cardTotal(count + 1) <= Math.max(0, available)) count += 1
    const next = actions.slice(0, fitsAll ? actions.length : count).map((action) => action.id)
    setVisibleActionIds((previous) => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next)
    setFitReady(true)
    if (fitsAll) setOverflowOpen(false)
  }, [actions, anchored])
  measureV2FitRef.current = measureV2Fit

  useLayoutEffect(() => {
    if (!anchored) return
    setFitReady(false)
    measureV2Fit()
    const observer = new ResizeObserver(() => layoutBatchRef.current.schedule())
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    if (measureRailRef.current) observer.observe(measureRailRef.current)
    const onResize = () => layoutBatchRef.current.schedule()
    window.addEventListener('resize', onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [actions.length, anchored, iconSize, settings.v2LabelTextSize, settings.v2LabelVisible, measureV2Fit])

  const overflowActionIds = useMemo(
    () => actions.map((action) => action.id).filter((id) => !visibleActionIds.includes(id)),
    [actions, visibleActionIds],
  )
  const filteredOverflowIds = useMemo(
    () => filterActionIds(overflowActionIds, actionById, overflowQuery),
    [actionById, overflowActionIds, overflowQuery],
  )

  useEffect(() => {
    if (!anchored || !overflowButtonRef.current) return
    const observer = new ResizeObserver(() => layoutBatchRef.current.schedule())
    observer.observe(overflowButtonRef.current)
    return () => observer.disconnect()
  }, [anchored, measureV2Fit, overflowActionIds.length])

  const measureOverflow = useCallback(() => {
    const anchor = overflowButtonRef.current?.getBoundingClientRect()
    if (!anchor) return
    const uiScale = readUiScale()
    const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight }
    const layoutViewportWidth = viewport.width / uiScale
    const preferredWidth = Math.min(520, Math.max(320, layoutViewportWidth * 0.42))
    // The nominal 320px floor only applies when the viewport can support it.
    // A smaller viewport gets the available width instead of page-level overflow.
    const width = Math.min(preferredWidth, Math.max(0, layoutViewportWidth - 20))
    const rendered = placeCustomizer(anchor, false, viewport, width * uiScale)
    setOverflowPlacement({
      left: rendered.left / uiScale,
      top: rendered.top / uiScale,
      width,
      maxHeight: Math.min(480, rendered.maxHeight / uiScale),
      side: rendered.side,
      caret: Math.max(14, Math.min(rendered.caret / uiScale, Math.max(14, width - 14))),
    })
  }, [])

  useLayoutEffect(() => {
    if (!overflowOpen) return
    measureOverflow()
    overflowSearchRef.current?.focus()
    window.addEventListener('resize', measureOverflow)
    window.addEventListener('scroll', measureOverflow, true)
    return () => {
      window.removeEventListener('resize', measureOverflow)
      window.removeEventListener('scroll', measureOverflow, true)
    }
  }, [measureOverflow, overflowOpen])

  useEffect(() => {
    if (!overflowOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (overflowPopoverRef.current?.contains(target) || toolbarRef.current?.contains(target))) return
      setOverflowOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOverflowOpen(false)
      overflowButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overflowOpen])

  const measure = useCallback(() => {
    const anchor = toolbarRef.current?.getBoundingClientRect()
    if (!anchor) return
    // `body > *` carries `zoom: var(--lumiverse-ui-scale)`, so the portaled popover
    // lives in a zoomed layer: getBoundingClientRect gives rendered pixels while the
    // inline left/top we write are resolved in pre-zoom layout space. Place in
    // rendered space, then convert once on the way out.
    const uiScale = readUiScale()
    const rendered = placeCustomizer(anchor, vertical, {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    }, CUSTOMIZER_WIDTH * uiScale)
    // The 14px caret inset is a design unit, so re-apply it after converting to
    // layout space rather than letting the division shrink it into the corner radius.
    const maxHeight = rendered.maxHeight / uiScale
    const along = rendered.side === 'below' || rendered.side === 'above' ? CUSTOMIZER_WIDTH : maxHeight
    setPlacement({
      ...rendered,
      left: rendered.left / uiScale,
      top: rendered.top / uiScale,
      maxHeight,
      caret: Math.max(14, Math.min(rendered.caret / uiScale, Math.max(14, along - 14))),
    })
  }, [vertical])

  useLayoutEffect(() => {
    if (!customizing) return
    measure()
    // Both stored boxes, because either can be the one the toolbar is currently
    // rendering — the popover is anchored to the toolbar's edge.
  }, [customizing, measure, settings.rect, settings.verticalSize, settings.scale, settings.rotationDeg, actions.length])

  // The toolbar's own controls (icon size, label size, show labels) change the
  // nav's box without touching any of the values above, so observe it directly
  // instead of trying to enumerate every setting that affects its size.
  useEffect(() => {
    if (!customizing) return
    const node = toolbarRef.current
    const observer = node ? new ResizeObserver(measure) : null
    if (node && observer) observer.observe(node)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [customizing, measure])

  // The popover is portaled to the body, so it needs its own dismissal.
  useEffect(() => {
    if (!customizing) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (customizerRef.current?.contains(target) || toolbarRef.current?.contains(target)) return
      setCustomizing(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCustomizing(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [customizing])

  // One restore per modal: switching straight from one screen-owning modal to
  // another, or closing the last one, puts the toolbar back under the guard.
  useEffect(() => {
    setRestoredOverModal(false)
  }, [activeModal])

  /**
   * The rows the popover renders — the whole catalog under the query, so a
   * search can still reach a *disabled* icon and switch it on.
   */
  const filteredCatalogIds = useMemo(
    () => filterActionIds(catalogOrder, actionById, iconQuery),
    [actionById, catalogOrder, iconQuery],
  )
  /**
   * The same query intersected with the enabled set — the `filteredIds` the
   * reorder rule needs. `orderedIds` IS the enabled list, so this is exactly the
   * subset of visible rows whose chevrons do anything.
   */
  const filteredEnabledIds = useMemo(
    () => filterActionIds(orderedIds, actionById, iconQuery),
    [actionById, iconQuery, orderedIds],
  )

  const openCustomizer = () => {
    const narrow = (document.documentElement.clientWidth || window.innerWidth) <= MODAL_ONLY_WIDTH
    if (narrow) {
      setCustomizing(false)
      setModalOpen(true)
      return
    }
    setCustomizing((value) => !value)
  }

  if (!settings.enabled || actions.length === 0) return null

  // Normalised rather than read straight through: an imported or hand-edited row
  // can carry anything, and an unknown density must render the shipped look
  // instead of dropping every `[data-density]` rule on the floor.
  const v2Density: QuickToolbarDensity = settings.v2Density === 'compact' ? 'compact' : 'comfortable'
  const labelTextSize = anchored ? settings.v2LabelTextSize : settings.labelTextSize
  const v2IconOnly = anchored && isV2IconOnly(settings as { v2IconOnly?: unknown; v2LabelVisible?: unknown })
  const labelVisible = v2IconOnly ? false : anchored ? settings.v2LabelVisible !== false : settings.labelVisible
  const showProfilePortrait = profilePortraitUrl !== null && profilePortraitUrl !== failedProfilePortraitUrl
  const gripGlyph = Math.round(GRIP_GLYPH * scale)
  const chevronGlyph = Math.round(CHEVRON_GLYPH * scale)
  const configuredGap = Number((settings as { gap?: number }).gap)
  const configuredPadding = Number((settings as { padding?: number }).padding)
  const toolbarStyle = {
    // The *rendered* metrics. Icons are React props rather than CSS, so the same
    // scaled number is passed to every glyph below; only the boxes read the var.
    '--quick-toolbar-icon-size': `${renderedIconSize}px`,
    '--quick-toolbar-label-size': `${labelTextSize * scale}px`,
    '--quick-toolbar-gap': `${Number.isFinite(configuredGap) ? configuredGap : 6}px`,
    '--quick-toolbar-padding-block': `${Number.isFinite(configuredPadding) ? configuredPadding : 8}px`,
    '--quick-toolbar-padding-inline': `${Number.isFinite(configuredPadding) ? configuredPadding : 10}px`,
    '--quick-toolbar-opacity': settings.opacity,
    // Padding and gap scale off this; it is 1 for V2, which never scaled.
    '--quick-toolbar-scale': scale,
    '--quick-toolbar-rotation': `${freePosition ? settings.rotationDeg : 0}deg`,
  } as CSSProperties

  const visibleAnchoredActions = actions.filter((action) => visibleActionIds.includes(action.id))
  const pinOverflowAction = (id: string) => {
    updateSettings({ iconOrder: [id, ...orderedIds.filter((candidate) => candidate !== id)] })
  }

  const renderV2Action = (action: ToolbarAction, measuring = false) => {
    const Icon = action.icon
    const context = cardContext[action.id]
    const closable = action.surface.kind !== 'command'
    const active = closable && isSurfaceActive(action.surface, uiState)
    const hasProfilePortrait = action.id === 'profile' && showProfilePortrait
    return (
      <button
        ref={measuring ? (node) => {
          if (node) measureButtonRefs.current.set(action.id, node)
          else measureButtonRefs.current.delete(action.id)
        } : undefined}
        type="button"
        className={clsx(styles.card, active && styles.cardActive, hasProfilePortrait && styles.cardProfile, v2IconOnly && styles.cardIconOnly)}
        data-toolbar-action={measuring ? undefined : action.id}
        style={{ flex: QUICK_TOOLBAR_CHILD_FLEX }}
        onClick={measuring ? undefined : action.run}
        disabled={measuring ? undefined : action.disabled}
        aria-hidden={measuring || undefined}
        aria-pressed={measuring ? undefined : closable ? active : undefined}
        tabIndex={measuring ? -1 : undefined}
        aria-label={action.label}
        title={context ? `${action.label} — ${context}` : action.label}
      >
        <span className={clsx(styles.cardIcon, hasProfilePortrait && styles.cardIconPortrait)}>
          {hasProfilePortrait ? (
            <img className={styles.cardPortrait} src={profilePortraitUrl ?? undefined} alt="" onError={() => setFailedProfilePortraitUrl(profilePortraitUrl)} />
          ) : action.id === 'profile' ? (
            <User size={renderedIconSize} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Icon size={renderedIconSize} strokeWidth={1.75} aria-hidden="true" />
          )}
        </span>
        {!v2IconOnly && (
          <span className={clsx(styles.cardCopy, hasProfilePortrait && styles.cardCopyProfile)}>
            {labelVisible && <span className={styles.cardTitle}>{action.label}</span>}
            {context
              ? <span className={styles.cardValue}>{context}</span>
              : !labelVisible && <span className={styles.cardValue}>{action.label}</span>}
          </span>
        )}
        {!v2IconOnly && closable && <ChevronDown size={chevronGlyph} className={clsx(styles.cardChevron, active && styles.cardChevronOpen)} aria-hidden="true" />}
      </button>
    )
  }

  const customizeButton = (
    <button
      ref={customizeButtonRef}
      type="button"
      className={clsx(
        styles.item,
        // V2 promotes it from a bare glyph to a card-height bordered sibling, as
        // the confirmed design shows; V1 keeps it as toolbar chrome.
        anchored && styles.cardStripSettings,
        (customizing || modalOpen) && styles.itemActive,
      )}
      onClick={openCustomizer}
      title="Customize toolbar"
      aria-label="Customize toolbar"
      aria-expanded={customizing}
    >
      {anchored
        ? <SlidersHorizontal size={renderedIconSize} aria-hidden="true" />
        : <MoreHorizontal size={renderedIconSize} aria-hidden="true" />}
      {labelVisible && !anchored && <span className={styles.itemLabel}>More</span>}
    </button>
  )

  const tree = (
    <div
      ref={rootRef}
      // The Custom CSS UI tells users to target `[data-component="<name>"]`
      // (`ComponentCssReference.tsx`), so a component that never emits it is
      // unstylable. One root serves both variants, so both are covered.
      data-component="QuickToolbar"
      data-quick-toolbar-dock={QUICK_TOOLBAR_DOCK_ID}
      data-quick-toolbar-placement={dockPlacement}
      data-quick-toolbar-variant={anchored ? 'v2' : 'v1'}
      data-dead-space="0"
      className={clsx(styles.root, freePosition ? styles.rootFree : styles.rootAnchored)}
      onPointerDown={(event) => {
        if (!freePosition || isExplicitToolbarDragTarget(event.target)) return
        holdRef.current?.start(event)
      }}
      onPointerMove={(event) => holdRef.current?.move(event)}
      onPointerUp={() => {
        const result = holdRef.current?.finish()
        if (result?.held) eventSuppressClickRef.current = true
      }}
      onPointerCancel={() => holdRef.current?.cancel()}
      onClickCapture={(event) => {
        if (!eventSuppressClickRef.current) return
        eventSuppressClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
      style={freePosition ? ({
        // Consumed by `.rootFree` as left/top/width/height, the way
        // `ResizablePanelFrame` does it — the rect *is* the rendered box, so the
        // handles, the measurement and the persisted value all agree.
        '--quick-toolbar-x': `${persistentRect.rect.x}px`,
        '--quick-toolbar-y': `${persistentRect.rect.y}px`,
        '--quick-toolbar-width': `${persistentRect.rect.width}px`,
        '--quick-toolbar-height': `${persistentRect.rect.height}px`,
        '--quick-toolbar-natural-width': `${natural.width}px`,
        '--quick-toolbar-natural-height': `${natural.height}px`,
        '--quick-toolbar-action-count': actions.length + 1,
      } as CSSProperties) : undefined}
    >
      {freePosition && (
        <button
          type="button"
          data-toolbar-drag-handle=""
          className={clsx(styles.dragHandle, vertical && styles.dragHandleVertical)}
          onPointerDown={(event) => beginExplicitDrag('move', event)}
          title="Move quick toolbar"
          aria-label="Move quick toolbar"
        >
          {vertical ? <GripVertical size={gripGlyph} /> : <GripHorizontal size={gripGlyph} />}
        </button>
      )}

      {anchored ? (
        <nav
          ref={toolbarRef}
          className={clsx(styles.toolbar, styles.toolbarAnchored, styles.cardStrip)}
          // On the element that carries `.cardStrip`, never on `.rootAnchored`:
          // every density rule is written `.cardStrip[data-density='compact'] …`.
          data-density={v2Density}
          data-fit={fitReady ? 'ready' : 'pending'}
          data-icon-only={v2IconOnly || undefined}
          aria-label="Quick access toolbar"
          style={toolbarStyle}
        >
          <div className={styles.cardScroller}>
            {visibleAnchoredActions.map((action) => (
              <span key={action.id} className={styles.cardSlot}>{renderV2Action(action)}</span>
            ))}
          </div>
          <div ref={measureRailRef} className={styles.measureRail} aria-hidden="true">
            {actions.map((action) => <span key={action.id}>{renderV2Action(action, true)}</span>)}
          </div>
          {overflowActionIds.length > 0 && (
            <button
              ref={overflowButtonRef}
              type="button"
              className={clsx(styles.item, styles.cardStripSettings, styles.overflowButton, overflowOpen && styles.itemActive)}
              onClick={() => setOverflowOpen((open) => !open)}
              title={`Show ${overflowActionIds.length} more toolbar actions`}
              aria-label={`Show ${overflowActionIds.length} more toolbar actions`}
              aria-controls="quick-toolbar-overflow"
              aria-expanded={overflowOpen}
            >
              <LayoutGrid size={renderedIconSize} aria-hidden="true" />
              <span>+{overflowActionIds.length}</span>
            </button>
          )}
          {customizeButton}
        </nav>
      ) : (
        <nav
          ref={toolbarRef}
          className={clsx(
            styles.toolbar,
            vertical ? styles.toolbarVertical : styles.toolbarHorizontal,
            // Applied for *every* free variant, so an unknown persisted value is
            // never left unstyled (A-M4).
            freePosition && styles.toolbarFree,
          )}
          aria-label="Quick access toolbar"
          style={toolbarStyle}
        >
          {actions.map((action) => {
            const Icon = action.icon
            const closable = action.surface.kind !== 'command'
            const active = closable && isSurfaceActive(action.surface, uiState)
            return (
              <button
                key={action.id}
                type="button"
                data-toolbar-action={action.id}
                className={clsx(styles.item, active && styles.itemActive)}
                style={{ flex: QUICK_TOOLBAR_CHILD_FLEX }}
                onClick={action.run}
                disabled={action.disabled}
                aria-pressed={closable ? active : undefined}
                title={action.label}
                aria-label={action.label}
              >
                <Icon size={renderedIconSize} aria-hidden="true" />
                {labelVisible && <span className={styles.itemLabel}>{action.label}</span>}
              </button>
            )
          })}
          {customizeButton}
        </nav>
      )}

      {overflowOpen && overflowPlacement && createPortal(
        <div
          ref={overflowPopoverRef}
          id="quick-toolbar-overflow"
          className={styles.overflowPopover}
          data-side={overflowPlacement.side}
          role="dialog"
          aria-labelledby="quick-toolbar-overflow-title"
          style={{
            left: overflowPlacement.left,
            top: overflowPlacement.top,
            width: overflowPlacement.width,
            maxHeight: overflowPlacement.maxHeight,
            '--quick-toolbar-overflow-list-height': `${Math.max(0, overflowPlacement.maxHeight - 94)}px`,
            '--quick-toolbar-caret': `${overflowPlacement.caret}px`,
          } as CSSProperties}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input')).filter((node) => !node.hasAttribute('disabled'))
            if (focusable.length === 0) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }}
        >
          <div className={styles.overflowHeader}>
            <strong id="quick-toolbar-overflow-title">Hidden actions</strong>
            <span>{overflowActionIds.length}</span>
          </div>
          <label className={styles.overflowSearch}>
            <Search size={14} aria-hidden="true" />
            <input
              ref={overflowSearchRef}
              value={overflowQuery}
              onChange={(event) => setOverflowQuery(event.target.value)}
              placeholder="Search actions"
              aria-label="Search hidden toolbar actions"
            />
          </label>
          <div className={styles.overflowList}>
            {filteredOverflowIds.map((id) => {
              const action = actionById.get(id)
              if (!action) return null
              const Icon = action.icon
              const context = cardContext[action.id]
              return (
                <div className={styles.overflowRow} key={id}>
                  <button type="button" className={styles.overflowAction} onClick={() => { action.run(); setOverflowOpen(false) }} title={context ? `${action.label} â€” ${context}` : action.label}>
                    <Icon size={16} aria-hidden="true" />
                    <span>
                      <strong>{action.label}</strong>
                      {context && <small>{context}</small>}
                    </span>
                  </button>
                  <button type="button" className={styles.overflowPin} onClick={() => pinOverflowAction(id)} title={`Pin ${action.label} to the toolbar`} aria-label={`Pin ${action.label} to the toolbar`}>
                    <Pin size={14} aria-hidden="true" />
                  </button>
                </div>
              )
            })}
            {filteredOverflowIds.length === 0 && <p className={styles.overflowEmpty}>No actions match that search.</p>}
          </div>
        </div>,
        document.body,
      )}

      {customizing && placement && createPortal(
        <div
          ref={customizerRef}
          className={styles.customizer}
          data-side={placement.side}
          style={{
            left: placement.left,
            top: placement.top,
            width: CUSTOMIZER_WIDTH,
            maxHeight: placement.maxHeight,
            '--quick-toolbar-caret': `${placement.caret}px`,
          } as CSSProperties}
          role="dialog"
          aria-label="Customize toolbar"
        >
          <div className={styles.customizerBody}>
            <div className={styles.customizerHeader}>
              <strong>Toolbar</strong>
              <button
                type="button"
                onClick={() => {
                  setCustomizing(false)
                  setModalOpen(true)
                }}
                title="Open the full customizer"
                aria-label="Open the full customizer"
              >
                <Maximize2 size={13} />
              </button>
            </div>

            <label>
              <span>Icon size</span>
              <output>{iconSize}px</output>
              <input
                type="range"
                min="16"
                max="36"
                value={iconSize}
                onChange={(event) => updateSettings(
                  anchored
                    ? { v2IconSize: Number(event.target.value) }
                    : { iconSize: Number(event.target.value) },
                )}
              />
            </label>
            <label>
              <span>Label size</span>
              <output>{labelTextSize}px</output>
              <input
                type="range"
                min="9"
                max="18"
                value={labelTextSize}
                onChange={(event) => updateSettings(
                  anchored
                    ? { v2LabelTextSize: Number(event.target.value) }
                    : { labelTextSize: Number(event.target.value) },
                )}
              />
            </label>
            <label className={styles.toggleRow}>
              <span>Show labels</span>
              <input
                type="checkbox"
                checked={labelVisible}
                onChange={(event) => updateSettings(
                  anchored
                    ? { v2LabelVisible: event.target.checked, v2IconOnly: !event.target.checked } as Partial<typeof settings>
                    : { labelVisible: event.target.checked },
                )}
              />
            </label>
            {anchored && (
              <label className={styles.toggleRow}>
                <span>Icon-only</span>
                <input
                  type="checkbox"
                  checked={v2IconOnly}
                  onChange={(event) => updateSettings({
                    v2IconOnly: event.target.checked,
                    v2LabelVisible: event.target.checked ? false : settings.v2LabelVisible,
                  } as Partial<typeof settings>)}
                />
              </label>
            )}
            {freePosition && (
              <label className={styles.toggleRow}>
                <span>Auto-fit toolbar bounds to content</span>
                <input
                  type="checkbox"
                  checked={autoFitBounds}
                  onChange={(event) => updateSettings({ autoFitBounds: event.target.checked } as Partial<typeof settings>)}
                />
              </label>
            )}
            <label>
              <span>Opacity</span>
              <output>{Math.round(settings.opacity * 100)}%</output>
              <input
                type="range"
                min="30"
                max="100"
                value={Math.round(settings.opacity * 100)}
                onChange={(event) => updateSettings({ opacity: Number(event.target.value) / 100 })}
              />
            </label>
            {freePosition && (
              <>
                <label className={styles.toggleRow}>
                  <span>Snap to edge</span>
                  <input
                    type="checkbox"
                    checked={settings.snapToEdge}
                    onChange={(event) => updateSettings({ snapToEdge: event.target.checked })}
                  />
                </label>
                <label className={styles.toggleRow}>
                  <span>Resize handles</span>
                  <input
                    type="checkbox"
                    checked={settings.resizeHandlesEnabled !== false}
                    onChange={(event) => updateSettings({ resizeHandlesEnabled: event.target.checked })}
                  />
                </label>
                <fieldset>
                  <legend>Orientation</legend>
                  <div className={styles.segmented}>
                    {(['horizontal', 'vertical'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={settings.orientation === option ? styles.segmentActive : undefined}
                        onClick={() => updateSettings({ orientation: option })}
                      >
                        {option === 'horizontal' ? 'Horizontal' : 'Vertical'}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label>
                  <span>Scale</span>
                  <output>{Math.round(settings.scale * 100)}%</output>
                  <input
                    type="range"
                    min="60"
                    max="160"
                    value={Math.round(settings.scale * 100)}
                    onChange={(event) => updateSettings({ scale: Number(event.target.value) / 100 })}
                  />
                </label>
                <label>
                  <span>Rotation</span>
                  <output>{settings.rotationDeg}°</output>
                  <input
                    type="range"
                    min="-180"
                    max="180"
                    value={settings.rotationDeg}
                    onChange={(event) => updateSettings({ rotationDeg: Number(event.target.value) })}
                  />
                </label>
              </>
            )}
            <fieldset>
              <legend>Enabled icons</legend>
              {/* Chrome cloned from the app's other search fields; the input
                  carries no class and is styled as `.searchField input`. */}
              <label className={styles.searchField}>
                <Search size={14} />
                <input
                  value={iconQuery}
                  onChange={(event) => setIconQuery(event.target.value)}
                  placeholder="Search icons..."
                  aria-label="Search icons"
                />
              </label>
              <div className={styles.actionList}>
                {filteredCatalogIds.map((id) => {
                  const action = actionCatalog.find((candidate) => candidate.id === id)
                  if (!action) return null
                  const Icon = action.icon
                  return (
                    <div key={id} className={styles.actionRow}>
                      <input type="checkbox" checked={visibleIds.includes(id)} onChange={() => toggleAction(id)} aria-label={action.label} />
                      <Icon size={15} />
                      <span>{action.label}</span>
                      {/* Filtered reorder: the chevron steps to the nearest
                          *visible* neighbour, so one click is always one visible
                          row. A pairwise swap would hop over a filtered-out id
                          and look like a dead button. `disabled` asks the same
                          resolver, so the two can never disagree. */}
                      <button
                        type="button"
                        disabled={!canMoveWithinFiltered(orderedIds, filteredEnabledIds, id, -1)}
                        onClick={() => moveActionWithin(id, -1, filteredEnabledIds)}
                        aria-label={`Move ${action.label} up`}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={!canMoveWithinFiltered(orderedIds, filteredEnabledIds, id, 1)}
                        onClick={() => moveActionWithin(id, 1, filteredEnabledIds)}
                        aria-label={`Move ${action.label} down`}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                  )
                })}
                {filteredCatalogIds.length === 0 && (
                  <p className={styles.actionEmpty}>No icons match that search.</p>
                )}
              </div>
            </fieldset>
            <button type="button" className={styles.resetButton} onClick={resetCurrentVariant}>
              <RotateCcw size={14} />
              Reset current variant
            </button>
          </div>
        </div>,
        document.body,
      )}

      {modalOpen && <QuickToolbarCustomizeModal onClose={() => setModalOpen(false)} />}

      {/* One switch for the handles *and* their blue hover dots, which are
          `::after` on `.resizeHandle`. The drag grip is deliberately unaffected:
          turning the handles off must not strand the toolbar where it sits. */}
      {freePosition && settings.resizeHandlesEnabled !== false && RESIZE_HANDLES.map((handle) => (
        <button
          key={handle}
          type="button"
          className={clsx(styles.resizeHandle, RESIZE_HANDLE_CLASS[handle])}
          data-toolbar-resize-handle={handle}
          aria-label={`Resize toolbar ${handle}`}
          onPointerDown={(event) => beginExplicitDrag(handle, event)}
        />
      ))}
    </div>
  )

  /*
   * U1b: the opt-in way back. Off by default, because at the toolbar's own
   * z-index this tab also floats over small `ModalShell` dialogs — a "Delete
   * this entry?" confirmation would get a toolbar tab pasted on it.
   */
  const restoreTab = (
    <button
      type="button"
      data-component="QuickToolbar"
      className={styles.modalRestoreHandle}
      onClick={() => setRestoredOverModal(true)}
      title="Show the quick toolbar"
      aria-label="Show the quick toolbar"
    >
      <SlidersHorizontal size={14} aria-hidden="true" />
    </button>
  )

  // QT-4, the stacking half: `.chatToolbar` is `z-index: 8` and creates a
  // stacking context, so the floating toolbar's own z-index could never lift it
  // above the composer — or above the Settings modal it opens, which is exactly
  // the "other menus get over it, and I can't press the button again" report.
  // It is `position: fixed` already, so the DOM parent contributed nothing but
  // the trap. V2 stays in flow, where the top dock is its layout.
  //
  // U1, the other half: at 10005 the toolbar also cleared `WorldBookEditorModal`
  // (10001) — the same literal `SettingsModal` uses, so no z-index can separate
  // them. It hides instead, and ONLY in this branch. V2 must never return `null`:
  // it is in flow, and `useDockHeightVar` measures the dock row it sits in into
  // `--lcs-top-dock-height`, so dropping it would reflow the chat column every
  // time any modal opened.
  if (docked) return tree
  if (shouldHideQuickToolbarWhenOverlaid({
    hideWhenOverlaid: settings.hideWhenOverlaid,
    isMobile,
    activeModal,
    settingsModalOpen,
    drawerOpen,
    characterEditorOpen,
    lorebookHalfEditorOpen,
    lorebookWorkspaceOpen,
  }) && !(activeModal && restoredOverModal)) {
    return settings.modalRestoreHandle === true
      && Boolean(activeModal)
      ? createPortal(restoreTab, document.body)
      : null
  }
  return createPortal(tree, document.body)
}
