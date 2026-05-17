import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode, type TouchEvent, type WheelEvent } from 'react'
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { useChunkedMessages } from '@/hooks/useChunkedMessages'
import {
  subscribeTagInterceptorRegistry,
  getTagInterceptorRegistryVersion,
} from '@/lib/spindle/message-interceptors'
import { useStore } from '@/store'
import MessageCard from './MessageCard'
import GroupChatProgressBar from './GroupChatProgressBar'
import GroupChatMemberBar from './GroupChatMemberBar'
import type { Message } from '@/types/api'
import styles from './MessageList.module.css'

interface MessageListProps {
  messages: Message[]
  chatId: string
  isStreaming: boolean
}

const TOP_LOAD_THRESHOLD = 96
const CHAT_SCROLL_TO_BOTTOM_EVENT = 'lumiverse:chat-scroll-bottom'
const MESSAGE_CONTENT_LAYOUT_EVENT = 'lumiverse:message-content-layout'
const MIN_MEASURED_ROW_HEIGHT = 32
const MAX_ESTIMATED_ROW_HEIGHT = 900
const MOBILE_MOMENTUM_SETTLE_MS = 260
const MOBILE_RANGE_WARM_MS = 1200

type VirtualListItem =
  | { type: 'loadingOlder'; key: string }
  | { type: 'message'; key: string; measureKey: string; message: Message; messageIndex: number }
  | { type: 'progressBar'; key: string }
  | { type: 'error'; key: string; error: string }
  | { type: 'messageFooter'; key: string }
  | { type: 'bottom'; key: string }

function getTopLoadThreshold(clientHeight: number, isCoarsePointer: boolean) {
  if (!isCoarsePointer) return TOP_LOAD_THRESHOLD
  return Math.max(TOP_LOAD_THRESHOLD, Math.round(clientHeight * 1.15), 420)
}

function clampEstimate(value: number) {
  return Math.max(MIN_MEASURED_ROW_HEIGHT, Math.min(MAX_ESTIMATED_ROW_HEIGHT, value))
}

function clampMeasuredRowHeight(value: number) {
  if (!Number.isFinite(value)) return MIN_MEASURED_ROW_HEIGHT
  return Math.max(MIN_MEASURED_ROW_HEIGHT, value)
}

function getUiScale() {
  if (typeof window === 'undefined') return 1
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function getFontScale() {
  if (typeof window === 'undefined') return 1
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-font-scale')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function getElementLayoutHeight(element: Element) {
  if (element instanceof HTMLElement && element.offsetHeight > 0) {
    return element.offsetHeight
  }

  // getBoundingClientRect() is affected by body-level CSS zoom; virtualizer
  // coordinates are not, so normalize the rare rect fallback to layout pixels.
  return element.getBoundingClientRect().height / getUiScale()
}

function hashString(value: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16)
}

function stripHtmlForEstimate(value: string) {
  return value.replace(/<[^>]+>/g, ' ')
}

function collapseClosedDetailsForEstimate(value: string) {
  return value.replace(/<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/gi, (_match, inner: string) => {
    const summary = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1]
    return stripHtmlForEstimate(summary ?? 'Details')
  })
}

