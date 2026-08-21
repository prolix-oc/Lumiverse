import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  GripHorizontal,
  KeyRound,
  Pin,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { useStore } from '@/store'
import {
  DEFAULT_LORE_INDICATOR_SETTINGS,
  normalizeLoreIndicatorEntryTypeAppearance,
} from '@/lib/uiProductivityDefaults'
import { layoutElementSize, layoutViewportSize, toLayoutDelta } from '@/lib/zoomLayerGeometry'
import type { LoreIndicatorSettings } from '@/types/store'
import LoreIndicatorPanel, { openLoreEntry } from './LoreIndicatorPanel'
import {
  clampLoreFloatingPosition,
  clampLoreRect,
  formatCompactNumber,
  getConfiguredV4Items,
  getFloatingPanelPosition,
  matchesKeybind,
  type LoreItemId,
  type LorePoint,
  type LoreRect,
} from './utils'
import styles from './LoreIndicator.module.css'

const FLOATING_POSITION_KEY = 'lumiverse:lore-indicator:floating-position'
const V5_RECT_KEY = 'lumiverse:lore-indicator:v5-rect'

const ITEM_LABELS: Record<LoreItemId, string> = {
  'active-count': 'Active',
  'token-estimate': 'Tokens',
  passes: 'Passes',
  constant: 'Constant',
  keyword: 'Keyword',
  vector: 'Vector',
  lorebooks: 'Lorebooks',
  search: 'Search',
  grouping: 'Grouping',
}

/**
 * COORDINATE SPACE — read this before changing any number below.
 *
 * `theme/reset.css:187` applies `body > * { zoom: var(--lumiverse-ui-scale, 1) }`. V2's floating
 * root lives under `#root` and V5's palette is portalled to `document.body`; both are inside a
 * zoom layer, so two spaces are in play (see `@/lib/zoomLayerGeometry` for the measurements):
 *
 *   rendered px — `window.innerWidth/innerHeight`, `getBoundingClientRect()`, `event.clientX/Y`
 *   layout px   — `offsetWidth/offsetHeight`, and every `left/top/width/height` this file writes
 *                 into an inline `style` or persists to localStorage
 *
 * **This file speaks layout px throughout.** Rendered-px readings are converted at the boundary
 * they enter through and never again. Everything downstream — `floatingPosition`, `paletteRect`,
 * `viewport`, `compactPanelSize`, the two `localStorage` keys — is layout px.
 *
 * That is also why `layoutElementSize()` measures the trigger. This file used to read the *same*
 * element with `offsetWidth` in one place and `getBoundingClientRect()` in two others; those APIs
 * disagree by exactly the scale factor (measured: 72 vs 115.19 at scale 1.6), so the file
 * contradicted itself. `gBCR().width / scale === offsetWidth` at every scale, so one helper
 * serves all three sites. Do not "simplify" it back to either raw API.
 *
 * The pure helpers in `./utils` are unit-agnostic — they clamp in whatever space they are handed.
 * Do not push the conversion down into them.
 */

/** Size assumed for the V2/V5 trigger before it has been laid out. Layout px, like everything else. */
const FLOATING_FALLBACK_SIZE = { width: 72, height: 32 }

function readStoredPoint(): LorePoint {
  if (typeof window === 'undefined') return { x: 18, y: 96 }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FLOATING_POSITION_KEY) || '')
    return typeof parsed?.x === 'number' && typeof parsed?.y === 'number'
      ? parsed
      : { x: 18, y: 96 }
  } catch {
    return { x: 18, y: 96 }
  }
}

function readStoredPaletteRect(): LoreRect {
  const viewport = layoutViewportSize()
  const fallback = {
    width: Math.min(960, viewport.width - 32),
    height: Math.min(660, viewport.height - 32),
    x: Math.max(16, (viewport.width - Math.min(960, viewport.width - 32)) / 2),
    y: Math.max(16, (viewport.height - Math.min(660, viewport.height - 32)) / 2),
  }
  if (typeof window === 'undefined') return fallback
  try {
    const parsed = JSON.parse(window.localStorage.getItem(V5_RECT_KEY) || '')
    if (['x', 'y', 'width', 'height'].every((key) => typeof parsed?.[key] === 'number')) {
      return clampLoreRect(parsed, viewport)
    }
  } catch {
    // Use centered defaults.
  }
  return fallback
}

