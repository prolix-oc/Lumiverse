import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ResizablePanelFrame } from '@/components/shared/ResizablePanelFrame'
import {
  DEFAULT_MIN_CHAT_WIDTH,
  DEFAULT_MIN_EDITOR_PANE_WIDTH,
  resolveHalfEditorLayout,
} from '@/lib/lorebookEditorGeometry'
import { getUiScale as readUiScale } from '@/lib/uiScale'
import type { SurfaceRectPrefs } from '@/types/store'
import LorebookEditorWorkspace from './LorebookEditorWorkspace'
import { useLorebookEditorLayoutSettings } from './useLorebookEditorLayoutSettings'
import styles from './LorebookHalfScreenEditor.module.css'

/**
 * Measures the row the docked editor actually shares with the chat, in layout px.
 *
 * Three things were wrong with the `window.innerWidth` listener this replaces:
 *
 *  1. `window.innerWidth` is the *viewport*, not the row. `.app` reserves the
 *     spindle dock insets (`App.module.css`), so the row is already narrower.
 *  2. It is device px. Under `body > * { zoom: var(--lumiverse-ui-scale) }` the
 *     row's layout width is `viewport / scale`, so at scale 1.25 the clamp was
 *     comparing a number 25% too large against a layout-px width — it permitted
 *     exactly the overrun it existed to prevent.
 *  3. A `resize` listener never fires for a portrait panel opening or a spindle
 *     dock appearing, both of which change the row without changing the window.
 *
 * The observed box is deliberately **`.chatColumn` + the host**, not `.body`:
 * `.body` also contains the portrait side panels and `PortraitDock`
 * (`ChatView.tsx`), which are siblings of both and are never subtracted, so
 * measuring `.body` would let the editor eat the chat's reservation whenever a
 * portrait panel was open.
 *
 * `getBoundingClientRect() / readUiScale()` rather than `entry.contentBoxSize`:
 * whether `contentBoxSize` reports pre- or post-`zoom` units is not something this
 * codebase has verified, and guessing wrong reproduces the bug at every UI scale
 * other than 1 while passing every test at scale 1.
 *
 * The sum cannot oscillate. The chat column is `flex: 1 1 auto` and the host
 * `flex: 0 1 auto`, so the two always partition the same row: changing the host's
 * width moves pixels between the two terms and leaves the total identical.
 */
export function findHalfEditorChatColumn(host: HTMLElement): HTMLElement | null {
  let parent = host.parentElement
  while (parent) {
    const chatColumn = parent.querySelector<HTMLElement>('[data-lumiverse-surface="chat-column"]')
    if (chatColumn) return chatColumn
    parent = parent.parentElement
  }
  return null
}

export function measureHalfEditorRowWidth(
  host: HTMLElement,
  chatColumn: HTMLElement | null,
  scale: number,
): number {
  const normalizedScale = scale || 1
  const hostWidth = host.getBoundingClientRect().width
  const chatWidth = chatColumn?.getBoundingClientRect().width ?? 0
  return Math.round((hostWidth + chatWidth) / normalizedScale)
}