export default function MessageList({ messages, chatId, isStreaming }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isPinnedRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const topLoadArmedRef = useRef(true)
  const touchYRef = useRef<number | null>(null)
  const { visibleMessages, hasMore, loadMore, loadingOlder, justPrependedRef } = useChunkedMessages(messages, chatId)
  const lastScrollHeightRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const measuredRowHeightsRef = useRef<Map<string, number>>(new Map())
  const averageMeasuredHeightRef = useRef<number | null>(null)
  const prependVisualOffsetRef = useRef(0)
  const isPrependingRef = useRef(false)
  const suppressNextPinUpdateRef = useRef(false)
  const touchMomentumHoldRef = useRef(false)
  const touchMomentumTimerRef = useRef<number | null>(null)
  const rangeWarmTimerRef = useRef<number | null>(null)
  const [isCoarsePointer, setIsCoarsePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  )
  const [mobileRangeWarm, setMobileRangeWarm] = useState(true)
  const [prependVisualOffset, setPrependVisualOffsetState] = useState(0)
  const interceptorRegistryVersion = useSyncExternalStore(
    subscribeTagInterceptorRegistry,
    getTagInterceptorRegistryVersion,
    getTagInterceptorRegistryVersion,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia('(pointer: coarse)')
    const update = () => setIsCoarsePointer(mediaQuery.matches)
    update()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', update)
      return () => mediaQuery.removeEventListener('change', update)
    }

    mediaQuery.addListener(update)
    return () => mediaQuery.removeListener(update)
  }, [])

  // Re-arm top-pagination on chat switch.
  useEffect(() => {
    topLoadArmedRef.current = true
    lastScrollTopRef.current = 0
    measuredRowHeightsRef.current = new Map()
    averageMeasuredHeightRef.current = null
  }, [chatId])

  const setPrependVisualOffset = useCallback((next: number) => {
    const clamped = Math.max(0, Math.round(next))
    prependVisualOffsetRef.current = clamped
    setPrependVisualOffsetState((prev) => (prev === clamped ? prev : clamped))
  }, [])

  const flushPrependVisualOffset = useCallback(() => {
    const el = scrollRef.current
    const pendingOffset = prependVisualOffsetRef.current
    if (!el || pendingOffset <= 0) return

    // Convert any temporary visual-only prepend offset back into real scroll
    // position once touch momentum settles so history loading can't get stuck
    // behind a synthetic top gap.
    isProgrammaticScrollRef.current = true
    el.scrollTop += pendingOffset
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    setPrependVisualOffset(0)
  }, [setPrependVisualOffset])

  const warmMobileRange = useCallback((duration = MOBILE_RANGE_WARM_MS) => {
    setMobileRangeWarm(true)
    if (rangeWarmTimerRef.current != null) {
      window.clearTimeout(rangeWarmTimerRef.current)
    }
    rangeWarmTimerRef.current = window.setTimeout(() => {
      setMobileRangeWarm(false)
      rangeWarmTimerRef.current = null
    }, duration)
  }, [isCoarsePointer])
  const streamingError = useStore((s) => s.streamingError)
  const displayMode = useStore((s) => s.chatSheldDisplayMode)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const isNudgeLoopActive = useStore((s) => s.isNudgeLoopActive)
  const isBubble = displayMode === 'bubble'
  const estimateSize = isBubble ? 260 : 180

  const virtualListItems = useMemo<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = []

    if (loadingOlder && !isCoarsePointer) {
      items.push({ type: 'loadingOlder', key: 'loading-older' })
    }

    for (let index = 0; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index]
      const content = message.swipes?.[message.swipe_id] ?? message.content ?? ''
      const attachmentCount = message.extra?.attachments?.length ?? 0
      const measureKey = [
        'message',
        message.id,
        displayMode,
        message.swipe_id,
        message.swipes?.length ?? 0,
        hashString(content),
        attachmentCount,
        message.extra?.reasoning ? 'reasoning' : 'no-reasoning',
        message.extra?.hidden ? 'hidden' : 'visible',
      ].join(':')

      items.push({
        type: 'message',
        key: measureKey,
        measureKey,
        message,
        messageIndex: index,
      })
    }

    if (isGroupChat && isNudgeLoopActive) {
      items.push({ type: 'progressBar', key: 'group-progress' })
    }

    if (streamingError) {
      items.push({ type: 'error', key: `streaming-error:${hashString(streamingError)}`, error: streamingError })
    }

    items.push({ type: 'messageFooter', key: 'message-footer' })
    items.push({ type: 'bottom', key: 'bottom' })

    return items
  }, [displayMode, isCoarsePointer, isGroupChat, isNudgeLoopActive, loadingOlder, streamingError, visibleMessages])

  useEffect(() => {
    measuredRowHeightsRef.current = new Map()
    averageMeasuredHeightRef.current = null
  }, [displayMode, isCoarsePointer])

  useEffect(() => {
    warmMobileRange()
  }, [chatId, warmMobileRange])

  useEffect(() => {
    if (interceptorRegistryVersion === 0) return
    warmMobileRange(1500)
  }, [interceptorRegistryVersion, warmMobileRange])

  useEffect(() => {
    return () => {
      if (touchMomentumTimerRef.current != null) {
        window.clearTimeout(touchMomentumTimerRef.current)
      }
      if (rangeWarmTimerRef.current != null) {
        window.clearTimeout(rangeWarmTimerRef.current)
      }
    }
  }, [])

  const estimateMessageSize = useCallback((message: Message, measureKey: string) => {
    const measured = measuredRowHeightsRef.current.get(measureKey)
    if (measured) return measured

    const el = scrollRef.current
    const width = Math.max(240, el?.clientWidth ?? 720)
    const isCompactWidth = width <= 768
    const isPhoneWidth = width <= 480
    const bubbleInset = isPhoneWidth ? 20 : isCompactWidth ? 28 : 48
    const bubbleWidth = isBubble ? Math.max(180, width - bubbleInset) : width * (isCompactWidth ? 0.9 : 0.82)
    const charsPerLine = Math.max(24, Math.floor(bubbleWidth / 7.2))
    const content = message.swipes?.[message.swipe_id] ?? message.content ?? ''
    const layoutContent = collapseClosedDetailsForEstimate(content)
    const explicitLines = layoutContent.split('\n').length
    const wrappedLines = Math.ceil(layoutContent.length / charsPerLine)
    const lineCount = Math.max(1, explicitLines, wrappedLines)
    const codeBlockCount = (layoutContent.match(/```/g)?.length ?? 0) / 2
    const imageCount = message.extra?.attachments?.filter((a) => a.type === 'image').length ?? 0
    const audioCount = message.extra?.attachments?.filter((a) => a.type === 'audio').length ?? 0
    const inlineStyleCount = layoutContent.match(/\bstyle\s*=/gi)?.length ?? 0
    const htmlBlockCount = layoutContent.match(/<(div|section|article|aside|nav|main|header|footer|form|fieldset|figure|details|table|tr|td|th|iframe|svg|video|audio)\b/gi)?.length ?? 0
    const hasStyledHtml = /<style[\s>]|\bstyle\s*=|<(div|section|article|aside|nav|main|header|footer|form|fieldset|figure|details|table|iframe|svg|video|audio)\b/i.test(layoutContent)
    const customTagCount = layoutContent.match(/<([a-z][\w]*-[\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi)?.length ?? 0
    const selfClosingCustomTagCount = layoutContent.match(/<([a-z][\w]*-[\w-]*)\b[^>]*\/>/gi)?.length ?? 0
    const hasExtensionTags = customTagCount > 0 || selfClosingCustomTagCount > 0
    const base = isBubble ? (isPhoneWidth ? 88 : isCompactWidth ? 96 : 104) : 76
    const lineHeight = 23
    const mediaHeight = imageCount > 0 ? (isPhoneWidth ? 190 : isCompactWidth ? 220 : 250) : 0
    const audioHeight = audioCount * 58
    const codeHeight = codeBlockCount * 44
    const htmlBoost = hasStyledHtml
      ? Math.min(520, 120 + htmlBlockCount * 26 + inlineStyleCount * 18)
      : 0
    const htmlFloor = hasStyledHtml
      ? (isPhoneWidth ? 240 : isCompactWidth ? 300 : 340)
      : 0
    const extensionTagBoost = hasExtensionTags
      ? Math.min(360, 110 + customTagCount * 72 + selfClosingCustomTagCount * 56)
      : 0
    const extensionTagFloor = hasExtensionTags
      ? (isPhoneWidth ? 190 : isCompactWidth ? 230 : 260)
      : 0
    const contentEstimate = Math.max(
      base + lineCount * lineHeight + mediaHeight + audioHeight + codeHeight + htmlBoost + extensionTagBoost,
      htmlFloor,
      extensionTagFloor,
    )
    const average = averageMeasuredHeightRef.current

    // Blend content heuristics with the measured chat average so unknown rows
    // near the loaded tail don't all start from the same poor fixed estimate.
    return clampEstimate(average ? (contentEstimate * 0.7 + average * 0.3) : contentEstimate)
  }, [isBubble])

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range))
    const nearTail = range.endIndex >= range.count - (isCoarsePointer ? 10 : 8)
    const isWarm = mobileRangeWarm || nearTail
    const extraBefore = isCoarsePointer ? (isWarm ? 32 : 18) : (isWarm ? 18 : 8)
    const extraAfter = isCoarsePointer ? (isWarm ? 10 : 6) : (isWarm ? 5 : 3)
    const start = Math.max(0, range.startIndex - extraBefore)
    const end = Math.min(range.count - 1, range.endIndex + extraAfter)

    for (let index = start; index <= end; index++) {
      indexes.add(index)
    }

    return Array.from(indexes).sort((a, b) => a - b)
  }, [isCoarsePointer, mobileRangeWarm])

  const getItemKey = useCallback(
    (index: number) => {
      const item = virtualListItems[index]
      return item ? item.key : index
    },
    [virtualListItems]
  )

  const rowVirtualizer = useVirtualizer({
    count: virtualListItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = virtualListItems[index]
      if (!item) return estimateSize
      switch (item.type) {
        case 'message':
          return estimateMessageSize(item.message, item.measureKey)
        case 'loadingOlder':
          return 44
        case 'progressBar':
          return 48
        case 'error':
          return 72
        case 'messageFooter':
        case 'bottom':
          return 1
      }
    },
    overscan: isCoarsePointer ? 12 : 8,
    getItemKey,
    rangeExtractor,
    useAnimationFrameWithResizeObserver: true,
    measureElement: (element, entry) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize
      const rawMeasured = size ?? getElementLayoutHeight(element)
      const measured = element.getAttribute('data-item-type') === 'message'
        ? clampMeasuredRowHeight(rawMeasured)
        : Math.max(1, Number.isFinite(rawMeasured) ? rawMeasured : 1)
      const measureKey = element.getAttribute('data-measure-key')
      if (measureKey && measured >= MIN_MEASURED_ROW_HEIGHT) {
        measuredRowHeightsRef.current.set(measureKey, measured)
        const values = Array.from(measuredRowHeightsRef.current.values())
        const sample = values.slice(-80)
        averageMeasuredHeightRef.current = sample.reduce((sum, value) => sum + value, 0) / sample.length
      }
      return measured
    },
  })

  const measureMountedRows = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    const rows = el.querySelectorAll<HTMLElement>('[data-virtual-index]')
    for (const row of rows) {
      rowVirtualizer.measureElement(row)
    }
  }, [rowVirtualizer])

  useEffect(() => {
    let pendingRaf = 0
    let settleTimer = 0
    let lastWidth = scrollRef.current?.clientWidth ?? window.innerWidth
    let lastUiScale = getUiScale()
    let lastFontScale = getFontScale()

    const scheduleMountedMeasure = () => {
      if (!pendingRaf) {
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0
          measureMountedRows()
        })
      }

      if (settleTimer) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        settleTimer = 0
        measureMountedRows()
      }, 180)
    }

    const handleResize = () => {
      // estimateMessageSize derives only from column width. A height-only
      // resize (mobile soft keyboard open/close) leaves every estimate valid,
      // so wiping the measured-height cache there forces every row back onto
      // the heuristic estimate. Measure mounted rows in-place instead of
      // invalidating the whole list; newly mounted rows measure themselves.
      const nextWidth = scrollRef.current?.clientWidth ?? window.innerWidth
      const nextUiScale = getUiScale()
      const nextFontScale = getFontScale()
      if (nextWidth === lastWidth && nextUiScale === lastUiScale && nextFontScale === lastFontScale) return
      lastWidth = nextWidth
      lastUiScale = nextUiScale
      lastFontScale = nextFontScale
      scheduleMountedMeasure()
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      if (settleTimer) window.clearTimeout(settleTimer)
    }
  }, [measureMountedRows])

  useLayoutEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
      const scrollOffset = rowVirtualizer.scrollOffset ?? scrollRef.current?.scrollTop ?? 0
      return item.end < scrollOffset
    }

    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()

  // Gate that keeps the keyboard/safe-zone repin from fighting the unified
  // scroll guard while streaming is active.
  const isStreamingRef = useRef(isStreaming)
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  const scrollToHistoryBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el || virtualListItems.length === 0) return

    isPinnedRef.current = true
    isProgrammaticScrollRef.current = true
    setPrependVisualOffset(0)
    rowVirtualizer.scrollToIndex(virtualListItems.length - 1, { align: 'end', behavior })

    requestAnimationFrame(() => {
      const latest = scrollRef.current
      if (!latest) return
      isProgrammaticScrollRef.current = true
      latest.scrollTop = latest.scrollHeight - latest.clientHeight
      lastScrollTopRef.current = latest.scrollTop
    })
  }, [rowVirtualizer, setPrependVisualOffset, virtualListItems.length])

  const BOTTOM_REPIN_EPSILON = 6

  const recoverTailVoid = useCallback(() => {
    // If user deliberately scrolled up, the streaming height-lock 
    // releasing at stream end must not snap them down.
    if (!isPinnedRef.current) return false

    const el = scrollRef.current
    if (!el || virtualListItems.length === 0) return false

    const items = rowVirtualizer.getVirtualItems()
    const lastItem = items[items.length - 1]
    const lastIndex = virtualListItems.length - 1
    if (!lastItem || lastItem.index !== lastIndex) return false

    const lastRow = el.querySelector<HTMLElement>(`[data-virtual-index="${lastIndex}"]`)
    if (!lastRow) return false

    const rowRect = lastRow.getBoundingClientRect()
    const scrollRect = el.getBoundingClientRect()
    const actualContentBottom = el.scrollTop + ((rowRect.bottom - scrollRect.top) / getUiScale())
    const viewportBottom = el.scrollTop + el.clientHeight
    const voidThreshold = Math.max(180, el.clientHeight * 0.55)

    if (viewportBottom <= actualContentBottom + voidThreshold) return false

    const visibleRows = el.querySelectorAll<HTMLElement>('[data-virtual-index]')
    for (const row of visibleRows) {
      rowVirtualizer.measureElement(row)
    }

    const nextScrollTop = Math.max(0, actualContentBottom - el.clientHeight)
    isProgrammaticScrollRef.current = true
    el.scrollTop = nextScrollTop
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    isPinnedRef.current = true
    return true
  }, [rowVirtualizer, virtualListItems.length])

  const updatePinState = (scrollTop: number, scrollHeight: number, clientHeight: number) => {
    const distance = scrollHeight - scrollTop - clientHeight
    isPinnedRef.current = distance <= BOTTOM_REPIN_EPSILON
  }

  // User scroll intent owns pinning: any upward scroll disables auto-follow,
  // and we only re-arm once the user actually returns to the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    if (recoverTailVoid()) return

    const deltaTop = el.scrollTop - lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop

    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false
      return
    }

    if (prependVisualOffsetRef.current > 0 && deltaTop < 0) {
      setPrependVisualOffset(prependVisualOffsetRef.current + deltaTop)
    }

    if (deltaTop < 0) {
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = false
    } else if (!suppressNextPinUpdateRef.current) {
      updatePinState(el.scrollTop, el.scrollHeight, el.clientHeight)
    } else {
      suppressNextPinUpdateRef.current = false
    }

    const topLoadThreshold = getTopLoadThreshold(el.clientHeight, isCoarsePointer)
    const effectiveScrollTop = el.scrollTop + prependVisualOffsetRef.current

    if (effectiveScrollTop > topLoadThreshold) {
      topLoadArmedRef.current = true
    }

    if (effectiveScrollTop <= topLoadThreshold && topLoadArmedRef.current && hasMore && !loadingOlder) {
      topLoadArmedRef.current = false
      loadMore()
    }
  }, [hasMore, isCoarsePointer, loadingOlder, loadMore, recoverTailVoid, setPrependVisualOffset])

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -30) {
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = true
    }
  }, [])

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (touchMomentumTimerRef.current != null) {
      window.clearTimeout(touchMomentumTimerRef.current)
      touchMomentumTimerRef.current = null
    }
    touchMomentumHoldRef.current = true
    touchYRef.current = event.touches[0]?.clientY ?? null
  }, [])

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const previousY = touchYRef.current
    const nextY = event.touches[0]?.clientY ?? null
    if (previousY != null && nextY != null && nextY > previousY + 10) {
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = true
    }
    touchYRef.current = nextY
  }, [])

  const releaseTouchMomentumHold = useCallback(() => {
    if (touchMomentumTimerRef.current != null) {
      window.clearTimeout(touchMomentumTimerRef.current)
    }
    touchMomentumTimerRef.current = window.setTimeout(() => {
      touchMomentumHoldRef.current = false
      flushPrependVisualOffset()
      touchMomentumTimerRef.current = null
    }, MOBILE_MOMENTUM_SETTLE_MS)
  }, [flushPrependVisualOffset])

  // Scroll anchoring: when older messages are prepended, adjust scrollTop so
  // the user's viewport stays on the same content instead of jumping to the top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (justPrependedRef.current) {
      isPrependingRef.current = true
      justPrependedRef.current = false
      warmMobileRange(900)
      const heightDiff = el.scrollHeight - lastScrollHeightRef.current
      if (heightDiff > 0 && lastScrollHeightRef.current > 0) {
        if (!isPinnedRef.current && isCoarsePointer && touchMomentumHoldRef.current) {
          setPrependVisualOffset(prependVisualOffsetRef.current + heightDiff)
        } else {
          isProgrammaticScrollRef.current = true
          el.scrollTop += heightDiff
          lastScrollTopRef.current = el.scrollTop
        }
      }
      isPrependingRef.current = false
    }

    lastScrollHeightRef.current = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop

    const topLoadThreshold = getTopLoadThreshold(el.clientHeight, isCoarsePointer)
    const effectiveScrollTop = el.scrollTop + prependVisualOffsetRef.current

    if (effectiveScrollTop > topLoadThreshold) {
      topLoadArmedRef.current = true
    }

    // If the viewport is still effectively unfilled after prepending a page,
    // fetch one more page without waiting for another user scroll.
    if (!loadingOlder && hasMore && el.scrollHeight <= el.clientHeight + TOP_LOAD_THRESHOLD) {
      topLoadArmedRef.current = false
      requestAnimationFrame(() => {
        loadMore()
      })
    }
  }, [virtualItems, justPrependedRef, hasMore, isCoarsePointer, loadingOlder, loadMore, setPrependVisualOffset, warmMobileRange])

  // Unified scroll guard: watches scrollHeight changes caused by streaming
  // tokens, extension mounts, lazy image loads, or virtual row resizing.
  // When pinned we follow the bottom; when floating we leave the viewport
  // alone so the user can read without being pushed around by new content.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    let pendingRaf = 0
    let lastSH = el.scrollHeight
    let lastST = el.scrollTop

    const apply = () => {
      pendingRaf = 0
      const latest = scrollRef.current
      if (!latest) return
      if (justPrependedRef.current || isPrependingRef.current) return

      const newSH = latest.scrollHeight
      const newST = latest.scrollTop
      const heightDelta = newSH - lastSH
      const scrollTopDelta = newST - lastST

      lastSH = newSH
      lastST = newST

      if (recoverTailVoid()) return

      if (heightDelta === 0) return

      // If scrollTop already moved by roughly the height change, something
      // else (e.g. the virtualizer's shouldAdjustScrollPositionOnItemSizeChange)
      // handled it — don't double-compensate.
      if (Math.abs(scrollTopDelta - heightDelta) < 2) return

      // Only auto-scroll when the user is already pinned to the bottom.
      // If they have scrolled up to read older messages, anchor the view
      // so streaming tokens (or any other bottom growth) don't push content
      // up the screen.
      if (isPinnedRef.current) {
        isProgrammaticScrollRef.current = true
        latest.scrollTop = latest.scrollHeight - latest.clientHeight
      }
    }

    const mo = new MutationObserver(() => {
      if (pendingRaf) return
      pendingRaf = requestAnimationFrame(apply)
    })

    mo.observe(el, { childList: true, subtree: true, characterData: true })

    return () => {
      mo.disconnect()
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
    }
  }, [isCoarsePointer, recoverTailVoid, rowVirtualizer])

  // Re-pin to bottom when the input safe-zone changes — keyboard opening on
  // mobile/iOS PWA grows --lcs-input-safe-zone. Without this, the last
  // message would stay behind the newly-raised input bar.
  useEffect(() => {
    const el = scrollRef.current
    const parent = el?.parentElement
    if (!el || !parent) return

    const settleTimers: number[] = []
    const clearSettleTimers = () => {
      while (settleTimers.length) {
        window.clearTimeout(settleTimers.shift())
      }
    }

    const pinToBottom = () => {
      if (!isPinnedRef.current) return
      const latest = scrollRef.current
      if (!latest) return
      isProgrammaticScrollRef.current = true
      latest.scrollTop = latest.scrollHeight - latest.clientHeight
    }

    // iOS keyboard animation (~250-350ms) fires multiple visualViewport
    // resize events. A single rAF-pin can land mid-animation, so we pin
    // immediately AND schedule settling retries to catch the final layout
    // once the keyboard and safe-zone have settled. Skipped while streaming
    // — the unified scroll guard already handles content growth.
    const repinIfAnchored = () => {
      if (isStreamingRef.current) return
      if (!isPinnedRef.current) return
      requestAnimationFrame(pinToBottom)
      clearSettleTimers()
      settleTimers.push(window.setTimeout(pinToBottom, 180))
      settleTimers.push(window.setTimeout(pinToBottom, 420))
    }

    const mo = new MutationObserver(repinIfAnchored)
    mo.observe(parent, { attributes: true, attributeFilter: ['style'] })

    const vv = window.visualViewport
    vv?.addEventListener('resize', repinIfAnchored)
    vv?.addEventListener('scroll', repinIfAnchored)

    return () => {
      mo.disconnect()
      vv?.removeEventListener('resize', repinIfAnchored)
      vv?.removeEventListener('scroll', repinIfAnchored)
      clearSettleTimers()
    }
  }, [])

  // Scroll to bottom on chat change — always pin when switching chats
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      isPinnedRef.current = true
      isProgrammaticScrollRef.current = true
      setPrependVisualOffset(0)
      el.scrollTop = el.scrollHeight - el.clientHeight
      lastScrollTopRef.current = el.scrollTop
    }
  }, [chatId, setPrependVisualOffset])

  useEffect(() => {
    const handleScrollToBottom = () => scrollToHistoryBottom('smooth')
    window.addEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
    return () => window.removeEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
  }, [scrollToHistoryBottom])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    let pendingRaf = 0
    let settleRaf = 0

    const handleMessageContentLayout = () => {
      if (pendingRaf) return
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0
        measureMountedRows()

        if (recoverTailVoid()) return
        if (!settleRaf) {
          settleRaf = requestAnimationFrame(() => {
            settleRaf = 0
            recoverTailVoid()
          })
        }

        const latest = scrollRef.current
        if (!latest || !isPinnedRef.current) return
        isProgrammaticScrollRef.current = true
        latest.scrollTop = latest.scrollHeight - latest.clientHeight
        lastScrollTopRef.current = latest.scrollTop
        lastScrollHeightRef.current = latest.scrollHeight
      })
    }

    el.addEventListener(MESSAGE_CONTENT_LAYOUT_EVENT, handleMessageContentLayout)
    return () => {
      el.removeEventListener(MESSAGE_CONTENT_LAYOUT_EVENT, handleMessageContentLayout)
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      if (settleRaf) cancelAnimationFrame(settleRaf)
    }
  }, [measureMountedRows, recoverTailVoid])

  return (
    <div
      data-component="MessageList"
      className={styles.list}
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={releaseTouchMomentumHold}
      onTouchCancel={releaseTouchMomentumHold}
      data-chat-scroll="true"
      data-group-chat={isGroupChat || undefined}
    >
      {isGroupChat && <GroupChatMemberBar chatId={chatId} />}
      <div
        className={styles.virtualSpace}
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualRow) => {
          const item = virtualListItems[virtualRow.index]
          if (!item) return null

          let content: ReactNode = null
          let messageId: string | undefined
          let messageIndex: number | undefined
          let measureKey: string | undefined

          switch (item.type) {
            case 'loadingOlder':
              content = <div className={styles.loadingOlder}>Loading older messages...</div>
              break
            case 'message':
              messageId = item.message.id
              messageIndex = item.messageIndex
              measureKey = item.measureKey
              content = (
                <MessageCard
                  message={item.message}
                  chatId={chatId}
                  depth={visibleMessages.length - 1 - item.messageIndex}
                />
              )
              break
            case 'progressBar':
              content = <GroupChatProgressBar />
              break
            case 'error':
              content = (
                <div className={styles.errorBubble}>
                  <span className={styles.errorLabel}>Generation failed:</span> {item.error}
                </div>
              )
              break
            case 'messageFooter':
              content = <div data-spindle-mount="message_footer" />
              break
            case 'bottom':
              content = <div ref={bottomRef} />
              break
          }

          return (
            <VirtualRow
              key={virtualRow.key}
              virtualIndex={virtualRow.index}
              itemType={item.type}
              messageIndex={messageIndex}
              messageId={messageId}
              measureKey={measureKey}
              start={virtualRow.start}
              visualOffset={prependVisualOffset}
              measureElement={rowVirtualizer.measureElement}
            >
              {content}
            </VirtualRow>
          )
        })}
      </div>
    </div>
  )
}

interface VirtualRowProps {
  virtualIndex: number
  itemType: VirtualListItem['type']
  messageIndex?: number
  messageId?: string
  measureKey?: string
  start: number
  visualOffset: number
  measureElement: (el: Element | null) => void
  children: ReactNode
}

function VirtualRow({ virtualIndex, itemType, messageIndex, messageId, measureKey, start, visualOffset, measureElement, children }: VirtualRowProps) {
  const elRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return

    let pendingRaf = 0
    const settleTimers: number[] = []

    const measure = () => {
      measureElement(el)
    }

    const scheduleMeasure = () => {
      if (pendingRaf) return
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0
        measure()
      })
    }

    // Initial measure during commit, before paint
    measure()
    for (const delay of [80, 180, 420, 900]) {
      settleTimers.push(window.setTimeout(scheduleMeasure, delay))
    }

    // Own immediate ResizeObserver bypasses the virtualizer's rAF-batched
    // observer so dynamic content (extension interceptor injections, lazy
    // images, etc.) updates row heights without a one-frame delay.
    const ro = new ResizeObserver(() => {
      measure()
    })
    ro.observe(el)

    const mo = new MutationObserver(scheduleMeasure)
    mo.observe(el, { childList: true, subtree: true, attributes: true, characterData: true })

    el.addEventListener('load', scheduleMeasure, true)
    el.addEventListener('error', scheduleMeasure, true)

    return () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      for (const timer of settleTimers) window.clearTimeout(timer)
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('load', scheduleMeasure, true)
      el.removeEventListener('error', scheduleMeasure, true)
      measureElement(null)
    }
  }, [measureElement])

  return (
    <div
      ref={elRef}
      data-virtual-index={virtualIndex}
      data-item-type={itemType}
      data-index={virtualIndex}
      data-message-index={messageIndex}
      data-message-id={messageId}
      data-measure-key={measureKey}
      className={styles.virtualRow}
      style={{ transform: `translateY(${start - visualOffset}px)` }}
    >
      {children}
    </div>
  )
}
