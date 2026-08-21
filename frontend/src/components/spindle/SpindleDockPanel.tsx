import { useRef, useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X } from 'lucide-react'
import type { DockPanelState } from '@/store/slices/spindle-placement'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { resolveDockPanelEdge } from '@/lib/spindle/dock-placement'
import { getLiveRootRecordExact } from '@/lib/spindle/live-root-registry'
import { scheduleSpindleDomTask } from '@/lib/spindle/browser-scheduler'
import styles from './SpindleDockPanel.module.css'
import clsx from 'clsx'

interface Props {
  panel: DockPanelState
}

const RESIZE_CLASS_BY_EDGE = {
  left: styles.resizeLeft,
  right: styles.resizeRight,
  top: styles.resizeTop,
  bottom: styles.resizeBottom,
} as const

export default function SpindleDockPanel({ panel }: Props) {
  const { t: tc } = useTranslation('common')
  const updateDockPanel = useStore((s) => s.updateDockPanel)
  const unregisterDockPanel = useStore((s) => s.unregisterDockPanel)
  const dockPanelDesktopSide = useStore((s) => s.spindleSettings.dockPanelDesktopSide)
  const isMobile = useIsMobile()

  const [currentSize, setCurrentSize] = useState(panel.size)
  const [isResizing, setIsResizing] = useState(false)
  const currentSizeRef = useRef(panel.size)
  const resizing = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(panel.size)
  const contentHostRef = useRef<HTMLDivElement | null>(null)

  const effectiveEdge = resolveDockPanelEdge(
    panel.edge,
    dockPanelDesktopSide,
    isMobile,
    panel.respectRequestedEdge,
  )
  const effectiveHorizontal = effectiveEdge === 'left' || effectiveEdge === 'right'

  const handleToggle = useCallback(() => {
    updateDockPanel(panel.id, { collapsed: !panel.collapsed })
  }, [updateDockPanel, panel.id, panel.collapsed])

  const handleClose = useCallback(() => {
    unregisterDockPanel(panel.id)
  }, [unregisterDockPanel, panel.id])

  const commitResize = useCallback(
    (requestedSize: number) => {
      const size = Math.max(panel.minSize, Math.min(panel.maxSize, requestedSize))
      currentSizeRef.current = size
      setCurrentSize(size)
      window.dispatchEvent(
        new CustomEvent('spindle:dock-resize-end', {
          detail: { panelId: panel.id, size },
        }),
      )
    },
    [panel.id, panel.minSize, panel.maxSize],
  )

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!panel.resizable) return
      resizing.current = true
      setIsResizing(true)
      startPos.current = effectiveHorizontal ? e.clientX : e.clientY
      startSize.current = currentSizeRef.current
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
    },
    [panel.resizable, effectiveHorizontal],
  )

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizing.current) return
      const delta = effectiveHorizontal
        ? (effectiveEdge === 'left' ? e.clientX - startPos.current : startPos.current - e.clientX)
        : (effectiveEdge === 'top' ? e.clientY - startPos.current : startPos.current - e.clientY)
      const newSize = Math.max(panel.minSize, Math.min(panel.maxSize, startSize.current + delta))
      currentSizeRef.current = newSize
      setCurrentSize(newSize)
    },
    [effectiveHorizontal, effectiveEdge, panel.minSize, panel.maxSize],
  )

  const handleResizePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizing.current) return
      resizing.current = false
      setIsResizing(false)

      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }

      commitResize(currentSizeRef.current)
    },
    [commitResize],
  )

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null

      switch (e.key) {
        case 'ArrowLeft':
          if (!effectiveHorizontal) return
          next = currentSizeRef.current + (effectiveEdge === 'right' ? 24 : -24)
          break
        case 'ArrowRight':
          if (!effectiveHorizontal) return
          next = currentSizeRef.current + (effectiveEdge === 'left' ? 24 : -24)
          break
        case 'ArrowUp':
          if (effectiveHorizontal) return
          next = currentSizeRef.current + (effectiveEdge === 'bottom' ? 24 : -24)
          break
        case 'ArrowDown':
          if (effectiveHorizontal) return
          next = currentSizeRef.current + (effectiveEdge === 'top' ? 24 : -24)
          break
        case 'Home':
          next = panel.minSize
          break
        case 'End':
          next = panel.maxSize
          break
        default:
          return
      }

      e.preventDefault()
      commitResize(next)
    },
    [commitResize, effectiveEdge, effectiveHorizontal, panel.minSize, panel.maxSize],
  )

  useEffect(() => {
    if (resizing.current) return
    currentSizeRef.current = panel.size
    setCurrentSize(panel.size)
  }, [panel.size])

  useEffect(() => {
    const host = contentHostRef.current
    if (!host || panel.collapsed) return

    return scheduleSpindleDomTask(() => {
      if (!getLiveRootRecordExact(panel.extensionId, panel.root)) return
      if (!host.isConnected) return
      if (!host.contains(panel.root)) {
        host.replaceChildren(panel.root)
      }
    }, { phase: 'paint' })
  }, [panel.collapsed, panel.extensionId, panel.root])

  const CollapseIcon = (() => {
    if (panel.collapsed) {
      switch (effectiveEdge) {
        case 'left': return ChevronRight
        case 'right': return ChevronLeft
        case 'top': return ChevronDown
        case 'bottom': return ChevronUp
      }
    }
    switch (effectiveEdge) {
      case 'left': return ChevronLeft
      case 'right': return ChevronRight
      case 'top': return ChevronUp
      case 'bottom': return ChevronDown
    }
  })()

  const sizeStyle = panel.collapsed
    ? {}
    : effectiveHorizontal
      ? { width: currentSize }
      : { height: isMobile ? Math.min(currentSize, window.innerHeight * 0.6) : currentSize }

  return (
    <div
      className={clsx(
        styles.panel,
        styles[effectiveEdge],
        panel.collapsed && styles.collapsed,
        isResizing && styles.resizing,
      )}
      style={sizeStyle}
    >
      <div className={styles.header}>
        <button
          className={styles.headerBtn}
          onClick={handleToggle}
          title={panel.collapsed ? 'Expand' : 'Collapse'}
        >
          <CollapseIcon size={14} />
        </button>
        {(!panel.collapsed || panel.showCollapsedTitle) && (
          <span className={styles.title}>{panel.title}</span>
        )}
        {!panel.collapsed && (
          <button className={styles.headerBtn} onClick={handleClose} title={tc('actions.close')}>
            <X size={14} />
          </button>
        )}
      </div>

      {!panel.collapsed && (
        <>
          <div className={styles.content} ref={contentHostRef} />

          {panel.resizable && (
            <div
              className={clsx(styles.resizeHandle, RESIZE_CLASS_BY_EDGE[effectiveEdge])}
              role="separator"
              aria-orientation={effectiveHorizontal ? 'vertical' : 'horizontal'}
              aria-label={panel.title}
              aria-valuemin={panel.minSize}
              aria-valuemax={panel.maxSize}
              aria-valuenow={Math.round(currentSize)}
              tabIndex={0}
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerEnd}
              onPointerCancel={handleResizePointerEnd}
              onKeyDown={handleResizeKeyDown}
            />
          )}
        </>
      )}
    </div>
  )
}