function useRowWidth(
  hostRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): number {
  const [rowWidth, setRowWidth] = useState(0)

  useEffect(() => {
    if (!active) return
    const host = hostRef.current
    if (!host) return
    // ChatView tags the column `data-lumiverse-surface="chat-column"` precisely so
    // this lookup does not depend on sibling order: its class name is
    // CSS-Module-hashed and therefore unqueryable, and matching on
    // `previousElementSibling` alone breaks silently the moment anyone reorders
    // `.body`'s children. The climb is required because the extension mount root
    // and the per-surface React root remain real DOM ancestors even when their CSS
    // uses `display: contents`. `previousElementSibling` remains a legacy fallback.
    const chatColumn = findHalfEditorChatColumn(host)
      ?? (host.previousElementSibling instanceof HTMLElement ? host.previousElementSibling : null)

    const measure = () => {
      setRowWidth(measureHalfEditorRowWidth(host, chatColumn, readUiScale()))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    if (chatColumn) observer.observe(chatColumn)
    return () => observer.disconnect()
  }, [active, hostRef])

  return rowWidth
}

export interface LorebookHalfScreenEditorProps {
  readonly open: boolean
  readonly bookId?: string | null
  readonly entryId?: string | null
  readonly forceHalfScreen?: boolean
  readonly onClose: () => void
  readonly onOpenFullEditor: (bookId: string | null, entryId: string | null) => void
}

export default function LorebookHalfScreenEditor({
  open,
  bookId = null,
  entryId = null,
  forceHalfScreen = false,
  onClose,
  onOpenFullEditor,
}: LorebookHalfScreenEditorProps) {
  // Only consumed by the <=900px full-bleed rule. At that width this host takes
  // the whole viewport at a rung above the floating toolbar (10006), which puts it
  // above the modal layer too — `onOpenFullEditor` promotes this pane to the
  // extension-owned enhanced workspace. Wide layouts deliberately keep rendering:
  // this pane shares a flex row with the message list, and collapsing it would
  // reflow (and re-anchor) that list behind the backdrop.
  const { settings, updateSettings } = useLorebookEditorLayoutSettings()
  const hostRef = useRef<HTMLElement | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => {
    dragCleanupRef.current?.()
    dragCleanupRef.current = null
  }, [])

  const floating = !forceHalfScreen && settings.halfEditorMode === 'floating'
  const minChatWidth = settings.minChatWidth ?? DEFAULT_MIN_CHAT_WIDTH
  const minEditorWidth = settings.minEditorPaneWidth ?? DEFAULT_MIN_EDITOR_PANE_WIDTH

  // The rendered width is derived, so a resize only needs to trigger a re-render.
  // Persisting the clamped value here would quietly shrink the remembered width
  // whenever the editor was opened in a narrow window: a drag is stored *intent*
  // and only a drag may overwrite it.
  const rowWidth = useRowWidth(hostRef, open && !floating)

  const commitWidth = useCallback((width: number) => {
    if (settings.halfRect.width === width) return
    updateSettings({ halfRect: { ...settings.halfRect, width } })
  }, [settings.halfRect, updateSettings])

  const commitRect = useCallback((halfRect: SurfaceRectPrefs) => {
    updateSettings({ halfRect })
  }, [updateSettings])

  if (!open) return null

  const workspace = (
    <LorebookEditorWorkspace
      variant="half"
      initialBookId={bookId}
      initialEntryId={entryId}
      onClose={onClose}
      onOpenFullEditor={onOpenFullEditor}
    />
  )

  if (floating) {
    // Free-floating mode reads the whole `halfRect`, which is what makes the
    // height/X/Y settings mean something. `usePersistentRect` inside the frame is
    // already scale-aware, so there is deliberately no zoom compensation here.
    return (
      <ResizablePanelFrame
        rect={settings.halfRect}
        bounds={{ minWidth: minEditorWidth, minHeight: 260 }}
        onCommit={commitRect}
        showHeader={false}
        aria-label="Lorebook editor"
        className={styles.halfFloatingFrame}
      >
        {workspace}
      </ResizablePanelFrame>
    )
  }

  // A remembered width from a wider window must never push the host past the row —
  // that clipped the editor against both viewport edges. Below
  // `minChatWidth + minEditorPaneWidth` the row cannot hold both, so the editor
  // says so (`overlay`) instead of silently squeezing chat to a sliver.
  const availableWidth = rowWidth || settings.halfRect.width + minChatWidth
  const defaultHalfWidth = Math.max(1, Math.round(availableWidth / 2))
  const requestedWidth = forceHalfScreen && settings.halfRect.width === 720
    ? defaultHalfWidth
    : settings.halfRect.width
  const layout = resolveHalfEditorLayout({
    requestedWidth,
    availableWidth,
    minChatWidth: forceHalfScreen ? 0 : minChatWidth,
    minEditorWidth,
  })

  return (
    <aside
      ref={hostRef}
      className={styles.halfScreenHost}
      data-layout={layout.mode}
      data-force-half-screen={forceHalfScreen || undefined}
      style={{
        '--lorebook-half-width': `${layout.width}px`,
        '--lorebook-min-chat-width': `${forceHalfScreen ? 0 : minChatWidth}px`,
      } as CSSProperties}
      data-component="LorebookHalfScreenEditor"
    >
      <div
        className={styles.halfResizeHandle}
        role="separator"
        aria-label="Resize lorebook editor"
        onPointerDown={(event) => {
          event.preventDefault()
          dragCleanupRef.current?.()
          const startX = event.clientX
          const startWidth = layout.width
          const move = (moveEvent: PointerEvent) => {
            // `clientX` is device px while `startWidth` is layout px, so only the
            // *delta* may be added — and only after the `body > *` zoom is divided
            // out, or the handle travels `scale`x the cursor.
            const scale = readUiScale() || 1
            const requestedWidth = startWidth + (startX - moveEvent.clientX) / scale
            // Only a live drag may persist a clamp: this is the one place a width
            // is the user's intent rather than a consequence of the window size.
            commitWidth(resolveHalfEditorLayout({
              requestedWidth,
              availableWidth: rowWidth || requestedWidth + minChatWidth,
              minChatWidth,
              minEditorWidth,
            }).width)
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            hostRef.current?.removeEventListener('pointercancel', up)
            if (dragCleanupRef.current === up) dragCleanupRef.current = null
          }
          dragCleanupRef.current = up
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          hostRef.current?.addEventListener('pointercancel', up)
        }}
      />
      {workspace}
    </aside>
  )
}
