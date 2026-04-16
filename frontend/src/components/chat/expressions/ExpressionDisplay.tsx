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
import ContextMenu, { type ContextMenuPos, type ContextMenuEntry } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
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

  // Group chat state
  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const groupExpressions = useStore((s) => s.groupExpressions)
  const respondingCharacterId = useStore((s) => s.respondingCharacterId)
  const isStreaming = useStore((s) => s.isStreaming)

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

  // Clear expression when the active character changes (e.g. switching chats)
  useEffect(() => {
    if (activeCharacterId && expressionCharacterId && activeCharacterId !== expressionCharacterId) {
      setActiveExpression(null, null, null)
      lastResolvedKey.current = ''
    }
  }, [activeCharacterId, expressionCharacterId, setActiveExpression])

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

  // ── Group expression config fetching ──
  const [groupConfigs, setGroupConfigs] = useState<Map<string, ExpressionConfig>>(new Map())
  const [hoveredCharId, setHoveredCharId] = useState<string | null>(null)

  // Refetch group configs when any group character is edited
  const [groupConfigVersion, setGroupConfigVersion] = useState(0)
  useEffect(() => {
    if (!isGroupChat || groupCharacterIds.length === 0) return
    const unsub = wsClient.on(EventType.CHARACTER_EDITED, (payload: { id: string }) => {
      if (groupCharacterIds.includes(payload.id)) {
        setGroupConfigVersion((v) => v + 1)
      }
    })
    return unsub
  }, [isGroupChat, groupCharacterIds])

  useEffect(() => {
    if (!isGroupChat || groupCharacterIds.length === 0) {
      setGroupConfigs(new Map())
      return
    }
    let cancelled = false
    Promise.all(
      groupCharacterIds.map(async (id) => {
        try {
          const config = await expressionsApi.get(id)
          if (config?.enabled && Object.keys(config.mappings || {}).length > 0) {
            return [id, config] as const
          }
        } catch { /* character may not have expressions */ }
        return null
      })
    ).then((results) => {
      if (cancelled) return
      const map = new Map<string, ExpressionConfig>()
      for (const r of results) {
        if (r) map.set(r[0], r[1])
      }
      setGroupConfigs(map)
    })
    return () => { cancelled = true }
  }, [isGroupChat, groupCharacterIds, groupConfigVersion])

  // Derived group values
  const groupExpressionCharIds = useMemo(() => {
    if (!isGroupChat) return []
    return groupCharacterIds.filter((id) => groupConfigs.has(id))
  }, [isGroupChat, groupCharacterIds, groupConfigs])

  const isGroupExpressionMode = isGroupChat && groupExpressionCharIds.length > 0

  // ── Sizing ──
  const [pos, setPos] = useState({ x: display.x, y: display.y })
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
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

  // Base per-character slot size
  const size = useMemo(() => {
    if (display.sizePreset === 'custom') return { width: customSize.width, height: customSize.height }
    return EXPRESSION_SIZE_PRESETS[display.sizePreset as Exclude<ExpressionDisplaySize, 'custom'>] || EXPRESSION_SIZE_PRESETS.medium
  }, [display.sizePreset, customSize])

  // Effective container size (wider for group expression mode)
  const containerSize = useMemo(() => {
    if (!isGroupExpressionMode || groupExpressionCharIds.length <= 1) return size
    const n = groupExpressionCharIds.length
    // Overlap increases with more characters to keep total width reasonable
    const slotAdvance = size.width * Math.max(0.45, 0.75 - 0.1 * Math.max(0, n - 2))
    const totalWidth = Math.round(size.width + (n - 1) * slotAdvance)
    return { width: totalWidth, height: size.height }
  }, [isGroupExpressionMode, groupExpressionCharIds.length, size])

  // Clamp position to screen bounds whenever display settings or size change
  useEffect(() => {
    const pad = 12
    let x: number, y: number
    if (display.x < 0 || display.y < 0) {
      x = window.innerWidth - containerSize.width - 24
      y = window.innerHeight - containerSize.height - 100
    } else {
      x = display.x
      y = display.y
    }
    // Ensure the widget stays within viewport
    x = Math.max(pad, Math.min(x, window.innerWidth - containerSize.width - pad))
    y = Math.max(pad, Math.min(y, window.innerHeight - containerSize.height - pad))
    setPos({ x, y })
  }, [display.x, display.y, containerSize.width, containerSize.height])

  // Re-clamp on window resize
  useEffect(() => {
    const onResize = () => {
      const pad = 12
      setPos((prev) => ({
        x: Math.max(pad, Math.min(prev.x, window.innerWidth - containerSize.width - pad)),
        y: Math.max(pad, Math.min(prev.y, window.innerHeight - containerSize.height - pad)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [containerSize.width, containerSize.height])

  const currentImageUrl = currentExpressionImageId
    ? expressionsApi.imageUrl(currentExpressionImageId)
    : null

  // Preload images and track readiness so we never show a partially-scanned image
  const [readyUrls, setReadyUrls] = useState<Set<string>>(() => new Set())
  const preloadedRef = useRef<Set<string>>(new Set())

  const preloadImage = useCallback((url: string) => {
    if (!url || preloadedRef.current.has(url)) return
    preloadedRef.current.add(url)
    const img = new Image()
    img.onload = () => setReadyUrls(prev => {
      const next = new Set(prev)
      next.add(url)
      return next
    })
    img.src = url
  }, [])

  useEffect(() => {
    if (currentImageUrl) preloadImage(currentImageUrl)
  }, [currentImageUrl, preloadImage])

  useEffect(() => {
    if (!isGroupExpressionMode) return
    for (const charId of groupExpressionCharIds) {
      const url = getGroupCharImageUrl(charId)
      if (url) preloadImage(url)
    }
  }, [isGroupExpressionMode, groupExpressionCharIds, groupExpressions, groupConfigs, preloadImage])

  const clampPos = useCallback(
    (x: number, y: number) => {
      const pad = 12
      const w = display.minimized ? 40 : containerSize.width
      const h = display.minimized ? 40 : containerSize.height + (display.frameless ? 0 : 28)
      return {
        x: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
        y: Math.max(pad, Math.min(y, window.innerHeight - h - pad)),
      }
    },
    [containerSize.width, containerSize.height, display.minimized, display.frameless]
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

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    if (isDragging.current) {
      // Prevent the touch release from triggering interactions on elements below
      e.preventDefault()
      e.stopPropagation()
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

  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return
    resizing.current = false
    e.preventDefault()
    e.stopPropagation()
    setExpressionDisplay({ sizePreset: 'custom', customWidth: customSize.width, customHeight: customSize.height })
  }, [customSize, setExpressionDisplay])

  const longPress = useLongPress({
    onLongPress: (pos) => setContextMenu(pos),
  })

  const handleContextMenu = longPress.onContextMenu

  const selectSize = useCallback(
    (preset: ExpressionDisplaySize) => {
      setExpressionDisplay({ sizePreset: preset })
      setContextMenu(null)
    },
    [setExpressionDisplay]
  )

  // ── Group expression layout calculations (must be before early returns) ──
  const groupSlotOverlap = useMemo(() => {
    if (!isGroupExpressionMode || groupExpressionCharIds.length <= 1) return 0
    const n = groupExpressionCharIds.length
    return size.width * (1 - Math.max(0.45, 0.75 - 0.1 * Math.max(0, n - 2)))
  }, [isGroupExpressionMode, groupExpressionCharIds.length, size.width])

  // ── Group helpers ──
  function getGroupCharImageUrl(charId: string): string | null {
    const expr = groupExpressions[charId]
    if (expr?.imageId) return expressionsApi.imageUrl(expr.imageId)
    // Fall back to default expression from config
    const config = groupConfigs.get(charId)
    if (!config) return null
    const defaultLabel = config.defaultExpression
    if (defaultLabel && config.mappings[defaultLabel]) {
      return expressionsApi.imageUrl(config.mappings[defaultLabel])
    }
    const firstLabel = Object.keys(config.mappings)[0]
    if (firstLabel) return expressionsApi.imageUrl(config.mappings[firstLabel])
    return null
  }

  function getGroupCharLabel(charId: string): string | null {
    return groupExpressions[charId]?.label
      || groupConfigs.get(charId)?.defaultExpression
      || null
  }

  const contextMenuItems: ContextMenuEntry[] = useMemo(() => [
    ...(['small', 'medium', 'large'] as const).map((preset) => ({
      key: `size-${preset}`,
      label: `Size: ${preset.charAt(0).toUpperCase() + preset.slice(1)}`,
      active: display.sizePreset === preset,
      onClick: () => selectSize(preset),
    })),
    { key: 'div-1', type: 'divider' as const },
    {
      key: 'opacity',
      type: 'custom' as const,
      content: (
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
      ),
    },
    { key: 'div-2', type: 'divider' as const },
    {
      key: 'frame',
      label: display.frameless ? 'Show Frame' : 'Hide Frame',
      onClick: () => { setExpressionDisplay({ frameless: !display.frameless }); setContextMenu(null) },
    },
    {
      key: 'click-through',
      label: display.clickThrough ? 'Disable Click-Through' : 'Enable Click-Through',
      active: display.clickThrough,
      onClick: () => { setExpressionDisplay({ clickThrough: !display.clickThrough }); setContextMenu(null) },
    },
    {
      key: 'minimize',
      label: 'Minimize',
      onClick: () => { toggleMinimized(); setContextMenu(null) },
    },
    {
      key: 'hide',
      label: 'Hide Expression Display',
      onClick: () => { setExpressionDisplay({ enabled: false }); setContextMenu(null) },
    },
    {
      key: 'reset',
      label: 'Reset Position',
      onClick: () => {
        const nx = window.innerWidth - containerSize.width - 24
        const ny = window.innerHeight - containerSize.height - 100
        setPos({ x: nx, y: ny })
        setExpressionDisplay({ x: nx, y: ny })
        setContextMenu(null)
      },
    },
  ], [display.sizePreset, display.opacity, display.frameless, display.clickThrough, containerSize, selectSize, setExpressionDisplay, toggleMinimized])

  // ── Visibility gate ──
  if (!display.enabled) return null
  if (!isGroupExpressionMode && (!hasExpressions || !currentImageUrl)) return null

  // ── Minimized state ──
  if (display.minimized) {
    const handleMinimizedPointerUp = (e: React.PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      if (isDragging.current) {
        // Was a drag — persist position, prevent touch from reaching chat below
        e.preventDefault()
        e.stopPropagation()
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

    const minimizedTitle = isGroupExpressionMode
      ? groupExpressionCharIds.map((id) => characters.find((c) => c.id === id)?.name || '?').join(', ')
      : `${character?.name || ''} — ${currentExpression || ''}`

    return createPortal(
      <>
        <div
          className={styles.minimized}
          style={{ left: pos.x, top: pos.y, position: 'fixed', zIndex: 9970 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handleMinimizedPointerUp}
          onContextMenu={handleContextMenu}
          onTouchStart={longPress.onTouchStart}
          onTouchMove={longPress.onTouchMove}
          onTouchEnd={longPress.onTouchEnd}
          title={minimizedTitle}
        >
          <span className={styles.minimizedIcon}>
            {isGroupExpressionMode
              ? groupExpressionCharIds.length.toString()
              : (character?.name || '?')[0].toUpperCase()
            }
          </span>
        </div>
        <ContextMenu position={contextMenu} items={contextMenuItems} onClose={() => setContextMenu(null)} />
      </>,
      document.body
    )
  }

  // ── Drag handle name ──
  const handleDisplayName = isGroupExpressionMode
    ? groupExpressionCharIds.map((id) => characters.find((c) => c.id === id)?.name || '?').join(' / ')
    : character?.name

  const containerClass = [
    styles.container,
    display.frameless ? styles.frameless : styles.framed,
    dragging.current ? styles.containerDragging : '',
    display.clickThrough ? styles.clickThrough : '',
  ].filter(Boolean).join(' ')

  // ── Render ──
  return createPortal(
    <>
      <div
        className={containerClass}
        style={{
          left: pos.x,
          top: pos.y,
          width: containerSize.width,
          height: containerSize.height + (display.frameless ? 0 : 28),
          opacity: display.opacity,
        }}
        onContextMenu={!display.clickThrough ? handleContextMenu : undefined}
        onTouchStart={!display.clickThrough ? longPress.onTouchStart : undefined}
        onTouchMove={!display.clickThrough ? longPress.onTouchMove : undefined}
        onTouchEnd={!display.clickThrough ? longPress.onTouchEnd : undefined}
      >
        {/* Drag handle — always interactive even in click-through mode */}
        {display.frameless ? (
          <div
            className={styles.dragHandleFrameless}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onContextMenu={display.clickThrough ? handleContextMenu : undefined}
            onTouchStart={display.clickThrough ? longPress.onTouchStart : undefined}
            onTouchMove={display.clickThrough ? longPress.onTouchMove : undefined}
            onTouchEnd={display.clickThrough ? longPress.onTouchEnd : undefined}
          >
            <span className={styles.handleName}>{handleDisplayName}</span>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); toggleMinimized() }}>
              <Minus size={12} />
            </button>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); setExpressionDisplay({ enabled: false }) }}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <div
            className={styles.dragHandle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onContextMenu={display.clickThrough ? handleContextMenu : undefined}
            onTouchStart={display.clickThrough ? longPress.onTouchStart : undefined}
            onTouchMove={display.clickThrough ? longPress.onTouchMove : undefined}
            onTouchEnd={display.clickThrough ? longPress.onTouchEnd : undefined}
          >
            <span className={styles.handleName}>{handleDisplayName}</span>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); toggleMinimized() }}>
              <Minus size={12} />
            </button>
            <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); setExpressionDisplay({ enabled: false }) }}>
              <X size={12} />
            </button>
          </div>
        )}

        {/* Expression image area */}
        {isGroupExpressionMode ? (
          /* ── Group expression row ── */
          <div
            className={styles.groupRow}
            onPointerDown={!display.clickThrough ? handlePointerDown : undefined}
            onPointerMove={!display.clickThrough ? handlePointerMove : undefined}
            onPointerUp={!display.clickThrough ? handlePointerUp : undefined}
          >
            {groupExpressionCharIds.map((charId, idx) => {
              const imageUrl = getGroupCharImageUrl(charId)
              const label = getGroupCharLabel(charId)
              const isResponding = isStreaming && respondingCharacterId === charId
              const isHovered = hoveredCharId === charId
              const isActive = isResponding || isHovered
              const char = characters.find((c) => c.id === charId)
              const marginLeft = idx === 0 ? 0 : -groupSlotOverlap

              return (
                <div
                  key={charId}
                  className={[
                    styles.groupSlot,
                    isActive ? styles.groupSlotActive : styles.groupSlotIdle,
                  ].join(' ')}
                  style={{
                    width: size.width,
                    marginLeft,
                    zIndex: isHovered ? 3 : isResponding ? 2 : 1,
                  }}
                  onMouseEnter={() => setHoveredCharId(charId)}
                  onMouseLeave={() => setHoveredCharId(null)}
                >
                  <AnimatePresence mode="sync">
                    {imageUrl && readyUrls.has(imageUrl) && (
                      <motion.img
                        key={imageUrl}
                        src={imageUrl}
                        alt={label || char?.name || ''}
                        className={styles.expressionImg}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                        draggable={false}
                      />
                    )}
                  </AnimatePresence>
                  <span className={styles.groupNameTag}>
                    {char?.name}{label ? ` — ${label}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          /* ── Single character expression ── */
          <div
            className={styles.imageContainer}
            onPointerDown={!display.clickThrough ? handlePointerDown : undefined}
            onPointerMove={!display.clickThrough ? handlePointerMove : undefined}
            onPointerUp={!display.clickThrough ? handlePointerUp : undefined}
          >
            <AnimatePresence mode="sync">
              {currentImageUrl && readyUrls.has(currentImageUrl) && (
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
        )}

        {/* Resize handle */}
        <div
          className={styles.resizeHandle}
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
        />
      </div>

      <ContextMenu position={contextMenu} items={contextMenuItems} onClose={() => setContextMenu(null)} />
    </>,
    document.body
  )
}
