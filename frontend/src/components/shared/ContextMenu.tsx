import { useRef, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import styles from './ContextMenu.module.css'

export interface ContextMenuPos {
  x: number
  y: number
}

export interface ContextMenuItem {
  key: string
  label: string
  icon?: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  active?: boolean
}

export interface ContextMenuSection {
  key: string
  type: 'divider'
}

export interface ContextMenuCustom {
  key: string
  type: 'custom'
  content: ReactNode
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSection | ContextMenuCustom

interface ContextMenuProps {
  position: ContextMenuPos | null
  items: ContextMenuEntry[]
  onClose: () => void
}

function isDivider(e: ContextMenuEntry): e is ContextMenuSection {
  return 'type' in e && e.type === 'divider'
}

function isCustom(e: ContextMenuEntry): e is ContextMenuCustom {
  return 'type' in e && e.type === 'custom'
}

// Module-level registry of currently-open context menus. Opening a new menu
// closes all others so only one is ever visible, regardless of which widget
// owns the state (built-in widgets each manage their own `contextMenu` state,
// as do Spindle extensions).
const openMenus = new Map<symbol, () => void>()

export default function ContextMenu({ position, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const instanceIdRef = useRef<symbol>(null as unknown as symbol)
  if (instanceIdRef.current === null) instanceIdRef.current = Symbol('ContextMenu')

  // Keep the latest onClose accessible from the module-level registry without
  // re-running the open/close effect whenever an inline `() => setX(null)`
  // onClose prop gets a new identity.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Enforce the single-menu invariant. When this instance transitions to
  // visible, close every other registered menu and register ourselves. On
  // cleanup (position back to null or unmount), deregister.
  useEffect(() => {
    if (!position) return
    const me = instanceIdRef.current
    for (const [key, close] of Array.from(openMenus)) {
      if (key !== me) close()
    }
    openMenus.set(me, () => onCloseRef.current())
    return () => {
      openMenus.delete(me)
    }
  }, [position])

  // Dismiss on click outside, Escape, or scroll.
  // Listen on both mousedown and pointerdown because some elements (e.g.
  // Spindle float widgets) call preventDefault() on pointerdown which
  // suppresses the subsequent mousedown event.
  useEffect(() => {
    if (!position) return
    const handleDown = (e: MouseEvent | PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('pointerdown', handleDown)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('pointerdown', handleDown)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [position, onClose])

  // Clamp to viewport.
  //
  // Coordinate spaces under `body > * { zoom: var(--lumiverse-ui-scale) }`:
  //  - Mouse clientX/Y and window.innerWidth/Height are in raw viewport px.
  //  - CSS `top/left` are interpreted in the zoom's layout space (pre-zoom).
  //  - getBoundingClientRect() returns rendered (post-zoom) coords.
  // So layout_left × scale = rendered_left, and rect.width is already rendered.
  // To keep the menu inside the viewport we compute a new layout_left such
  // that its post-zoom right edge ≤ vw - 8.
  useLayoutEffect(() => {
    if (!position || !ref.current) return
    const el = ref.current
    const uiScale = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
    ) || 1
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (rect.right > vw - 8) {
      el.style.left = `${(vw - rect.width - 8) / uiScale}px`
    }
    if (rect.bottom > vh - 8) {
      el.style.top = `${(vh - rect.height - 8) / uiScale}px`
    }
  }, [position])

  if (!position) return null

  // Mouse coords are in raw viewport space; CSS `top/left` here are resolved
  // in the zoom's layout space. Divide by ui-scale so the rendered position
  // lines up with the click point at any UI scale.
  const uiScale = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
  ) || 1

  return createPortal(
    <div
      ref={ref}
      className={styles.contextMenu}
      style={{ top: position.y / uiScale, left: position.x / uiScale }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((entry) => {
        if (isDivider(entry)) {
          return <div key={entry.key} className={styles.divider} />
        }
        if (isCustom(entry)) {
          return <div key={entry.key} className={styles.custom}>{entry.content}</div>
        }
        return (
          <button
            key={entry.key}
            type="button"
            className={clsx(styles.item, entry.danger && styles.itemDanger, entry.active && styles.itemActive)}
            onClick={entry.onClick}
            disabled={entry.disabled}
          >
            {entry.icon}
            <span>{entry.label}</span>
          </button>
        )
      })}
    </div>,
    document.body
  )
}
