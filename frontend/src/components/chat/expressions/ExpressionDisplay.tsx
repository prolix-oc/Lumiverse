import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Minus, X } from 'lucide-react'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import { expressionsApi } from '@/api/expressions'
import { resolveExpression } from '@/lib/expressionResolution'
import { hasDisplayableExpressions } from '@/lib/chatExpressionAvailability'
import { EXPRESSION_SIZE_PRESETS } from '@/types/expressions'
import type { ExpressionConfig, ExpressionDisplaySize, ExpressionGroups } from '@/types/expressions'
import ContextMenu, { type ContextMenuPos, type ContextMenuEntry } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
import { toast } from '@/lib/toast'
import styles from './ExpressionDisplay.module.css'

type ExpressionMenuView =
  | { kind: 'display' }
  | { kind: 'single-picker' }
  | { kind: 'group-character-picker' }
  | { kind: 'group-expression-picker'; characterId: string }
  | { kind: 'multi-character-picker' }
  | { kind: 'multi-character-expression-picker'; groupName: string }

export default function ExpressionDisplay() {
  const { t } = useTranslation('chat')
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const savedExpression = activeChatMetadata?.active_expression
  const currentExpression = useStore((s) => s.currentExpression)
  const currentExpressionImageId = useStore((s) => s.currentExpressionImageId)
  const expressionCharacterId = useStore((s) => s.expressionCharacterId)
  const display = useStore((s) => s.expressionDisplay)
  const setExpressionDisplay = useStore((s) => s.setExpressionDisplay)
  const toggleMinimized = useStore((s) => s.toggleExpressionMinimized)
  const setActiveExpression = useStore((s) => s.setActiveExpression)
  const setGroupExpression = useStore((s) => s.setGroupExpression)
  const setMultiCharacterExpressions = useStore((s) => s.setMultiCharacterExpressions)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)

  // Group chat state
  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const mutedCharacterIds = useStore((s) => s.mutedCharacterIds)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const groupExpressions = useStore((s) => s.groupExpressions)
  const multiCharacterExpressions = useStore((s) => s.multiCharacterExpressions)
  const respondingCharacterId = useStore((s) => s.respondingCharacterId)
  const isStreaming = useStore((s) => s.isStreaming)

  const character = useMemo(
    () => characters.find((c) => c.id === (expressionCharacterId || activeCharacterId)),
    [characters, expressionCharacterId, activeCharacterId]
  )

  // Fetch expression config directly from API (store character data may be stale)
  const [exprConfig, setExprConfig] = useState<ExpressionConfig | null>(null)
  const [loadedConfigCharId, setLoadedConfigCharId] = useState<string | null>(null)
  const [multiCharacterGroups, setMultiCharacterGroups] = useState<ExpressionGroups>({})
  const [configVersion, setConfigVersion] = useState(0)
  const resolvedCharId = expressionCharacterId || activeCharacterId

  // Refetch when character is edited (e.g. expressions saved in editor)
  useEffect(() => {
    setLoadedConfigCharId(null)
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
      setMultiCharacterGroups({})
      return
    }
    let cancelled = false
    Promise.all([
      expressionsApi.get(resolvedCharId).catch(() => null),
      expressionsApi.getGroups(resolvedCharId).catch(() => ({} as ExpressionGroups)),
    ]).then(([config, groups]) => {
      if (cancelled) return
      setLoadedConfigCharId(resolvedCharId)
      setExprConfig(config)
      setMultiCharacterGroups(groups)
    })
    return () => { cancelled = true }
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

  const hasExpressions = hasDisplayableExpressions(exprConfig)

  // Resolve default expression when config loads or character/chat changes
  useEffect(() => {
    if (!activeChatId || activeChatMetadata === null || !hasExpressions || !exprConfig || !resolvedCharId || loadedConfigCharId !== resolvedCharId) return

    const configKey = `${activeChatId}:${resolvedCharId}:${savedExpression ?? ''}:${exprConfig.defaultExpression}:${Object.keys(exprConfig.mappings).join(',')}`
    // Preserve live detection and manual choices that arrived during loading.
    const { currentExpression: existing, expressionCharacterId: existingCharId } = useStore.getState()
    if (existing && existingCharId === resolvedCharId) {
      lastResolvedKey.current = configKey
      return
    }

    if (lastResolvedKey.current === configKey) return
    lastResolvedKey.current = configKey

    const fallback = resolveExpression(exprConfig,
      typeof savedExpression === 'string' && exprConfig.mappings[savedExpression]
        ? { label: savedExpression, imageId: exprConfig.mappings[savedExpression] } : null)
    if (fallback) {
      setActiveExpression(fallback.label, fallback.imageId, resolvedCharId)
    }
  }, [activeChatId, activeChatMetadata, hasExpressions, exprConfig, resolvedCharId, loadedConfigCharId, setActiveExpression, savedExpression])

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
          if (hasDisplayableExpressions(config)) {
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
    // Hide muted characters from the display — except one that's currently the
    // active speaker (e.g. force-summoned via @mention), so their reaction
    // still shows for that turn. The stored expression is kept either way, so
    // un-muting restores it immediately.
    return groupCharacterIds.filter(
      (id) =>
        groupConfigs.has(id) &&
        (!mutedCharacterIds.includes(id) || id === activeGroupCharacterId)
    )
  }, [isGroupChat, groupCharacterIds, groupConfigs, mutedCharacterIds, activeGroupCharacterId])

  const isGroupExpressionMode = isGroupChat && groupExpressionCharIds.length > 0

  // A multi-character card is one character record with named expression
  // groups. Only groups selected for the latest response are displayed; this
  // is separate from a group chat, whose keys are character IDs.
  const activeMultiCharacterGroups = useMemo(() => {
    if (isGroupChat) return []
    return Object.keys(multiCharacterExpressions).filter((groupName) => {
      const selected = multiCharacterExpressions[groupName]
      return !!selected?.imageId && !!multiCharacterGroups[groupName]?.[selected.label]
    })
  }, [isGroupChat, multiCharacterExpressions, multiCharacterGroups])

  const isMultiCharacterCardMode = activeMultiCharacterGroups.length > 0
  const isStackedExpressionMode = isGroupExpressionMode || isMultiCharacterCardMode
  const stackedExpressionKeys = isGroupExpressionMode
    ? groupExpressionCharIds
    : activeMultiCharacterGroups

  const getGroupCharImageUrl = useCallback((charId: string): string | null => {
    const expression = resolveExpression(groupConfigs.get(charId), groupExpressions[charId])
    return expression ? expressionsApi.imageUrl(expression.imageId) : null
  }, [groupExpressions, groupConfigs])

  const getGroupCharLabel = useCallback((charId: string): string | null => {
    return groupExpressions[charId]?.label
      || groupConfigs.get(charId)?.defaultExpression
      || null
  }, [groupExpressions, groupConfigs])

  const getStackedImageUrl = useCallback((key: string): string | null => {
    if (isGroupExpressionMode) return getGroupCharImageUrl(key)
    const expression = multiCharacterExpressions[key]
    return expression?.imageId ? expressionsApi.imageUrl(expression.imageId) : null
  }, [getGroupCharImageUrl, isGroupExpressionMode, multiCharacterExpressions])

  const getStackedLabel = useCallback((key: string): string | null => {
    if (isGroupExpressionMode) return getGroupCharLabel(key)
    return multiCharacterExpressions[key]?.label ?? null
  }, [getGroupCharLabel, isGroupExpressionMode, multiCharacterExpressions])

  const getStackedName = useCallback((key: string): string => {
    if (isGroupExpressionMode) {
      return characters.find((candidate) => candidate.id === key)?.name || '?'
    }
    return key === '_default' ? (character?.name || '?') : key
  }, [character?.name, characters, isGroupExpressionMode])

  // ── Sizing ──
  const [pos, setPos] = useState({ x: display.x, y: display.y })
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  const [menuView, setMenuView] = useState<ExpressionMenuView>({ kind: 'display' })
  const [menuTargetCharId, setMenuTargetCharId] = useState<string | null>(null)
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

  // Effective container size (wider when several sprites are visible)
  const containerSize = useMemo(() => {
    if (!isStackedExpressionMode || stackedExpressionKeys.length <= 1) return size
    const n = stackedExpressionKeys.length
    // Overlap increases with more characters to keep total width reasonable
    const slotAdvance = size.width * Math.max(0.45, 0.75 - 0.1 * Math.max(0, n - 2))
    const totalWidth = Math.round(size.width + (n - 1) * slotAdvance)
    return { width: totalWidth, height: size.height }
  }, [isStackedExpressionMode, stackedExpressionKeys.length, size])

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
    if (!isStackedExpressionMode) return
    for (const key of stackedExpressionKeys) {
      const url = getStackedImageUrl(key)
      if (url) preloadImage(url)
    }
  }, [isStackedExpressionMode, stackedExpressionKeys, multiCharacterExpressions, groupExpressions, groupConfigs, preloadImage, getStackedImageUrl])

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

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
    setMenuView({ kind: 'display' })
    setMenuTargetCharId(null)
  }, [])

  const openContextMenu = useCallback((position: ContextMenuPos, targetCharId: string | null = null) => {
    setMenuTargetCharId(targetCharId)
    setMenuView({ kind: 'display' })
    setContextMenu(position)
  }, [])

  const longPress = useLongPress({
    onLongPress: (pos) => openContextMenu(pos),
  })

  const handleContextMenu = longPress.onContextMenu

  const handleGroupSlotContextMenu = useCallback((e: React.MouseEvent, charId: string) => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu({ x: e.clientX, y: e.clientY }, charId)
  }, [openContextMenu])

  const selectSize = useCallback(
    (preset: ExpressionDisplaySize) => {
      setExpressionDisplay({ sizePreset: preset })
      closeContextMenu()
    },
    [closeContextMenu, setExpressionDisplay]
  )

  // ── Group expression layout calculations (must be before early returns) ──
  const groupSlotOverlap = useMemo(() => {
    if (!isStackedExpressionMode || stackedExpressionKeys.length <= 1) return 0
    const n = stackedExpressionKeys.length
    return size.width * (1 - Math.max(0.45, 0.75 - 0.1 * Math.max(0, n - 2)))
  }, [isStackedExpressionMode, stackedExpressionKeys.length, size.width])

  const directGroupMenuCharId = useMemo(() => {
    if (menuTargetCharId && groupConfigs.has(menuTargetCharId)) return menuTargetCharId
    if (groupExpressionCharIds.length === 1) return groupExpressionCharIds[0]
    return null
  }, [groupConfigs, groupExpressionCharIds, menuTargetCharId])

  const directMultiCharacterGroup = useMemo(() => {
    if (menuTargetCharId && multiCharacterGroups[menuTargetCharId]) return menuTargetCharId
    if (activeMultiCharacterGroups.length === 1) return activeMultiCharacterGroups[0]
    return null
  }, [activeMultiCharacterGroups, menuTargetCharId, multiCharacterGroups])

  const selectSingleExpression = useCallback(async (label: string, imageId: string) => {
    if (!resolvedCharId) return
    setActiveExpression(label, imageId, resolvedCharId)
    closeContextMenu()
    if (!activeChatId) return
    try {
      const updated = await chatsApi.patchMetadata(activeChatId, { active_expression: label })
      setActiveChatMetadata(updated.metadata ?? null)
    } catch {
      toast.error(t('expressionDisplay.failedSaveSelection'))
    }
  }, [activeChatId, closeContextMenu, resolvedCharId, setActiveChatMetadata, setActiveExpression, t])

  const selectGroupExpression = useCallback(async (characterId: string, label: string, imageId: string) => {
    const nextGroupExpressions = {
      ...useStore.getState().groupExpressions,
      [characterId]: { label, imageId },
    }
    setGroupExpression(characterId, label, imageId)
    closeContextMenu()
    if (!activeChatId) return
    try {
      const updated = await chatsApi.patchMetadata(activeChatId, { group_expressions: nextGroupExpressions })
      setActiveChatMetadata(updated.metadata ?? null)
    } catch {
      toast.error(t('expressionDisplay.failedSaveSelection'))
    }
  }, [activeChatId, closeContextMenu, setActiveChatMetadata, setGroupExpression, t])

  const selectMultiCharacterExpression = useCallback(async (groupName: string, label: string, imageId: string) => {
    const nextExpressions = {
      ...useStore.getState().multiCharacterExpressions,
      [groupName]: { label, imageId },
    }
    setMultiCharacterExpressions(nextExpressions)
    closeContextMenu()
    if (!activeChatId) return
    try {
      const updated = await chatsApi.patchMetadata(activeChatId, {
        multi_character_expressions: nextExpressions,
      })
      setActiveChatMetadata(updated.metadata ?? null)
    } catch {
      toast.error(t('expressionDisplay.failedSaveSelection'))
    }
  }, [activeChatId, closeContextMenu, setActiveChatMetadata, setMultiCharacterExpressions, t])

  const contextMenuItems: ContextMenuEntry[] = useMemo(() => {
    const backToDisplayItem: ContextMenuEntry = {
      key: 'back-display',
      label: t('expressionDisplay.backToDisplayMenu'),
      onClick: () => setMenuView({ kind: 'display' }),
    }

    if (menuView.kind === 'single-picker') {
      if (!exprConfig || !resolvedCharId) return [backToDisplayItem]
      return [
        backToDisplayItem,
        { key: 'single-divider', type: 'divider' as const },
        ...Object.entries(exprConfig.mappings).map(([label, imageId]) => ({
          key: `single-expression-${label}`,
          label,
          active: expressionCharacterId === resolvedCharId && currentExpression === label,
          onClick: () => { void selectSingleExpression(label, imageId) },
        })),
      ]
    }

    if (menuView.kind === 'group-character-picker') {
      return [
        backToDisplayItem,
        { key: 'group-character-divider', type: 'divider' as const },
        ...groupExpressionCharIds.map((charId) => ({
          key: `group-character-${charId}`,
          label: characters.find((c) => c.id === charId)?.name || t('characterFallback'),
          onClick: () => setMenuView({ kind: 'group-expression-picker', characterId: charId }),
        })),
      ]
    }

    if (menuView.kind === 'group-expression-picker') {
      const config = groupConfigs.get(menuView.characterId)
      const backItem: ContextMenuEntry = directGroupMenuCharId
        ? backToDisplayItem
        : {
            key: 'back-character-picker',
            label: t('expressionDisplay.backToCharacterMenu'),
            onClick: () => setMenuView({ kind: 'group-character-picker' }),
          }

      if (!config) return [backItem]

      return [
        backItem,
        { key: 'group-expression-divider', type: 'divider' as const },
        ...Object.entries(config.mappings).map(([label, imageId]) => ({
          key: `group-expression-${menuView.characterId}-${label}`,
          label,
          active: getGroupCharLabel(menuView.characterId) === label,
          onClick: () => { void selectGroupExpression(menuView.characterId, label, imageId) },
        })),
      ]
    }

    if (menuView.kind === 'multi-character-picker') {
      return [
        backToDisplayItem,
        { key: 'multi-character-divider', type: 'divider' as const },
        ...activeMultiCharacterGroups.map((groupName) => ({
          key: `multi-character-${groupName}`,
          label: getStackedName(groupName),
          onClick: () => setMenuView({ kind: 'multi-character-expression-picker', groupName }),
        })),
      ]
    }

    if (menuView.kind === 'multi-character-expression-picker') {
      const mappings = multiCharacterGroups[menuView.groupName]
      const backItem: ContextMenuEntry = directMultiCharacterGroup
        ? backToDisplayItem
        : {
            key: 'back-multi-character-picker',
            label: t('expressionDisplay.backToCharacterMenu'),
            onClick: () => setMenuView({ kind: 'multi-character-picker' }),
          }
      if (!mappings) return [backItem]
      return [
        backItem,
        { key: 'multi-character-expression-divider', type: 'divider' as const },
        ...Object.entries(mappings).map(([label, imageId]) => ({
          key: `multi-character-expression-${menuView.groupName}-${label}`,
          label,
          active: multiCharacterExpressions[menuView.groupName]?.label === label,
          onClick: () => { void selectMultiCharacterExpression(menuView.groupName, label, imageId) },
        })),
      ]
    }

    const items: ContextMenuEntry[] = []

    if (isMultiCharacterCardMode) {
      if (directMultiCharacterGroup) {
        items.push({
          key: 'manual-multi-character-expression',
          label: t('expressionDisplay.switchExpressionFor', {
            name: getStackedName(directMultiCharacterGroup),
          }),
          onClick: () => setMenuView({
            kind: 'multi-character-expression-picker',
            groupName: directMultiCharacterGroup,
          }),
        })
      } else {
        items.push({
          key: 'manual-multi-character',
          label: t('expressionDisplay.chooseCharacter'),
          onClick: () => setMenuView({ kind: 'multi-character-picker' }),
        })
      }
      items.push({ key: 'manual-divider', type: 'divider' as const })
    } else if (isGroupExpressionMode) {
      if (directGroupMenuCharId) {
        items.push({
          key: 'manual-group-expression',
          label: t('expressionDisplay.switchExpressionFor', {
            name: characters.find((c) => c.id === directGroupMenuCharId)?.name || t('characterFallback'),
          }),
          onClick: () => setMenuView({ kind: 'group-expression-picker', characterId: directGroupMenuCharId }),
        })
      } else {
        items.push({
          key: 'manual-group-character',
          label: t('expressionDisplay.chooseCharacter'),
          onClick: () => setMenuView({ kind: 'group-character-picker' }),
        })
      }
      items.push({ key: 'manual-divider', type: 'divider' as const })
    } else if (hasExpressions && exprConfig && resolvedCharId) {
      items.push({
        key: 'manual-single-expression',
        label: t('expressionDisplay.switchExpression'),
        onClick: () => setMenuView({ kind: 'single-picker' }),
      })
      items.push({ key: 'manual-divider', type: 'divider' as const })
    }

    items.push(
      ...(['small', 'medium', 'large'] as const).map((preset) => ({
        key: `size-${preset}`,
        label: t(`expressionDisplay.size${preset.charAt(0).toUpperCase()}${preset.slice(1)}` as 'expressionDisplay.sizeSmall'),
        active: display.sizePreset === preset,
        onClick: () => selectSize(preset),
      })),
      { key: 'div-1', type: 'divider' as const },
      {
        key: 'opacity',
        type: 'custom' as const,
        content: (
          <div className={styles.opacityRow}>
            <span>{t('expressionDisplay.opacity')}</span>
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
        label: display.frameless ? t('expressionDisplay.showFrame') : t('expressionDisplay.hideFrame'),
        onClick: () => { setExpressionDisplay({ frameless: !display.frameless }); closeContextMenu() },
      },
      {
        key: 'click-through',
        label: display.clickThrough ? t('expressionDisplay.disableClickThrough') : t('expressionDisplay.enableClickThrough'),
        active: display.clickThrough,
        onClick: () => { setExpressionDisplay({ clickThrough: !display.clickThrough }); closeContextMenu() },
      },
      {
        key: 'minimize',
        label: t('expressionDisplay.minimize'),
        onClick: () => { toggleMinimized(); closeContextMenu() },
      },
      {
        key: 'hide',
        label: t('expressionDisplay.hide'),
        onClick: () => { setExpressionDisplay({ enabled: false }); closeContextMenu() },
      },
      {
        key: 'reset',
        label: t('expressionDisplay.resetPosition'),
        onClick: () => {
          const nx = window.innerWidth - containerSize.width - 24
          const ny = window.innerHeight - containerSize.height - 100
          setPos({ x: nx, y: ny })
          setExpressionDisplay({ x: nx, y: ny })
          closeContextMenu()
        },
      },
    )

    return items
  }, [
    menuView,
    exprConfig,
    resolvedCharId,
    expressionCharacterId,
    currentExpression,
    groupExpressionCharIds,
    activeMultiCharacterGroups,
    characters,
    groupConfigs,
    multiCharacterGroups,
    multiCharacterExpressions,
    getGroupCharLabel,
    getStackedName,
    directGroupMenuCharId,
    directMultiCharacterGroup,
    isGroupExpressionMode,
    isMultiCharacterCardMode,
    hasExpressions,
    display.sizePreset,
    display.opacity,
    display.frameless,
    display.clickThrough,
    containerSize,
    selectSize,
    setExpressionDisplay,
    toggleMinimized,
    closeContextMenu,
    selectSingleExpression,
    selectGroupExpression,
    selectMultiCharacterExpression,
    t,
  ])

  // ── Visibility gate ──
  if (!display.enabled) return null
  if (!isStackedExpressionMode && (!hasExpressions || !currentImageUrl)) return null

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

    const minimizedTitle = isStackedExpressionMode
      ? stackedExpressionKeys.map(getStackedName).join(', ')
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
            {isStackedExpressionMode
              ? stackedExpressionKeys.length.toString()
              : (character?.name || '?')[0].toUpperCase()
            }
          </span>
        </div>
        <ContextMenu position={contextMenu} items={contextMenuItems} onClose={closeContextMenu} />
      </>,
      document.body
    )
  }

  // ── Drag handle name ──
  const handleDisplayName = isStackedExpressionMode
    ? stackedExpressionKeys.map(getStackedName).join(' / ')
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
        {isStackedExpressionMode ? (
          /* ── Multi-sprite expression row ── */
          <div
            className={styles.groupRow}
            onPointerDown={!display.clickThrough ? handlePointerDown : undefined}
            onPointerMove={!display.clickThrough ? handlePointerMove : undefined}
            onPointerUp={!display.clickThrough ? handlePointerUp : undefined}
          >
            {stackedExpressionKeys.map((key, idx) => {
              const imageUrl = getStackedImageUrl(key)
              const label = getStackedLabel(key)
              const isResponding = isGroupExpressionMode && isStreaming && respondingCharacterId === key
              const isHovered = hoveredCharId === key
              const isActive = isResponding || isHovered
              const displayName = getStackedName(key)
              const marginLeft = idx === 0 ? 0 : -groupSlotOverlap

              return (
                <div
                  key={key}
                  className={[
                    styles.groupSlot,
                    isActive ? styles.groupSlotActive : styles.groupSlotIdle,
                  ].join(' ')}
                  style={{
                    width: size.width,
                    marginLeft,
                    zIndex: isHovered ? 3 : isResponding ? 2 : 1,
                  }}
                  onMouseEnter={() => setHoveredCharId(key)}
                  onMouseLeave={() => setHoveredCharId(null)}
                  onContextMenu={!display.clickThrough ? (e) => handleGroupSlotContextMenu(e, key) : undefined}
                >
                  <AnimatePresence mode="sync">
                    {imageUrl && readyUrls.has(imageUrl) && (
                      <motion.img
                        key={imageUrl}
                        src={imageUrl}
                        alt={label || displayName}
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
                    {displayName}{label ? ` — ${label}` : ''}
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

      <ContextMenu position={contextMenu} items={contextMenuItems} onClose={closeContextMenu} />
    </>,
    document.body
  )
}