interface LoreIndicatorProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export default function LoreIndicator({ open: controlledOpen, onOpenChange }: LoreIndicatorProps = {}) {
  const entries = useStore((state) => state.activatedWorldInfo)
  const storedSettings = useStore((state) => state.loreIndicatorSettings)
  const settings = useMemo(() => ({
    ...storedSettings,
    entryTypeAppearance: normalizeLoreIndicatorEntryTypeAppearance(storedSettings.entryTypeAppearance),
  }), [storedSettings])
  const setSetting = useStore((state) => state.setSetting)
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = useCallback((next: SetStateAction<boolean>) => {
    if (controlledOpen === undefined) {
      setLocalOpen((current) => {
        const resolved = typeof next === 'function' ? next(current) : next
        onOpenChange?.(resolved)
        return resolved
      })
      return
    }
    const resolved = typeof next === 'function' ? next(controlledOpen) : next
    if (resolved !== controlledOpen) onOpenChange?.(resolved)
  }, [controlledOpen, onOpenChange])
  const [configOpen, setConfigOpen] = useState(false)
  const [viewport, setViewport] = useState(layoutViewportSize)
  const [floatingPosition, setFloatingPosition] = useState(readStoredPoint)
  const [paletteRect, setPaletteRect] = useState(readStoredPaletteRect)
  const floatingRef = useRef<HTMLDivElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const hoverCloseTimer = useRef<number | null>(null)
  const suppressCompactClick = useRef(false)

  const updateSettings = (patch: Partial<LoreIndicatorSettings>) => {
    setSetting('loreIndicatorSettings', { ...settings, ...patch })
  }

