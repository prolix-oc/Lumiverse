import { useRef, useCallback, useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { FloatWidgetState } from '@/store/slices/spindle-placement'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import ContextMenu, { type ContextMenuPos, type ContextMenuEntry } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
import { getLiveRootRecordExact } from '@/lib/spindle/live-root-registry'
import { scheduleSpindleDomTask } from '@/lib/spindle/browser-scheduler'
import { getUiScale, layoutViewportSize, toLayoutDelta } from '@/lib/uiScale'
import {
  FLOAT_WIDGET_VIEWPORT_PADDING,
  floatWidgetTransform,
  resolveFloatWidgetSize,
  resolveFloatWidgetStyle,
} from './spindle-float-widget-layout'
import styles from './SpindleFloatWidget.module.css'

interface Props {
  widget: FloatWidgetState
}

export default function SpindleFloatWidget({ widget }: Props) {
  const { t } = useTranslation('shared', { keyPrefix: 'spindle' })
  const updateFloatWidget = useStore((s) => s.updateFloatWidget)
  const setPlacementHidden = useStore((s) => s.setPlacementHidden)
  const isMobile = useIsMobile()

  const dragCleanup = useRef<(() => void) | null>(null)
  const suppressDragClick = useRef(false)
  const contentHostRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: widget.x, y: widget.y })
  const positionRef = useRef(pos)
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  const [viewport, setViewport] = useState(() => layoutViewportSize())

  const size = useMemo(() => resolveFloatWidgetSize(
    isMobile,
    { width: widget.width, height: widget.height },
    viewport,
  ), [isMobile, viewport, widget.height, widget.width])

  useEffect(() => {
    const updateViewport = () => {
      const next = layoutViewportSize()
      setViewport((prev) => prev.width === next.width && prev.height === next.height ? prev : next)
    }
    const observer = new MutationObserver(updateViewport)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', updateViewport)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  useEffect(() => {
    const pad = FLOAT_WIDGET_VIEWPORT_PADDING
    dragCleanup.current?.()
    const next = {
      x: Math.max(pad, Math.min(widget.x, viewport.width - size.width - pad)),
      y: Math.max(pad, Math.min(widget.y, viewport.height - size.height - pad)),
    }
    positionRef.current = next
    setPos(next)
  }, [size.height, size.width, viewport.height, viewport.width, widget.x, widget.y])

  useEffect(() => {
    const host = contentHostRef.current
    if (!host) return

    return scheduleSpindleDomTask(() => {
      if (!getLiveRootRecordExact(widget.extensionId, widget.root)) return
      if (!host.isConnected) return
      if (!host.contains(widget.root)) {
        host.replaceChildren(widget.root)
      }
    }, { phase: 'paint' })
  }, [widget.extensionId, widget.root])

  const clampPos = useCallback(
    (x: number, y: number) => {
      const pad = FLOAT_WIDGET_VIEWPORT_PADDING
      return {
        x: Math.max(pad, Math.min(x, viewport.width - size.width - pad)),
        y: Math.max(pad, Math.min(y, viewport.height - size.height - pad)),
      }
    },
    [size.width, size.height, viewport.height, viewport.width]
  )

  const snapToEdge = useCallback(
    (x: number, y: number) => {
      if (!widget.snapToEdge) return { x, y }
      const snapDist = 24
      const pad = FLOAT_WIDGET_VIEWPORT_PADDING
      const vw = viewport.width
      const vh = viewport.height
      let sx = x, sy = y
      if (x < snapDist) sx = pad
      else if (x + size.width > vw - snapDist) sx = vw - size.width - pad
      if (y < snapDist) sy = pad
      else if (y + size.height > vh - snapDist) sy = vh - size.height - pad
      return { x: sx, y: sy }
    },
    [widget.snapToEdge, size.width, size.height, viewport.height, viewport.width]
  )

  const isFullscreen = widget.fullscreen ?? false

  useEffect(() => () => { dragCleanup.current?.() }, [widget.visible, isFullscreen, widget.root])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isFullscreen || e.defaultPrevented || e.button !== 0 || (e.pointerType === 'touch' && !e.isPrimary)) return
    const interrupted = dragCleanup.current !== null
    dragCleanup.current?.()
    suppressDragClick.current = false
    // Editing/navigation gestures belong to the extension. Buttons and custom
    // click targets can still be dragged, but an ordinary press stays untouched.
    const surface = e.currentTarget
    if (interrupted) surface.style.transform = floatWidgetTransform(positionRef.current)
    for (const target of e.nativeEvent.composedPath()) {
      if (target === surface) break
      if (target instanceof Element && target.matches(
        'input, textarea, select, option, a[href], [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="textbox"], [data-spindle-float-resize-handle]',
      )) return
    }
    const pointerId = e.pointerId
    const startX = e.clientX, startY = e.clientY
    const scale = getUiScale()
    const start = positionRef.current
    let moved = false
    let position = start
    let frame = 0

    const paint = () => {
      frame = 0
      surface.style.transform = floatWidgetTransform(position)
    }

    const cleanup = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = 0
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', onBlur)
      surface.removeEventListener('lostpointercapture', onLostCapture)
      delete surface.dataset.dragging
      dragCleanup.current = null
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId)
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      const dx = event.clientX - startX, dy = event.clientY - startY
      // Slop is measured in rendered pixels, independently of UI zoom.
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return
        moved = true
        suppressDragClick.current = true
        surface.dataset.dragging = ''
        surface.setPointerCapture(pointerId)
      }
      const delta = toLayoutDelta(dx, dy, scale)
      position = clampPos(start.x + delta.x, start.y + delta.y)
      positionRef.current = position
      // Keep React, extension content, and document layout out of the drag's
      // frame loop. Multiple input events contribute only their latest point.
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    const finish = (event?: PointerEvent) => {
      if (event && event.pointerId !== pointerId) return
      cleanup()
      if (!moved) return
      if (event?.type === 'pointerup') {
        const delta = toLayoutDelta(event.clientX - startX, event.clientY - startY, scale)
        position = clampPos(start.x + delta.x, start.y + delta.y)
      }
      const snapped = snapToEdge(position.x, position.y)
      positionRef.current = snapped
      surface.style.transform = floatWidgetTransform(snapped)
      setPos(snapped)
      updateFloatWidget(widget.id, snapped)
      window.dispatchEvent(new CustomEvent('spindle:float-drag-end', {
        detail: { widgetId: widget.id, ...snapped },
      }))
    }
    const onBlur = () => finish()
    const onLostCapture = (event: PointerEvent) => {
      // Touch may transfer implicit capture from a child to the drag surface.
      if (event.target === surface) finish(event)
    }
    dragCleanup.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', onBlur)
    surface.addEventListener('lostpointercapture', onLostCapture)
  }, [isFullscreen, clampPos, snapToEdge, updateFloatWidget, widget.id])

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (!suppressDragClick.current || e.detail === 0) return
    suppressDragClick.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const longPress = useLongPress({
    onLongPress: (pos) => setContextMenu(pos),
  })

  // The extension owns its content area. If an inner element handled the
  // contextmenu event (either by opening a Spindle context menu via the store,
  // or by calling preventDefault), don't also raise the outer widget-chrome
  // menu — otherwise the less-specific chrome menu wins ownership over the
  // extension's own menu on the same right-click.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.defaultPrevented) return
    if (useStore.getState().pendingContextMenu) return
    longPress.onContextMenu(e)
  }, [longPress])

  const menuItems: ContextMenuEntry[] = useMemo(() => [
    {
      key: 'hide',
      label: t('hideWidget'),
      onClick: () => { setPlacementHidden(widget.id, true); setContextMenu(null) },
    },
    {
      key: 'reset',
      label: t('resetPosition'),
      onClick: () => {
        const pad = FLOAT_WIDGET_VIEWPORT_PADDING
        const resetWidth = widget.defaultWidth
        const resetHeight = widget.defaultHeight
        const bounds = layoutViewportSize()
        const reset = {
          x: Math.max(pad, Math.min(widget.defaultX, bounds.width - resetWidth - pad)),
          y: Math.max(pad, Math.min(widget.defaultY, bounds.height - resetHeight - pad)),
          width: resetWidth,
          height: resetHeight,
        }
        positionRef.current = { x: reset.x, y: reset.y }
        setPos(positionRef.current)
        updateFloatWidget(widget.id, reset)
        setContextMenu(null)
      },
    },
  ], [
    t,
    setPlacementHidden,
    updateFloatWidget,
    widget.defaultHeight,
    widget.defaultWidth,
    widget.defaultX,
    widget.defaultY,
    widget.id,
  ])

  if (!widget.visible) return null

  const widgetStyle = resolveFloatWidgetStyle(isFullscreen, pos, size)

  return (
    <>
      <div
        className={`${styles.widget}${widget.chromeless ? ` ${styles.chromeless}` : ''}${isFullscreen ? ` ${styles.fullscreen}` : ''}`}
        style={widgetStyle}
        title={widget.tooltip}
        onPointerDown={handlePointerDown}
        onClickCapture={handleClickCapture}
        {...longPress}
        onTouchStart={(e) => { if (!widget.root.contains(e.target as Node)) longPress.onTouchStart(e) }}
        onContextMenu={handleContextMenu}
      >
        <div className={styles.content} ref={contentHostRef} />
      </div>

      <ContextMenu
        position={contextMenu}
        items={menuItems}
        onClose={() => setContextMenu(null)}
      />
    </>
  )
}
