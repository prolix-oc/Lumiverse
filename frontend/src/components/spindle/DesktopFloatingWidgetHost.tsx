import { useEffect, useRef } from 'react'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { useStore } from '@/store'
import {
  desktopFloatingWidgetTarget,
  returnDesktopFloatingWidgetToPage,
  syncDesktopFloatingWidgetSize,
} from '@/lib/desktop-floating-widget'

const resizeHandles = [
  ['North', { top: -4, left: 10, right: 10, height: 8, cursor: 'n-resize' }],
  ['East', { top: 10, right: -4, bottom: 10, width: 8, cursor: 'e-resize' }],
  ['South', { bottom: -4, left: 10, right: 10, height: 8, cursor: 's-resize' }],
  ['West', { top: 10, bottom: 10, left: -4, width: 8, cursor: 'w-resize' }],
  ['NorthEast', { top: -4, right: -4, width: 14, height: 14, cursor: 'ne-resize' }],
  ['NorthWest', { top: -4, left: -4, width: 14, height: 14, cursor: 'nw-resize' }],
  ['SouthEast', { bottom: -4, right: -4, width: 14, height: 14, cursor: 'se-resize' }],
  ['SouthWest', { bottom: -4, left: -4, width: 14, height: 14, cursor: 'sw-resize' }],
] as const
const HEADER_HEIGHT = 30