  useEffect(() => {
    const onResize = () => {
      const nextViewport = layoutViewportSize()
      setViewport(nextViewport)
      setFloatingPosition((point) => clampLoreFloatingPosition(
        point,
        layoutElementSize(floatingRef.current, FLOATING_FALLBACK_SIZE),
        nextViewport,
      ))
      setPaletteRect((rect) => clampLoreRect(rect, nextViewport))
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!settings.enabled || settings.variant !== 'v5-command-palette' || !settings.v5Keybind.trim()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeybind(event, settings.v5Keybind)) return
      event.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [setOpen, settings.enabled, settings.variant, settings.v5Keybind])

  useEffect(() => {
    if (!open) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [open, setOpen])

  useEffect(() => () => {
    if (hoverCloseTimer.current != null) window.clearTimeout(hoverCloseTimer.current)
  }, [])

  const clampFloating = useCallback((point: LorePoint) => clampLoreFloatingPosition(
    point,
    layoutElementSize(floatingRef.current, FLOATING_FALLBACK_SIZE),
    layoutViewportSize(),
  ), [])

  const beginFloatingDrag = (event: React.PointerEvent<HTMLButtonElement>, clickCompatible = false) => {
    if (!clickCompatible) event.preventDefault()
    const pointerStart = { x: event.clientX, y: event.clientY }
    const positionStart = floatingPosition
    let moved = false
    const onMove = (moveEvent: PointerEvent) => {
      const clientDx = moveEvent.clientX - pointerStart.x
      const clientDy = moveEvent.clientY - pointerStart.y
      // The 4px slop stays in rendered px on purpose: it asks whether the user's hand moved,
      // which is a physical question, not a layout one.
      if (!moved && Math.hypot(clientDx, clientDy) < 4) return
      moved = true
      if (clickCompatible) suppressCompactClick.current = true
      const delta = toLayoutDelta(clientDx, clientDy)
      setFloatingPosition(clampFloating({
        x: positionStart.x + delta.x,
        y: positionStart.y + delta.y,
      }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setFloatingPosition((point) => {
        const next = clampFloating(point)
        window.localStorage.setItem(FLOATING_POSITION_KEY, JSON.stringify(next))
        return next
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const cancelHoverClose = () => {
    if (hoverCloseTimer.current != null) {
      window.clearTimeout(hoverCloseTimer.current)
      hoverCloseTimer.current = null
    }
  }

  const scheduleHoverClose = () => {
    if (settings.v2ActivationMode !== 'hover') return
    cancelHoverClose()
    hoverCloseTimer.current = window.setTimeout(() => setOpen(false), 120)
  }

  if (!settings.enabled) return null

  const commonStyle = {
    '--lore-icon-size': `${settings.iconSize}px`,
    '--lore-text-size': `${settings.textSize}px`,
  } as React.CSSProperties

  // The V4 strip renders in place, as a plain child of whatever dock ChatView mounts
  // this component into. It deliberately knows nothing about that host.
  if (settings.variant === 'v4-bottom-strip') {
    return (
      <V4Strip
        style={commonStyle}
        settings={settings}
        open={open}
        configOpen={configOpen}
        setOpen={setOpen}
        setConfigOpen={setConfigOpen}
        updateSettings={updateSettings}
      />
    )
  }

  const compactAvailableHeight = Math.max(240, viewport.height - 24)
  const compactRowsPerColumn = Math.max(1, Math.floor((compactAvailableHeight - 71) / 24))
  const compactMaxColumns = Math.max(1, Math.floor((viewport.width - 24) / 240))
  const compactBookCount = settings.v2BookDisplay === 'grouped'
    ? new Set(entries.map((entry) => entry.bookName || entry.bookId)).size
    : 0
  const compactItemCount = entries.length + compactBookCount
  const compactColumns = Math.min(
    compactMaxColumns,
    Math.max(1, Math.ceil(compactItemCount / compactRowsPerColumn)),
  )
  const compactRows = Math.max(1, Math.ceil(compactItemCount / compactColumns))
  const compactPanelSize = {
    width: Math.min(viewport.width - 24, Math.max(360, compactColumns * 240)),
    height: Math.min(compactAvailableHeight, 71 + compactRows * 24),
  }
  const compactPanelPosition = getFloatingPanelPosition(
    floatingPosition,
    layoutElementSize(floatingRef.current, FLOATING_FALLBACK_SIZE),
    compactPanelSize,
    viewport,
  )

  return (
    <>
      <div
        ref={floatingRef}
        className={styles.floatingRoot}
        style={{ ...commonStyle, left: floatingPosition.x, top: floatingPosition.y }}
        data-variant={settings.variant}
      >
        {settings.variant !== 'v2-compact' && (
          <button type="button" className={styles.dragHandle} onPointerDown={beginFloatingDrag} aria-label="Move lore indicator">
            <GripHorizontal size={14} />
          </button>
        )}

        {settings.variant === 'v2-compact' ? (
          <div
            className={styles.v2Wrap}
            onMouseEnter={() => {
              cancelHoverClose()
              if (settings.v2ActivationMode === 'hover') setOpen(true)
            }}
            onMouseLeave={scheduleHoverClose}
          >
            <button
              type="button"
              className={styles.compactTrigger}
              onPointerDown={(event) => beginFloatingDrag(event, true)}
              onClick={() => {
                if (suppressCompactClick.current) {
                  suppressCompactClick.current = false
                  return
                }
                setOpen((value) => !value)
              }}
              title="Activated lore"
            >
              <BookOpen size={settings.iconSize} />
              <span>{entries.length}</span>
            </button>
          </div>
        ) : (
          <button type="button" className={styles.paletteTrigger} onClick={() => setOpen(true)} title={settings.v5Keybind || 'Open activated lore'}>
            <BookOpen size={settings.iconSize} />
            <span>{entries.length}</span>
          </button>
        )}
      </div>

      {open && settings.variant === 'v2-compact' && createPortal(
        <div
          className={styles.compactPopover}
          style={{
            ...commonStyle,
            left: compactPanelPosition.x,
            top: compactPanelPosition.y,
            width: compactPanelSize.width,
            height: compactPanelSize.height,
            '--compact-columns': compactColumns,
            '--compact-rows': compactRows,
          } as React.CSSProperties}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          <LoreIndicatorPanel
            mode="compact"
            onNavigate={() => setOpen(false)}
            onMovePointerDown={beginFloatingDrag}
            onHide={() => setOpen(false)}
          />
        </div>,
        document.body,
      )}

      {open && settings.variant === 'v5-command-palette' && createPortal(
        <div className={styles.paletteLayer}>
          <div
            ref={paletteRef}
            className={styles.paletteDialog}
            style={{
              ...commonStyle,
              left: paletteRect.x,
              top: paletteRect.y,
              width: paletteRect.width,
              height: paletteRect.height,
            }}
          >
            <div
              className={styles.paletteDragBar}
              onPointerDown={(event) => beginPaletteDrag(event, paletteRect, setPaletteRect)}
            >
              <GripHorizontal size={15} />
              <span>Activated Lore</span>
              <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setOpen(false)} aria-label="Close lore command palette">
                <X size={17} />
              </button>
            </div>
            <div className={styles.paletteContent}>
              <LoreIndicatorPanel mode="palette" onNavigate={() => setOpen(false)} />
            </div>
            <button
              type="button"
              className={styles.resizeHandle}
              aria-label="Resize lore command palette"
              onPointerDown={(event) => beginPaletteResize(event, paletteRect, setPaletteRect)}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function persistPaletteRect(rect: LoreRect) {
  window.localStorage.setItem(V5_RECT_KEY, JSON.stringify(rect))
}

function beginPaletteDrag(
  event: React.PointerEvent<HTMLDivElement>,
  startRect: LoreRect,
  setRect: React.Dispatch<React.SetStateAction<LoreRect>>,
) {
  if ((event.target as HTMLElement).closest('button')) return
  event.preventDefault()
  const start = { x: event.clientX, y: event.clientY }
  const onMove = (moveEvent: PointerEvent) => {
    const delta = toLayoutDelta(moveEvent.clientX - start.x, moveEvent.clientY - start.y)
    setRect(clampLoreRect({
      ...startRect,
      x: startRect.x + delta.x,
      y: startRect.y + delta.y,
    }, layoutViewportSize()))
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    setRect((rect) => {
      const next = clampLoreRect(rect, layoutViewportSize())
      persistPaletteRect(next)
      return next
    })
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function beginPaletteResize(
  event: React.PointerEvent<HTMLButtonElement>,
  startRect: LoreRect,
  setRect: React.Dispatch<React.SetStateAction<LoreRect>>,
) {
  event.preventDefault()
  const start = { x: event.clientX, y: event.clientY }
  const onMove = (moveEvent: PointerEvent) => {
    const delta = toLayoutDelta(moveEvent.clientX - start.x, moveEvent.clientY - start.y)
    setRect(clampLoreRect({
      ...startRect,
      width: startRect.width + delta.x,
      height: startRect.height + delta.y,
    }, layoutViewportSize()))
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    setRect((rect) => {
      const next = clampLoreRect(rect, layoutViewportSize())
      persistPaletteRect(next)
      return next
    })
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function V4Strip({
  style,
  settings,
  open,
  configOpen,
  setOpen,
  setConfigOpen,
  updateSettings,
}: {
  style?: React.CSSProperties
  settings: LoreIndicatorSettings
  open: boolean
  configOpen: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  setConfigOpen: React.Dispatch<React.SetStateAction<boolean>>
  updateSettings: (patch: Partial<LoreIndicatorSettings>) => void
}) {
  const entries = useStore((state) => state.activatedWorldInfo)
  const stats = useStore((state) => state.worldInfoStats)

  const counts = useMemo(() => ({
    constant: entries.filter((entry) => entry.activationType === 'constant').length,
    keyword: entries.filter((entry) => entry.activationType === 'keyword').length,
    vector: entries.filter((entry) => entry.activationType === 'vector').length,
    lorebooks: new Set(entries.map((entry) => entry.bookId)).size,
  }), [entries])

  const values: Record<LoreItemId, string> = {
    'active-count': String(entries.length),
    'token-estimate': formatCompactNumber(stats?.estimatedTokens ?? 0),
    passes: String(stats?.recursionPassesUsed ?? 0),
    constant: String(counts.constant),
    keyword: String(counts.keyword),
    vector: String(counts.vector),
    lorebooks: String(counts.lorebooks),
    search: '',
    grouping: '',
  }
  const icons: Record<LoreItemId, React.ReactNode> = {
    'active-count': <BookOpen />,
    'token-estimate': <span>#</span>,
    passes: <span aria-hidden="true">△</span>,
    constant: <Pin />,
    keyword: <KeyRound />,
    vector: <Search />,
    lorebooks: <BookOpen />,
    search: <Search />,
    grouping: <span aria-hidden="true">≡</span>,
  }
  const items = getConfiguredV4Items(settings).filter((item) => item.visible && !item.removed)
  const activationForItem = (id: LoreItemId) =>
    id === 'constant' || id === 'keyword' || id === 'vector' ? id : undefined

  return (
    <div className={styles.composerRoot} style={style}>
      <div className={styles.strip} style={{ gap: settings.v4Spacing }}>
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={styles.stripItem}
            data-activation={activationForItem(item.id as LoreItemId)}
            onClick={() => setOpen((value) => !value)}
            title={`${values[item.id as LoreItemId]} ${ITEM_LABELS[item.id as LoreItemId]}`.trim()}
          >
            {icons[item.id as LoreItemId]}
            {item.mode === 'iconText' && <span>{values[item.id as LoreItemId]} {ITEM_LABELS[item.id as LoreItemId]}</span>}
          </button>
        ))}
        <button type="button" className={styles.stripItem} onClick={() => setConfigOpen((value) => !value)} title="Configure lore indicator">
          <Settings2 />
        </button>
        <button type="button" className={styles.stripItem} onClick={() => setOpen((value) => !value)} title="Toggle activated lore">
          <ChevronDown className={open ? styles.chevronOpen : undefined} />
        </button>
      </div>

      {/* Both popovers are absolutely positioned siblings of the strip, opening upward
          inside this root. Nothing crosses the `body > * { zoom }` boundary, so there is
          no UI-scale drift to compensate for. */}
      {open && (
        <div className={styles.v4PanelPopover}>
          <LoreIndicatorPanel
            mode="expanded"
            activateOnClick
            groupBy={settings.v4GroupBy ?? 'lorebook'}
            previewCount={settings.v4BookPreviewCount ?? 4}
            onOpenFullView={(entry) => {
              setOpen(false)
              if (entry) {
                openLoreEntry(entry)
                return
              }
              useStore.getState().openDrawer('lorebook')
            }}
          />
        </div>
      )}

      {configOpen && (
        <div className={styles.v4ConfigPopover}>
          <LoreIndicatorConfig settings={settings} updateSettings={updateSettings} onClose={() => setConfigOpen(false)} />
        </div>
      )}
    </div>
  )
}

function LoreIndicatorConfig({
  settings,
  updateSettings,
  onClose,
}: {
  settings: LoreIndicatorSettings
  updateSettings: (patch: Partial<LoreIndicatorSettings>) => void
  onClose: () => void
}) {
  const items = getConfiguredV4Items(settings)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const patchItems = (nextItems: typeof items) => updateSettings({
    v4Items: nextItems.map((item, order) => ({ ...item, order })),
  })
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    patchItems(next)
  }
  const dropBefore = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return
    const next = items.filter((item) => item.id !== draggedId)
    const dragged = items.find((item) => item.id === draggedId)
    const targetIndex = next.findIndex((item) => item.id === targetId)
    if (!dragged || targetIndex < 0) return
    next.splice(targetIndex, 0, dragged)
    patchItems(next)
    setDraggedId(null)
  }

  return (
    <div className={styles.config}>
      <div className={styles.configHeader}><strong>Lore Indicator</strong><button type="button" onClick={onClose}><X size={15} /></button></div>
      <label>Item spacing <input type="range" min="2" max="24" value={settings.v4Spacing} onChange={(event) => updateSettings({ v4Spacing: Number(event.target.value) })} /></label>
      <label>
        Group entries by
        <select
          value={settings.v4GroupBy ?? 'lorebook'}
          onChange={(event) => updateSettings({ v4GroupBy: event.target.value as LoreIndicatorSettings['v4GroupBy'] })}
        >
          <option value="lorebook">Lorebook</option>
          <option value="type">Activation type</option>
          <option value="none">No grouping</option>
        </select>
      </label>
      <label>
        Entries before “more”
        <input
          type="number"
          min="1"
          max="50"
          value={settings.v4BookPreviewCount ?? 4}
          onChange={(event) => updateSettings({ v4BookPreviewCount: Math.max(1, Number(event.target.value) || 1) })}
        />
      </label>
      <div className={styles.configItems}>
        {items.map((item, index) => (
          <div
            key={item.id}
            className={styles.configItem}
            draggable
            onDragStart={() => setDraggedId(item.id)}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => dropBefore(item.id)}
          >
            <input
              type="checkbox"
              checked={item.visible && !item.removed}
              onChange={(event) => patchItems(items.map((current) => current.id === item.id ? { ...current, visible: event.target.checked, removed: false } : current))}
            />
            <span>{ITEM_LABELS[item.id as LoreItemId]}</span>
            <select value={item.mode} onChange={(event) => patchItems(items.map((current) => current.id === item.id ? { ...current, mode: event.target.value as 'icon' | 'iconText' } : current))}>
              <option value="iconText">Icon + text</option>
              <option value="icon">Icon only</option>
            </select>
            <button type="button" onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp size={12} /></button>
            <button type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1}><ArrowDown size={12} /></button>
            <button type="button" onClick={() => patchItems(items.map((current) => current.id === item.id ? { ...current, removed: true, visible: false } : current))}>Remove</button>
          </div>
        ))}
      </div>
      <div className={styles.resetRow}>
        <button
          type="button"
          onClick={() => updateSettings({
            v4Items: DEFAULT_LORE_INDICATOR_SETTINGS.v4Items.map((item) => ({ ...item })),
            v4Spacing: DEFAULT_LORE_INDICATOR_SETTINGS.v4Spacing,
            v4GroupBy: DEFAULT_LORE_INDICATOR_SETTINGS.v4GroupBy,
            v4BookPreviewCount: DEFAULT_LORE_INDICATOR_SETTINGS.v4BookPreviewCount,
          })}
        >
          Reset strip
        </button>
      </div>
    </div>
  )
}
