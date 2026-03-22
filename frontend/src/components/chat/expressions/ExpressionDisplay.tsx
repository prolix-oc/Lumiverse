import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Minus, X } from 'lucide-react'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import { expressionsApi } from '@/api/expressions'
import { EXPRESSION_SIZE_PRESETS } from '@/types/expressions'
import type { ExpressionConfig, ExpressionDisplaySize } from '@/types/expressions'
import styles from './ExpressionDisplay.module.css'

export default function ExpressionDisplay() {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const activeChatId = useStore((s) => s.activeChatId)
  const currentExpression = useStore((s) => s.currentExpression)
  const currentExpressionImageId = useStore((s) => s.currentExpressionImageId)
  const expressionCharacterId = useStore((s) => s.expressionCharacterId)
  const display = useStore((s) => s.expressionDisplay)
  const setExpressionDisplay = useStore((s) => s.setExpressionDisplay)
  const toggleMinimized = useStore((s) => s.toggleExpressionMinimized)
  const setActiveExpression = useStore((s) => s.setActiveExpression)

  const character = useMemo(
    () => characters.find((c) => c.id === (expressionCharacterId || activeCharacterId)),
    [characters, expressionCharacterId, activeCharacterId]
  )

  // Fetch expression config directly from API (store character data may be stale)
  const [exprConfig, setExprConfig] = useState<ExpressionConfig | null>(null)
  const [configVersion, setConfigVersion] = useState(0)
  const resolvedCharId = expressionCharacterId || activeCharacterId

  // Refetch when character is edited (e.g. expressions saved in editor)
  useEffect(() => {
    if (!resolvedCharId) return
    const unsub = wsClient.on(EventType.CHARACTER_EDITED, (payload: { id: string }) => {
      if (payload.id === resolvedCharId) {
        setConfigVersion((v) => v + 1)
      }
    })
    return unsub
  }, [resolvedCharId])

  useEffect(() => {
    if (!resolvedCharId) {
      setExprConfig(null)
      return
    }
    expressionsApi.get(resolvedCharId)
      .then(setExprConfig)
      .catch(() => setExprConfig(null))
  }, [resolvedCharId, configVersion])

  // Track the last resolved character+config pair to avoid loops
  const lastResolvedKey = useRef<string>('')

  // Clear expression when switching to a different character
  useEffect(() => {
    if (resolvedCharId && expressionCharacterId && resolvedCharId !== expressionCharacterId) {
      setActiveExpression(null, null, null)
      lastResolvedKey.current = ''
    }
  }, [resolvedCharId, expressionCharacterId, setActiveExpression])

  const hasExpressions = !!exprConfig?.enabled && Object.keys(exprConfig.mappings || {}).length > 0

  // Resolve default expression when config loads or character/chat changes
  useEffect(() => {
    if (!activeChatId || !hasExpressions || !exprConfig || !resolvedCharId) return

    // Don't override if an expression was already restored (e.g. from chat metadata)
    const { currentExpression: existing, expressionCharacterId: existingCharId } = useStore.getState()
    if (existing && existingCharId === resolvedCharId) {
      lastResolvedKey.current = `${resolvedCharId}:${exprConfig.defaultExpression}:${Object.keys(exprConfig.mappings).join(',')}`
      return
    }

    // Build a key from character + config identity to detect real changes
    const configKey = `${resolvedCharId}:${exprConfig.defaultExpression}:${Object.keys(exprConfig.mappings).join(',')}`
    if (lastResolvedKey.current === configKey) return
    lastResolvedKey.current = configKey

    const mappings = exprConfig.mappings
    const defaultExpr = exprConfig.defaultExpression

    if (defaultExpr && mappings?.[defaultExpr]) {
      setActiveExpression(defaultExpr, mappings[defaultExpr], resolvedCharId)
    } else {
      // No default set — use the first available expression
      const firstLabel = Object.keys(mappings)[0]
      if (firstLabel && mappings[firstLabel]) {
        setActiveExpression(firstLabel, mappings[firstLabel], resolvedCharId)
      }
    }
  }, [activeChatId, hasExpressions, exprConfig, resolvedCharId, setActiveExpression])

  const [pos, setPos] = useState({ x: display.x, y: display.y })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)
  const resizing = useRef(false)
  const offset = useRef({ x: 0, y: 0 })
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const [customSize, setCustomSize] = useState({ width: display.customWidth, height: display.customHeight })
  const isDragging = useRef(false)

  // Sync custom size from persisted settings (e.g. after loadSettings restores saved values)
  useEffect(() => {
    setCustomSize({ width: display.customWidth, height: display.customHeight })
  }, [display.customWidth, display.customHeight])

  // Resolve display dimensions
  const size = useMemo(() => {
    if (display.sizePreset === 'custom') return { width: customSize.width, height: customSize.height }
    return EXPRESSION_SIZE_PRESETS[display.sizePreset as Exclude<ExpressionDisplaySize, 'custom'>] || EXPRESSION_SIZE_PRESETS.medium
  }, [display.sizePreset, customSize])

  // Clamp position to screen bounds whenever display settings or size change
  useEffect(() => {
    const pad = 12
    let x: number, y: number
    if (display.x < 0 || display.y < 0) {
      x = window.innerWidth - size.width - 24
      y = window.innerHeight - size.height - 100
    } else {
      x = display.x
      y = display.y
    }
    // Ensure the widget stays within viewport
    x = Math.max(pad, Math.min(x, window.innerWidth - size.width - pad))
    y = Math.max(pad, Math.min(y, window.innerHeight - size.height - pad))
    setPos({ x, y })
  }, [display.x, display.y, size.width, size.height])

  // Re-clamp on window resize
  useEffect(() => {
    const onResize = () => {
      const pad = 12
      setPos((prev) => ({
        x: Math.max(pad, Math.min(prev.x, window.innerWidth - size.width - pad)),
        y: Math.max(pad, Math.min(prev.y, window.innerHeight - size.height - pad)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [size.width, size.height])

  const currentImageUrl = currentExpressionImageId
    ? expressionsApi.imageUrl(currentExpressionImageId)
    : null

  // Preload images
  useEffect(() => {
    if (currentImageUrl) {
      const img = new Image()
      img.src = currentImageUrl
    }
  }, [currentImageUrl])

  const clampPos = useCallback(
    (x: number, y: number) => {
      const pad = 12
      const w = display.minimized ? 40 : size.width
      const h = display.minimized ? 40 : size.height + (display.frameless ? 0 : 28)
      return {
        x: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
        y: Math.max(pad, Math.min(y, window.innerHeight - h - pad)),
      }
    },
    [size.width, size.height, display.minimized, display.frameless]
  )

  const dragStartPos = useRef({ x: 0, y: 0 })
  const DRAG_THRESHOLD = 5

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Don't initiate drag from interactive elements (buttons)
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    isDragging.current = false
    dragging.current = true
    dragStartPos.current = { x: e.clientX, y: e.clientY }
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [pos])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    // Only start dragging after exceeding threshold (prevents tap jitter on touch)
    if (!isDragging.current) {
      const dx = Math.abs(e.clientX - dragStartPos.current.x)
      const dy = Math.abs(e.clientY - dragStartPos.current.y)
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return
      isDragging.current = true
    }
    const raw = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }
    setPos(clampPos(raw.x, raw.y))
  }, [clampPos])

  const handlePointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    if (isDragging.current) {
      requestAnimationFrame(() => {
        setPos((prev) => {
          setExpressionDisplay({ x: prev.x, y: prev.y })
          return prev
        })
      })
    }
    isDragging.current = false
  }, [setExpressionDisplay])

  const handleResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    resizing.current = true
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [size])

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return
    const dx = e.clientX - resizeStart.current.x
    const dy = e.clientY - resizeStart.current.y
    // Maintain 3:4 aspect ratio
    const delta = Math.max(dx, dy)
    const newWidth = Math.max(120, Math.min(600, resizeStart.current.w + delta))
    const newHeight = Math.round(newWidth * (4 / 3))
    setCustomSize({ width: newWidth, height: Math.max(150, Math.min(750, newHeight)) })
  }, [])

  const handleResizeUp = useCallback(() => {
    resizing.current = false
    setExpressionDisplay({ sizePreset: 'custom', customWidth: customSize.width, customHeight: customSize.height })
  }, [customSize, setExpressionDisplay])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
  }, [contextMenu])

  const selectSize = useCallback(
    (preset: ExpressionDisplaySize) => {
      setExpressionDisplay({ sizePreset: preset })
      setContextMenu(null)
    },
    [setExpressionDisplay]
  )

  if (!display.enabled || !hasExpressions || !currentImageUrl) return null

  // Minimized state
  if (display.minimized) {
    const handleMinimizedPointerUp = () => {
      if (!dragging.current) return
      dragging.current = false
      if (isDragging.current) {
        // Was a drag — persist position
        requestAnimationFrame(() => {
          setPos((prev) => {
            setExpressionDisplay({ x: prev.x, y: prev.y })
            return prev
          })
        })
      } else {
        // Was a tap — expand
        toggleMinimized()
      }
      isDragging.current = false
    }

    return createPortal(
      <>
        <div
          className={styles.minimized}
          style={{ left: pos.x, top: pos.y, position: 'fixed', zIndex: 9970 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handleMinimizedPointerUp}
          onContextMenu={handleContextMenu}
          title={`${character?.name || ''} — ${currentExpression || ''}`}
        >
          <span className={styles.minimizedIcon}>
            {(character?.name || '?')[0].toUpperCase()}
          </span>
        </div>
        {renderContextMenu()}
      </>,
      document.body
    )
  }

  function renderContextMenu() {
    if (!contextMenu) return null
    return (
      <div
        className={styles.contextMenu}
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {(['small', 'medium', 'large'] as const).map((preset) => (
          <button
            key={preset}
            className={display.sizePreset === preset ? styles.contextMenuActive : styles.contextMenuItem}
            onClick={() => selectSize(preset)}
          >
            Size: {preset.charAt(0).toUpperCase() + preset.slice(1)}
          </button>
        ))}
        <div className={styles.contextMenuDivider} />
        <div className={styles.opacityRow}>
          <span>Opacity</span>
          <input
            type="range"
            className={styles.opacitySlider}
            min={0.1}
            max={1}
            step={0.05}
            value={display.opacity}
            onChange={(e) => setExpressionDisplay({ opacity: parseFloat(e.target.value) })}
          />
        </div>
        <div className={styles.contextMenuDivider} />
        <button
          className={styles.contextMenuItem}
          onClick={() => {
            setExpressionDisplay({ frameless: !display.frameless })
            setContextMenu(null)
          }}
        >
          {display.frameless ? 'Show Frame' : 'Hide Frame'}
        </button>
        <button
          className={styles.contextMenuItem}
          onClick={() => { toggleMinimized(); setContextMenu(null) }}
        >
          Minimize
        </button>
        <button
          className={styles.contextMenuItem}
          onClick={() => {
            setExpressionDisplay({ enabled: false })
            setContextMenu(null)
          }}
        >
          Hide Expression Display
        </button>
        <button
          className={styles.contextMenuItem}
          onClick={() => {
            const x = window.innerWidth - size.width - 24
            const y = window.innerHeight - size.height - 100
            setPos({ x, y })
            setExpressionDisplay({ x, y })
            setContextMenu(null)
          }}
        >
          Reset Position
        </button>
      </div>
    )
  }

  const containerClass = [
    styles.container,
    display.frameless ? styles.frameless : styles.framed,
    dragging.current ? styles.containerDragging : '',
  ].filter(Boolean).join(' ')

  return createPortal(
    <>
      <div
        className={containerClass}
        style={{
          left: pos.x,
          top: pos.y,
          width: size.width,
          height: size.height + (display.frameless ? 0 : 28),
          opacity: display.opacity,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={handleContextMenu}
      >
        {/* Drag handle */}
        {display.frameless ? (
          <div className={styles.dragHandleFrameless}>
            <span className={styles.handleName}>{character?.name}</span>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); toggleMinimized() }}>
              <Minus size={12} />
            </button>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); setExpressionDisplay({ enabled: false }) }}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className={styles.dragHandle}>
            <span className={styles.handleName}>{character?.name}</span>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); toggleMinimized() }}>
              <Minus size={12} />
            </button>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); setExpressionDisplay({ enabled: false }) }}>
              <X size={12} />
            </button>
          </div>
        )}

        {/* Expression image with crossfade */}
        <div className={styles.imageContainer}>
          <AnimatePresence mode="sync">
            {currentImageUrl && (
              <motion.img
                key={currentImageUrl}
                src={currentImageUrl}
                alt={currentExpression || ''}
                className={styles.expressionImg}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
                draggable={false}
              />
            )}
          </AnimatePresence>
          {currentExpression && (
            <span className={styles.labelBadge}>{currentExpression}</span>
          )}
        </div>

        {/* Resize handle */}
        <div
          className={styles.resizeHandle}
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
        />
      </div>

      {renderContextMenu()}
    </>,
    document.body
  )
}
