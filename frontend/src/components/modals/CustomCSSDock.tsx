import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'

import { useStore } from '@/store'
import {
  clampCustomCSSDockSize,
  CUSTOM_CSS_DOCK_MAX_SIZE,
  CUSTOM_CSS_DOCK_MIN_SIZE,
} from '@/lib/custom-css-dock'
import { CustomCSSEditor } from './CustomCSSModal'
import styles from './CustomCSSDock.module.css'

export default function CustomCSSDock() {
  const { t } = useTranslation('modals', { keyPrefix: 'customCss' })

  const preferredSize = useStore((s) => s.customCSSDockSize)
  const setPreferredSize = useStore((s) => s.setCustomCSSDockSize)
  const dockSide = useStore((s) => s.customCSSDockSide)
  const setDockSide = useStore((s) => s.setCustomCSSDockSide)
  const closeDock = useStore((s) => s.closeCustomCSSDock)
  const openModal = useStore((s) => s.openModal)

  const [currentSize, setCurrentSize] = useState(() =>
    clampCustomCSSDockSize(preferredSize, window.innerWidth)
  )

  const currentSizeRef = useRef(currentSize)
  const resizingRef = useRef(false)
  const startXRef = useRef(0)
  const startSizeRef = useRef(currentSize)

  const updateSize = useCallback((size: number) => {
    currentSizeRef.current = size
    setCurrentSize(size)
  }, [])

  const commitSize = useCallback(
    (size: number) => {
      updateSize(size)
      setPreferredSize(size)
    },
    [setPreferredSize, updateSize]
  )

  useEffect(() => {
    updateSize(clampCustomCSSDockSize(preferredSize, window.innerWidth))
  }, [preferredSize, updateSize])

  useEffect(() => {
    const handleWindowResize = () => {
      const next = clampCustomCSSDockSize(
        currentSizeRef.current,
        window.innerWidth
      )

      if (next !== currentSizeRef.current) {
        commitSize(next)
      }
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [commitSize])

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizingRef.current = true
      startXRef.current = event.clientX
      startSizeRef.current = currentSizeRef.current
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    []
  )

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) return

      const delta = dockSide === 'left'
        ? event.clientX - startXRef.current
        : startXRef.current - event.clientX

      const next = clampCustomCSSDockSize(
        startSizeRef.current + delta,
        window.innerWidth
      )

      commitSize(next)
    },
    [commitSize, dockSide]
  )

  const handleResizePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) return

      resizingRef.current = false

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    []
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null

      switch (event.key) {
        case 'ArrowLeft':
          next = currentSizeRef.current + (dockSide === 'right' ? 24 : -24)
          break
        case 'ArrowRight':
          next = currentSizeRef.current + (dockSide === 'left' ? 24 : -24)
          break
        case 'Home':
          next = CUSTOM_CSS_DOCK_MIN_SIZE
          break
        case 'End':
          next = CUSTOM_CSS_DOCK_MAX_SIZE
          break
        default:
          return
      }

      event.preventDefault()
      commitSize(clampCustomCSSDockSize(next, window.innerWidth))
    },
    [commitSize, dockSide]
  )

  const handleUndock = useCallback(() => {
    openModal('customCSS')
  }, [openModal])

  const handleSwapSide = useCallback(() => {
    setDockSide(dockSide === 'left' ? 'right' : 'left')
  }, [dockSide, setDockSide])

  const effectiveMaximum = clampCustomCSSDockSize(
    CUSTOM_CSS_DOCK_MAX_SIZE,
    window.innerWidth
  )

  return (
    <aside
      className={clsx(styles.panel, styles[dockSide])}
      style={{ width: currentSize }}
      aria-label={t('title')}
    >
      <div className={styles.content}>
        <CustomCSSEditor
          presentation="dock"
          dockSide={dockSide}
          onClose={closeDock}
          onUndock={handleUndock}
          onSwapDockSide={handleSwapSide}
        />
      </div>

      <div
        className={clsx(styles.resizeHandle, dockSide === 'left' ? styles.resizeLeft : styles.resizeRight)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeDock')}
        aria-valuemin={CUSTOM_CSS_DOCK_MIN_SIZE}
        aria-valuemax={effectiveMaximum}
        aria-valuenow={Math.round(currentSize)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onKeyDown={handleResizeKeyDown}
      />
    </aside>
  )
}