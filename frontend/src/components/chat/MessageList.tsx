import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, useSyncExternalStore, startTransition, type ReactNode, type TouchEvent, type WheelEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { useChunkedMessages } from '@/hooks/useChunkedMessages'
import {
  subscribeTagInterceptorRegistry,
  getTagInterceptorRegistryVersion,
} from '@/lib/spindle/message-interceptors'
import { useStore } from '@/store'
import { parseOOC, type OOCBlock } from '@/lib/oocParser'
import MessageCard from './MessageCard'
import GroupChatProgressBar from './GroupChatProgressBar'
import GroupChatMemberBar from './GroupChatMemberBar'
import type { Message } from '@/types/api'
import type { OOCStyleType } from '@/types/store'
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
// After touchend, the prepend visual offset is only flushed once scroll events
// have been quiet for this long. A fixed post-touchend timer lands mid-fling on
// iOS (momentum runs 1-2s) and the scrollTop write kills the fling dead.
const MOBILE_MOMENTUM_QUIET_MS = 150
// Hard ceiling on flush deferral so a busy event source (streaming repins,
// settle re-measures) can't postpone history rebasing indefinitely.
const MOBILE_MOMENTUM_FLUSH_CAP_MS = 4000
const MOBILE_RANGE_WARM_MS = 1200
// How long after the first rows render before the mounted range widens from
// the cold-start window to the full warm range. Long enough for the initial
// frame to paint on slow devices, short enough that early scrolling still
// finds rows mounted.
const INITIAL_RANGE_WARM_DELAY_MS = 300

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

// Heuristic chrome/line-height contributions per Lumia OOC display mode. These
// only need to be roughly right; ResizeObserver corrects to the true height on
// mount and the result is cached in measuredRowHeightsRef. Wrong here just
// causes a one-frame scroll jump when an OOC-heavy row first mounts.
const OOC_MODE_ESTIMATE: Record<OOCStyleType, {
  groupChrome: number
  entryChrome: number
  lineHeight: number
  widthInset: number
  maxBlockHeight: number
}> = {
  irc:     { groupChrome: 64, entryChrome: 36, lineHeight: 22, widthInset: 64, maxBlockHeight: 220 },
  social:  { groupChrome: 0,  entryChrome: 88, lineHeight: 22, widthInset: 80, maxBlockHeight: 320 },
  whisper: { groupChrome: 0,  entryChrome: 56, lineHeight: 22, widthInset: 96, maxBlockHeight: 280 },
  margin:  { groupChrome: 0,  entryChrome: 44, lineHeight: 22, widthInset: 56, maxBlockHeight: 240 },
  raw:     { groupChrome: 0,  entryChrome: 12, lineHeight: 22, widthInset: 0,  maxBlockHeight: 200 },
}

function estimateOOCContribution(blocks: OOCBlock[], mode: OOCStyleType, bubbleWidth: number) {
  let count = 0
  let totalEntryHeight = 0
  const params = OOC_MODE_ESTIMATE[mode] ?? OOC_MODE_ESTIMATE.social
  const entryWidth = Math.max(140, bubbleWidth - params.widthInset)
  const entryCharsPerLine = Math.max(20, Math.floor(entryWidth / 7.2))

  for (const block of blocks) {
    if (block.type !== 'ooc') continue
    count += 1
    const text = stripHtmlForEstimate(block.content)
    const explicitLines = text.split('\n').length
    const wrappedLines = Math.ceil(text.length / entryCharsPerLine) || 1
    const lines = Math.max(1, explicitLines, wrappedLines)
    totalEntryHeight += Math.min(params.maxBlockHeight, params.entryChrome + lines * params.lineHeight)
  }

  if (count === 0) return 0
  return params.groupChrome + totalEntryHeight
}

