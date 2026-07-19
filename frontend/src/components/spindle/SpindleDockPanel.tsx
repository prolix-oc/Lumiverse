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

export default function SpindleDockPanel({ panel }: Props) {
  const { t: tc } = useTranslation('common')
  const updateDockPanel = useStore((s) => s.updateDockPanel)
  const unregisterDockPanel = useStore((s) => s.unregisterDockPanel)
  const dockPanelDesktopSide = useStore((s) => s.spindleSettings.dockPanelDesktopSide)
  const isMobile = useIsMobile()

  const [currentSize, setCurrentSize] = useState(panel.size)
  const resizing = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(panel.size)
  const contentHostRef = useRef<HTMLDivElement | null>(null)

  const effectiveEdge = resolveDockPanelEdge(panel.edge, dockPanelDesktopSide, isMobile)
  const effectiveHorizontal = effectiveEdge === 'left' || effectiveEdge === 'right'

  const handleToggle = useCallback(() => {
    updateDockPanel(panel.id, { collapsed: !panel.collapsed })
  }, [updateDockPanel, panel.id, panel.collapsed])

  const handleClose = useCallback(() => {
    unregisterDockPanel(panel.id)
  }, [unregisterDockPanel, panel.id])

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!panel.resizable) return
      resizing.current = true
      startPos.current = effectiveHorizontal ? e.clientX : e.clientY
      startSize.current = currentSize
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
    },
    [panel.resizable, effectiveHorizontal, currentSize]
  )

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizing.current) return
      const delta = effectiveHorizontal
        ? (effectiveEdge === 'left' ? e.clientX - startPos.current : startPos.current - e.clientX)
        : (effectiveEdge === 'top' ? e.clientY - startPos.current : startPos.current - e.clientY)
      const newSize = Math.max(panel.minSize, Math.min(panel.maxSize, startSize.current + delta))
      setCurrentSize(newSize)
    },
    [effectiveHorizontal, effectiveEdge, panel.minSize, panel.maxSize]
  )

  const handleResizePointerUp = useCallback(() => {
    if (!resizing.current) return
    resizing.current = false
    updateDockPanel(panel.id, { size: currentSize })
  }, [updateDockPanel, panel.id, currentSize])

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
        {!panel.collapsed && (
          <>
            <span className={styles.title}>{panel.title}</span>
            <button className={styles.headerBtn} onClick={handleClose} title={tc('actions.close')}>
              <X size={14} />
            </button>
          </>
        )}
      </div>

      {!panel.collapsed && (
        <>
          <div className={styles.content} ref={contentHostRef} />

          {panel.resizable && (
            <div
              className={clsx(styles.resizeHandle, styles[`resize_${effectiveEdge}`])}
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
            />
          )}
        </>
      )}
    </div>
  )
}