export default function DesktopFloatingWidgetHost() {
  const target = desktopFloatingWidgetTarget!
  const nativeWindow = getCurrentWindow()
  const widgets = useStore((state) => state.floatWidgets)
  const updateFloatWidget = useStore((state) => state.updateFloatWidget)
  const widget = widgets.filter((entry) => entry.extensionId === target.extensionId && entry.visible)[target.index]
  const hostRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<typeof widget>(undefined)
  const seededWidgetId = useRef<string | undefined>(undefined)
  const requestedNativeSize = useRef<{ width: number; height: number } | null>(null)
  const isChromeless = widget?.chromeless ?? target.chromeless
  const hostChromeHeight = isChromeless ? 0 : HEADER_HEIGHT

  useEffect(() => {
    widgetRef.current = widget
  }, [widget])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !widget?.root) return
    if (!host.contains(widget.root)) host.replaceChildren(widget.root)

    // The widget root is the same DOM surface extension authors normally use
    // as their drag region. Mark that exact surface, rather than adding a
    // desktop-only wrapper or gesture, so nested controls and extension drag
    // handlers keep their expected event path.
    widget.root.setAttribute('data-tauri-drag-region', 'deep')
  }, [widget])

  // Float-widget handles update the placement store when their dimensions
  // change. Mirror that state to the native host so a SpotifyControls layout
  // update (or any other extension resize) changes the actual window bounds.
  useEffect(() => {
    if (!widget) return

    // A pop-out is a second frontend instance. Seed it from the live primary
    // placement dimensions before it can apply that instance's default size.
    if (seededWidgetId.current !== widget.id) {
      seededWidgetId.current = widget.id
      if (widget.width !== target.width || widget.height !== target.height) {
        updateFloatWidget(widget.id, { width: target.width, height: target.height })
        return
      }
    }

    const size = { width: widget.width, height: widget.height + hostChromeHeight }
    requestedNativeSize.current = size
    void nativeWindow.setSize(new LogicalSize(size.width, size.height))
    void syncDesktopFloatingWidgetSize(widget.id, widget.width, widget.height).catch(() => {
      // Browser/PWA clients and a window that is closing have no native peer.
    })
  }, [hostChromeHeight, nativeWindow, target.height, target.width, updateFloatWidget, widget?.height, widget?.id, widget?.width])

  // Native resizing happens outside React, so retain it in the placement
  // store. Without this, the next extension layout change restores the stale
  // dimensions that were present when the widget window opened.
  useEffect(() => {
    let disposed = false
    let frame: number | undefined
    let pendingSize: { width: number; height: number } | undefined
    let unlisten: (() => void) | undefined

    void nativeWindow.onResized(async ({ payload }) => {
      const scaleFactor = await nativeWindow.scaleFactor()
      if (disposed) return

      const logical = payload.toLogical(scaleFactor)
      pendingSize = { width: Math.round(logical.width), height: Math.round(logical.height) }
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const size = pendingSize
        pendingSize = undefined
        const current = widgetRef.current
        if (!size || !current) return

        const targetSize = requestedNativeSize.current
        if (targetSize && size.width === targetSize.width && size.height === targetSize.height) return

        const chromeHeight = current.chromeless ? 0 : HEADER_HEIGHT
        const width = Math.max(1, size.width)
        const height = Math.max(1, size.height - chromeHeight)
        if (width !== current.width || height !== current.height) {
          updateFloatWidget(current.id, { width, height })
        }
      })
    }).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })

    return () => {
      disposed = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      unlisten?.()
    }
  }, [nativeWindow, updateFloatWidget])

  // Extensions can run in this pop-out WebView as well as in the primary
  // frontend. Apply their explicit setSize request immediately here instead
  // of relying on the primary-window catalog round trip.
  useEffect(() => {
    if (!widget) return
    const handleSizeRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ widgetId?: unknown; width?: unknown; height?: unknown }>).detail
      if (
        !detail ||
        detail.widgetId !== widget.id ||
        typeof detail.width !== 'number' ||
        typeof detail.height !== 'number' ||
        !Number.isInteger(detail.width) ||
        !Number.isInteger(detail.height)
      ) return

      const width = Math.max(160, Math.min(1200, detail.width))
      const height = Math.max(100, Math.min(900, detail.height))
      const nativeSize = { width, height: height + hostChromeHeight }
      requestedNativeSize.current = nativeSize
      console.info('[desktop-widget] pop-out received size request', {
        widgetId: widget.id,
        width,
        height,
        nativeSize,
      })
      void nativeWindow.setSize(new LogicalSize(nativeSize.width, nativeSize.height))
        .then(() => console.info('[desktop-widget] pop-out applied size request', { widgetId: widget.id, nativeSize }))
        .catch((error) => console.warn('[desktop-widget] pop-out failed to apply size request', { widgetId: widget.id, nativeSize }, error))
      void syncDesktopFloatingWidgetSize(widget.id, width, height)
        .then(() => console.info('[desktop-widget] pop-out synchronized size request', { widgetId: widget.id, width, height }))
        .catch((error) => console.warn('[desktop-widget] pop-out failed to synchronize size request', { widgetId: widget.id, width, height }, error))
    }

    window.addEventListener('spindle:float-size-request', handleSizeRequest)
    return () => window.removeEventListener('spindle:float-size-request', handleSizeRequest)
  }, [hostChromeHeight, nativeWindow, widget?.id])

  return (
    <div
      onPointerDownCapture={(event) => {
        if (event.button === 0) {
          // A Tauri drag region consumes the native pointer-down before macOS
          // assigns key status. Focus this WebView first, so a drag or control
          // click never falls through to the minimized main window.
          void nativeWindow.setFocus().catch(() => {})
        }
      }}
      style={{
        position: 'relative',
        width: '100vw',
        minHeight: '100vh',
        overflow: isChromeless ? 'visible' : 'hidden',
        borderRadius: isChromeless ? 0 : 'var(--desktop-window-corner-radius, 12px)',
        background: isChromeless ? 'transparent' : 'var(--lumiverse-bg, #14121f)',
        color: 'var(--lumiverse-text, #fff)',
      }}
    >
      {!isChromeless && (
        <header
          onMouseDown={(event) => {
            if (event.button === 0 && !(event.target instanceof Element && event.target.closest('button'))) {
              void nativeWindow.startDragging()
            }
          }}
          style={{ height: HEADER_HEIGHT, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderBottom: '1px solid var(--lumiverse-border)', color: 'var(--lumiverse-text-muted)', cursor: 'grab', fontSize: 11, fontWeight: 650, userSelect: 'none' }}
        >
          <span aria-hidden="true">⠿</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{target.title}</span>
          <button
            type="button"
            aria-label="Return widget to page"
            title="Return to page"
            disabled={!widget}
            onClick={() => { if (widget) void returnDesktopFloatingWidgetToPage(widget.id) }}
            style={{ marginLeft: 'auto', border: 0, borderRadius: 5, background: 'transparent', color: 'inherit', cursor: widget ? 'pointer' : 'default', fontSize: 17, lineHeight: 1 }}
          >
            ↙
          </button>
        </header>
      )}
      <div ref={hostRef} style={{ width: '100%', minHeight: `calc(100vh - ${hostChromeHeight}px)` }}>
        {!widget && <p style={{ margin: 16, color: 'var(--lumiverse-text-muted)', fontSize: 12 }}>Loading {target.title}…</p>}
      </div>
      {resizeHandles.map(([direction, style]) => (
        <button
          key={direction}
          type="button"
          aria-label={`Resize from ${direction}`}
          onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            void nativeWindow.startResizeDragging(direction)
          }}
          style={{ position: 'absolute', zIndex: 10, padding: 0, border: 0, background: 'transparent', ...style }}
        />
      ))}
    </div>
  )
}