export default function MessageList({ messages, chatId, isStreaming }: MessageListProps) {
  const { t } = useTranslation('chat')
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isPinnedRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  // scrollTop recorded at the moment of a programmatic write. A scroll event
  // is only swallowed as programmatic when the position matches — a bare
  // boolean gets consumed by whichever event arrives first (on iOS that can be
  // Safari's own caret-reveal scroll), which eats the user-scroll unpin and
  // lets auto-repin fight the native scroll indefinitely.
  const programmaticScrollTargetRef = useRef<number | null>(null)
  const topLoadArmedRef = useRef(true)
  const touchYRef = useRef<number | null>(null)
  const { visibleMessages, hasMore, loadMore, loadingOlder, justPrependedRef } = useChunkedMessages(messages, chatId)
  const lastScrollHeightRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const measuredRowHeightsRef = useRef<Map<string, number>>(new Map())
  // Tracks the most recently measured row height per message.id, irrespective
  // of which swipe variant produced it. When a new variant has no measureKey
  // entry yet (first paint after a swipe), this is a far better initial
  // estimate than the content heuristic — especially for HTML-heavy bodies
  // where the heuristic can be hundreds of pixels off and the resulting
  // height delta would trigger scroll oscillation.
  const lastMeasuredByMessageIdRef = useRef<Map<string, number>>(new Map())
  const averageMeasuredHeightRef = useRef<number | null>(null)
  const prependVisualOffsetRef = useRef(0)
  const isPrependingRef = useRef(false)
  const suppressNextPinUpdateRef = useRef(false)
  const touchActiveRef = useRef(false)
  const touchMomentumTimerRef = useRef<number | null>(null)
  const momentumFlushDeadlineRef = useRef(0)
  const lastScrollAtRef = useRef(0)
  const rangeWarmTimerRef = useRef<number | null>(null)
  const initialBottomPinnedChatRef = useRef<string | null>(null)
  const [isCoarsePointer, setIsCoarsePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  )
  const [mobileRangeWarm, setMobileRangeWarm] = useState(true)
  // Initial mount staging: the first paint of a freshly opened chat mounts
  // only the viewport plus a tight overscan. The wide warm range (which can
  // mount the entire loaded page on touch devices) flips on shortly after, so
  // the per-message render pipeline doesn't block the first visible frame.
  const [initialRangeWarm, setInitialRangeWarm] = useState(false)
  const initialWarmTimerRef = useRef<number | null>(null)
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
    lastMeasuredByMessageIdRef.current = new Map()
    averageMeasuredHeightRef.current = null
    initialBottomPinnedChatRef.current = null
  }, [chatId])

  const setPrependVisualOffset = useCallback((next: number) => {
    const clamped = Math.max(0, Math.round(next))
    prependVisualOffsetRef.current = clamped
    setPrependVisualOffsetState((prev) => (prev === clamped ? prev : clamped))
  }, [])

  // Record a programmatic scrollTop write so handleScroll can identify the
  // matching event. Read back rather than store the requested value — the
  // browser clamps writes past the scroll range, and the clamped position is
  // what the scroll event will report.
  const markProgrammaticScroll = useCallback((el: HTMLElement) => {
    isProgrammaticScrollRef.current = true
    programmaticScrollTargetRef.current = el.scrollTop
  }, [])

  const flushPrependVisualOffset = useCallback(() => {
    const el = scrollRef.current
    const pendingOffset = prependVisualOffsetRef.current
    if (!el || pendingOffset <= 0) return

    // Convert any temporary visual-only prepend offset back into real scroll
    // position once scrolling has gone quiet so history loading can't get
    // stuck behind a synthetic top gap.
    el.scrollTop += pendingOffset
    markProgrammaticScroll(el)
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    setPrependVisualOffset(0)
  }, [markProgrammaticScroll, setPrependVisualOffset])

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
  const styleMode = useStore((s) => {
    const claims = s.chatStyleModes[chatId]
    return claims && Object.keys(claims).length > 0 ? 'extension-relaxed' as const : undefined
  })
  const lumiaOOCStyle = useStore((s) => s.lumiaOOCStyle)
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
        lumiaOOCStyle,
      ].join(':')

      // Key intentionally excludes content AND swipe_id: folding either in
      // remounts the row on every streamed token or variant swap, which
      // dumps the virtualizer back onto the heuristic estimate and triggers
      // a ResizeObserver cascade as the new content settles. MessageCard
      // re-renders reactively on prop change, so a stable row identity is
      // safe across variants.
      const key = ['message', message.id, displayMode].join(':')

      items.push({
        type: 'message',
        key,
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
  }, [displayMode, isCoarsePointer, isGroupChat, isNudgeLoopActive, loadingOlder, lumiaOOCStyle, streamingError, visibleMessages])

  useEffect(() => {
    measuredRowHeightsRef.current = new Map()
    lastMeasuredByMessageIdRef.current = new Map()
    averageMeasuredHeightRef.current = null
  }, [displayMode, isCoarsePointer, lumiaOOCStyle])

  useEffect(() => {
    setInitialRangeWarm(false)
    if (initialWarmTimerRef.current != null) {
      window.clearTimeout(initialWarmTimerRef.current)
      initialWarmTimerRef.current = null
    }
  }, [chatId])

  // Widen to the warm range once the first rows have painted. The flip mounts
  // the remaining offscreen rows in one go, so run it as a transition to keep
  // scrolling responsive while React renders them. The chat_id check matters
  // on chat switch: the previous chat's rows linger in the store until the new
  // tail arrives, and they must not start the warm timer early.
  const hasRows = visibleMessages.length > 0 && visibleMessages[0]?.chat_id === chatId
  useEffect(() => {
    if (!hasRows || initialRangeWarm) return
    initialWarmTimerRef.current = window.setTimeout(() => {
      initialWarmTimerRef.current = null
      startTransition(() => {
        setInitialRangeWarm(true)
        warmMobileRange()
      })
    }, INITIAL_RANGE_WARM_DELAY_MS)
    return () => {
      if (initialWarmTimerRef.current != null) {
        window.clearTimeout(initialWarmTimerRef.current)
        initialWarmTimerRef.current = null
      }
    }
  }, [hasRows, initialRangeWarm, warmMobileRange])

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
      if (initialWarmTimerRef.current != null) {
        window.clearTimeout(initialWarmTimerRef.current)
      }
    }
  }, [])

  const estimateMessageSize = useCallback((message: Message, measureKey: string) => {
    const measured = measuredRowHeightsRef.current.get(measureKey)
    if (measured) return measured

    // No entry for this exact variant yet — fall back to the row's prior
    // measured height before the heuristic. Bridges the gap between a
    // swipe / edit changing the measureKey and the ResizeObserver firing
    // with the new content's true size.
    const lastForMessage = lastMeasuredByMessageIdRef.current.get(message.id)
    if (lastForMessage) return lastForMessage

    const el = scrollRef.current
    const width = Math.max(240, el?.clientWidth ?? 720)
    const isCompactWidth = width <= 768
    const isPhoneWidth = width <= 480
    const bubbleInset = isPhoneWidth ? 20 : isCompactWidth ? 28 : 48
    const bubbleWidth = isBubble ? Math.max(180, width - bubbleInset) : width * (isCompactWidth ? 0.9 : 0.82)
    const charsPerLine = Math.max(24, Math.floor(bubbleWidth / 7.2))
    const content = message.swipes?.[message.swipe_id] ?? message.content ?? ''
    const layoutContent = collapseClosedDetailsForEstimate(content)

    // Lift OOC blocks out of the prose flow: they render as separate React
    // components (margin note / whisper / social / IRC chat room) with their
    // own chrome, so counting their text as inline prose double-counts height.
    const oocBlocks = parseOOC(layoutContent)
    const hasOOC = oocBlocks.some((b) => b.type === 'ooc')
    const proseContent = hasOOC
      ? oocBlocks.filter((b) => b.type === 'text').map((b) => b.content).join('\n')
      : layoutContent
    const oocHeight = hasOOC ? estimateOOCContribution(oocBlocks, lumiaOOCStyle, bubbleWidth) : 0

    const explicitLines = proseContent.split('\n').length
    const wrappedLines = Math.ceil(proseContent.length / charsPerLine)
    const lineCount = proseContent.length > 0 ? Math.max(1, explicitLines, wrappedLines) : 0
    const codeBlockCount = (proseContent.match(/```/g)?.length ?? 0) / 2
    const imageCount = message.extra?.attachments?.filter((a) => a.type === 'image').length ?? 0
    const audioCount = message.extra?.attachments?.filter((a) => a.type === 'audio').length ?? 0
    const inlineStyleCount = proseContent.match(/\bstyle\s*=/gi)?.length ?? 0
    const htmlBlockCount = proseContent.match(/<(div|section|article|aside|nav|main|header|footer|form|fieldset|figure|details|table|tr|td|th|iframe|svg|video|audio)\b/gi)?.length ?? 0
    const hasStyledHtml = /<style[\s>]|\bstyle\s*=|<(div|section|article|aside|nav|main|header|footer|form|fieldset|figure|details|table|iframe|svg|video|audio)\b/i.test(proseContent)
    const customTagCount = proseContent.match(/<([a-z][\w]*-[\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi)?.length ?? 0
    const selfClosingCustomTagCount = proseContent.match(/<([a-z][\w]*-[\w-]*)\b[^>]*\/>/gi)?.length ?? 0
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
      base + lineCount * lineHeight + mediaHeight + audioHeight + codeHeight + htmlBoost + extensionTagBoost + oocHeight,
      htmlFloor,
      extensionTagFloor,
    )
    const average = averageMeasuredHeightRef.current

    // Blend content heuristics with the measured chat average so unknown rows
    // near the loaded tail don't all start from the same poor fixed estimate.
    return clampEstimate(average ? (contentEstimate * 0.7 + average * 0.3) : contentEstimate)
  }, [isBubble, lumiaOOCStyle])

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range))
    // Cold start: only a tight band around the viewport so the expensive
    // per-message pipeline can't block the first paint of a freshly opened
    // chat. The warm flip shortly after mounts the rest.
    const nearTail = initialRangeWarm && range.endIndex >= range.count - (isCoarsePointer ? 10 : 8)
    const isWarm = initialRangeWarm && (mobileRangeWarm || nearTail)
    const extraBefore = !initialRangeWarm ? 4 : isCoarsePointer ? (isWarm ? 32 : 18) : (isWarm ? 18 : 8)
    const extraAfter = !initialRangeWarm ? 2 : isCoarsePointer ? (isWarm ? 10 : 6) : (isWarm ? 5 : 3)
    const start = Math.max(0, range.startIndex - extraBefore)
    const end = Math.min(range.count - 1, range.endIndex + extraAfter)

    for (let index = start; index <= end; index++) {
      indexes.add(index)
    }

    return Array.from(indexes).sort((a, b) => a - b)
  }, [isCoarsePointer, mobileRangeWarm, initialRangeWarm])

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
    overscan: initialRangeWarm ? (isCoarsePointer ? 12 : 8) : 3,
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
        const messageId = element.getAttribute('data-message-id')
        if (messageId) {
          lastMeasuredByMessageIdRef.current.set(messageId, measured)
        }
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
      const el = scrollRef.current
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight > SCROLLED_UP_EPSILON) {
        return false
      }
      const scrollOffset = rowVirtualizer.scrollOffset ?? el?.scrollTop ?? 0
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
  const streamEndSettleUntilRef = useRef(0)
  const reflowAnchorRef = useRef<{ el: HTMLElement; top: number } | null>(null)
  const settleRafRef = useRef(0)
  const STREAM_END_SETTLE_MS = 1200
  const SCROLLED_UP_EPSILON = 24

  const captureReflowAnchor = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      reflowAnchorRef.current = null
      return
    }
    const sRect = el.getBoundingClientRect()
    // Skip images/islands/widgets as they are the reflow, so they make a useless anchor.
    const blocks = el.querySelectorAll<HTMLElement>(
      '[data-virtual-index] :is(p,li,blockquote,h1,h2,h3,h4,h5,h6,pre)',
    )
    let anchor: HTMLElement | null = null
    for (const b of blocks) {
      if (b.closest('img,svg,video,canvas,iframe,[data-spindle-mount],[class*="_htmlIsland_"],[class*="_inlineImage_"]')) continue
      if (b.querySelector('img,svg,video,canvas,iframe')) continue
      if (!b.textContent?.trim()) continue
      const r = b.getBoundingClientRect()
      if (r.height < 8) continue
      if (r.top >= sRect.top - 2 && r.top < sRect.bottom) {
        anchor = b
        break
      }
    }
    reflowAnchorRef.current = anchor
      ? { el: anchor, top: anchor.getBoundingClientRect().top }
      : null
  }, [])

  const restoreReflowAnchor = useCallback(() => {
    const anchor = reflowAnchorRef.current
    const el = scrollRef.current
    if (!anchor || !el || !anchor.el.isConnected) return
    const delta = (anchor.el.getBoundingClientRect().top - anchor.top) / getUiScale()
    if (Math.abs(delta) < 1) return
    el.scrollTop += delta
    markProgrammaticScroll(el)
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [markProgrammaticScroll])

  // A one-shot correction misses the progressive reflow (deferred render,
  // async image loads) and leaves a visible bounce.
  const runSettleLoop = useCallback(() => {
    if (settleRafRef.current) cancelAnimationFrame(settleRafRef.current)
    const tick = () => {
      if (performance.now() >= streamEndSettleUntilRef.current || !reflowAnchorRef.current) {
        settleRafRef.current = 0
        return
      }
      restoreReflowAnchor()
      settleRafRef.current = requestAnimationFrame(tick)
    }
    settleRafRef.current = requestAnimationFrame(tick)
  }, [restoreReflowAnchor])

  useEffect(() => () => {
    if (settleRafRef.current) cancelAnimationFrame(settleRafRef.current)
  }, [])

  // While the user is typing inside the list (message edit textarea, an
  // extension-mounted input), every auto-pin fights the browser's native
  // caret-reveal scrolling — on iOS Safari the two attractors oscillate the
  // viewport on every keystroke. Suspend auto-pinning until focus leaves.
  const hasInListEditableFocus = useCallback(() => {
    const el = scrollRef.current
    const active = document.activeElement
    if (!el || !active || !el.contains(active)) return false
    return (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    )
  }, [])

  const pinToBottomIfNeeded = useCallback((el: HTMLElement) => {
    if (hasInListEditableFocus()) return
    const target = el.scrollHeight - el.clientHeight
    if (Math.abs(el.scrollTop - target) <= 1) return
    el.scrollTop = target
    markProgrammaticScroll(el)
  }, [hasInListEditableFocus, markProgrammaticScroll])

  if (isStreamingRef.current && !isStreaming) {
    const el = scrollRef.current
    const distFromBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0
    if (el && distFromBottom > SCROLLED_UP_EPSILON) {
      streamEndSettleUntilRef.current = performance.now() + STREAM_END_SETTLE_MS
      captureReflowAnchor()
      runSettleLoop()
    } else {
      streamEndSettleUntilRef.current = 0
    }
  }
  isStreamingRef.current = isStreaming

  const scrollToHistoryBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el || virtualListItems.length === 0) return

    isPinnedRef.current = true
    // Smooth scrollToIndex emits a stream of events with no single target
    // position — consume the first one unconditionally (null target).
    isProgrammaticScrollRef.current = true
    programmaticScrollTargetRef.current = null
    setPrependVisualOffset(0)
    rowVirtualizer.scrollToIndex(virtualListItems.length - 1, { align: 'end', behavior })

    requestAnimationFrame(() => {
      const latest = scrollRef.current
      if (!latest) return
      latest.scrollTop = latest.scrollHeight - latest.clientHeight
      markProgrammaticScroll(latest)
      lastScrollTopRef.current = latest.scrollTop
    })
  }, [markProgrammaticScroll, rowVirtualizer, setPrependVisualOffset, virtualListItems.length])

  // The route changes before the async tail request resolves, so the chatId
  // effect below can fire against the previous/empty list. Pin again once the
  // first loaded rows for this chat are actually present.
  useLayoutEffect(() => {
    if (!hasRows || initialBottomPinnedChatRef.current === chatId) return

    const el = scrollRef.current
    if (!el || virtualListItems.length === 0) return

    initialBottomPinnedChatRef.current = chatId
    isPinnedRef.current = true
    setPrependVisualOffset(0)
    rowVirtualizer.scrollToIndex(virtualListItems.length - 1, { align: 'end', behavior: 'auto' })

    let raf = 0
    const timers: number[] = []
    const pin = () => {
      if (initialBottomPinnedChatRef.current !== chatId) return
      const latest = scrollRef.current
      if (!latest) return
      pinToBottomIfNeeded(latest)
      lastScrollTopRef.current = latest.scrollTop
      lastScrollHeightRef.current = latest.scrollHeight
    }

    raf = requestAnimationFrame(() => {
      raf = 0
      pin()
    })

    for (const delay of [80, 180, 420]) {
      timers.push(window.setTimeout(pin, delay))
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [chatId, hasRows, pinToBottomIfNeeded, rowVirtualizer, setPrependVisualOffset, virtualListItems.length])

  const BOTTOM_REPIN_EPSILON = 6

  const recoverTailVoid = useCallback(() => {
    if (!isPinnedRef.current) return false
    if (hasInListEditableFocus()) return false

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
    el.scrollTop = nextScrollTop
    markProgrammaticScroll(el)
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    isPinnedRef.current = true
    return true
  }, [hasInListEditableFocus, markProgrammaticScroll, rowVirtualizer, virtualListItems.length])

  const updatePinState = (scrollTop: number, scrollHeight: number, clientHeight: number) => {
    const distance = scrollHeight - scrollTop - clientHeight
    isPinnedRef.current = distance <= BOTTOM_REPIN_EPSILON
  }

  // User scroll intent owns pinning: any upward scroll disables auto-follow,
  // and we only re-arm once the user actually returns to the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    lastScrollAtRef.current = performance.now()

    if (recoverTailVoid()) return

    const deltaTop = el.scrollTop - lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop

    if (isProgrammaticScrollRef.current) {
      const target = programmaticScrollTargetRef.current
      isProgrammaticScrollRef.current = false
      programmaticScrollTargetRef.current = null
      // Only swallow the event when the position matches the programmatic
      // write. A mismatch means a native scroll (user touch, Safari caret
      // reveal) arrived first — fall through so it can unpin normally.
      if (target == null || Math.abs(el.scrollTop - target) <= 2) return
    }

    if (streamEndSettleUntilRef.current !== 0) {
      streamEndSettleUntilRef.current = 0
      reflowAnchorRef.current = null
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
    touchActiveRef.current = true
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

  // Flush the prepend visual offset once scroll events go quiet instead of on
  // a fixed timer — an iOS fling keeps emitting scroll events for 1-2s after
  // touchend, and a scrollTop write during that window halts the momentum.
  const scheduleMomentumFlush = useCallback(() => {
    if (touchMomentumTimerRef.current != null) {
      window.clearTimeout(touchMomentumTimerRef.current)
    }
    momentumFlushDeadlineRef.current = performance.now() + MOBILE_MOMENTUM_FLUSH_CAP_MS
    const tick = () => {
      touchMomentumTimerRef.current = null
      const quietFor = performance.now() - lastScrollAtRef.current
      if (quietFor >= MOBILE_MOMENTUM_QUIET_MS || performance.now() >= momentumFlushDeadlineRef.current) {
        flushPrependVisualOffset()
        return
      }
      touchMomentumTimerRef.current = window.setTimeout(tick, MOBILE_MOMENTUM_QUIET_MS)
    }
    touchMomentumTimerRef.current = window.setTimeout(tick, MOBILE_MOMENTUM_SETTLE_MS)
  }, [flushPrependVisualOffset])

  const releaseTouchMomentumHold = useCallback(() => {
    touchActiveRef.current = false
    scheduleMomentumFlush()
  }, [scheduleMomentumFlush])

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
        if (!isPinnedRef.current && isCoarsePointer) {
          // Never write scrollTop for a prepend on touch devices — the batch
          // resolves mid-fling more often than not and the write kills the
          // momentum. Translate rows instead and rebase once scrolling goes
          // quiet.
          setPrependVisualOffset(prependVisualOffsetRef.current + heightDiff)
          if (!touchActiveRef.current) scheduleMomentumFlush()
        } else {
          el.scrollTop += heightDiff
          markProgrammaticScroll(el)
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
  }, [virtualItems, justPrependedRef, hasMore, isCoarsePointer, loadingOlder, loadMore, markProgrammaticScroll, scheduleMomentumFlush, setPrependVisualOffset, warmMobileRange])

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
        pinToBottomIfNeeded(latest)
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
  }, [isCoarsePointer, pinToBottomIfNeeded, recoverTailVoid, rowVirtualizer])

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
      pinToBottomIfNeeded(latest)
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
  }, [pinToBottomIfNeeded])

  // Scroll to bottom on chat change — always pin when switching chats
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      isPinnedRef.current = true
      setPrependVisualOffset(0)
      el.scrollTop = el.scrollHeight - el.clientHeight
      markProgrammaticScroll(el)
      lastScrollTopRef.current = el.scrollTop
    }
  }, [chatId, markProgrammaticScroll, setPrependVisualOffset])

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
        pinToBottomIfNeeded(latest)
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
  }, [pinToBottomIfNeeded, measureMountedRows, recoverTailVoid])

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
              content = <div className={styles.loadingOlder}>{t('messageList.loadingOlder')}</div>
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
                  <span className={styles.errorLabel}>{t('messageList.generationFailed')}</span> {item.error}
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
              styleMode={styleMode}
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
  styleMode?: 'bounded' | 'extension-relaxed'
  measureElement: (el: Element | null) => void
  children: ReactNode
}

function VirtualRow({ virtualIndex, itemType, messageIndex, messageId, measureKey, start, visualOffset, styleMode, measureElement, children }: VirtualRowProps) {
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

  const relaxed = styleMode === 'extension-relaxed'
  return (
    <div
      ref={elRef}
      data-virtual-index={virtualIndex}
      data-item-type={itemType}
      data-index={virtualIndex}
      data-message-index={messageIndex}
      data-message-id={messageId}
      data-measure-key={measureKey}
      data-style-mode={relaxed ? 'extension-relaxed' : undefined}
      className={styles.virtualRow}
      style={relaxed
        ? { top: `${start - visualOffset}px` }
        : { transform: `translateY(${start - visualOffset}px)` }
      }
    >
      {children}
    </div>
  )
}
