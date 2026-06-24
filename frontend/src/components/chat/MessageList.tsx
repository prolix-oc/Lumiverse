import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, useSyncExternalStore, startTransition, memo, type ReactNode, type TouchEvent, type WheelEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer, defaultRangeExtractor, type Range, type Virtualizer } from '@tanstack/react-virtual'
import { useScrollGate } from '@/hooks/useScrollGate'
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
// TanStack recommends a forgiving end threshold for chat so that minor
// overscroll, mobile momentum settling, and soft-keyboard shrink/growth don't
// immediately unpin the viewport from new output.
const SCROLL_END_THRESHOLD = 80
const INITIAL_SCROLL_TO_END_MAX_MS = 5000
const MIN_MEASURED_ROW_HEIGHT = 32
const MAX_ESTIMATED_ROW_HEIGHT = 900
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
  useScrollGate(scrollRef)
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
  const isPrependingRef = useRef(false)
  const suppressNextPinUpdateRef = useRef(false)
  const rangeWarmTimerRef = useRef<number | null>(null)
  const initialBottomPinnedChatRef = useRef<string | null>(null)
  const initialScrollRafRef = useRef<number | null>(null)
  const initialScrollStartedAtRef = useRef(0)
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
  // Fade the message list in once TanStack has populated virtual rows on
  // chat load. Reset on every chat switch so the next chat can fade in too.
  const hasFadedInRef = useRef(false)
  // Bottom inset that TanStack should treat as part of the virtual content.
  // This replaces CSS padding-bottom so isAtEnd/scrollToEnd/followOnAppend
  // all land at the true bottom of the list.
  const [inputSafeZone, setInputSafeZone] = useState(100)
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

  // Mirror the dynamic input safe-zone into React state so TanStack's
  // paddingEnd/scrollPaddingEnd can treat it as virtual content.
  useEffect(() => {
    const el = scrollRef.current
    const parent = el?.parentElement
    if (!el || !parent) return

    const updateSafeZone = () => {
      const raw = getComputedStyle(parent).getPropertyValue('--lcs-input-safe-zone')
      const parsed = Number.parseInt(raw, 10)
      setInputSafeZone(Number.isFinite(parsed) ? parsed : 100)
    }

    updateSafeZone()

    const mo = new MutationObserver(updateSafeZone)
    mo.observe(parent, { attributes: true, attributeFilter: ['style'] })

    const vv = window.visualViewport
    vv?.addEventListener('resize', updateSafeZone)

    return () => {
      mo.disconnect()
      vv?.removeEventListener('resize', updateSafeZone)
    }
  }, [])

  // Re-arm top-pagination on chat switch.
  useEffect(() => {
    topLoadArmedRef.current = true
    lastScrollTopRef.current = 0
    measuredRowHeightsRef.current = new Map()
    lastMeasuredByMessageIdRef.current = new Map()
    averageMeasuredHeightRef.current = null
    initialBottomPinnedChatRef.current = null
    initialScrollStartedAtRef.current = 0
    if (initialScrollRafRef.current != null) {
      cancelAnimationFrame(initialScrollRafRef.current)
      initialScrollRafRef.current = null
    }
  }, [chatId])

  // Reset the fade-in state synchronously on chat switch so the next chat
  // starts hidden instead of flashing the new content for one frame.
  useLayoutEffect(() => {
    hasFadedInRef.current = false
  }, [chatId])

  // Record a programmatic scrollTop write so handleScroll can identify the
  // matching event. Read back rather than store the requested value — the
  // browser clamps writes past the scroll range, and the clamped position is
  // what the scroll event will report.
  const markProgrammaticScroll = useCallback((el: HTMLElement) => {
    isProgrammaticScrollRef.current = true
    programmaticScrollTargetRef.current = el.scrollTop
  }, [])

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
      if (rangeWarmTimerRef.current != null) {
        window.clearTimeout(rangeWarmTimerRef.current)
      }
      if (initialWarmTimerRef.current != null) {
        window.clearTimeout(initialWarmTimerRef.current)
      }
      if (initialScrollRafRef.current != null) {
        cancelAnimationFrame(initialScrollRafRef.current)
      }
    }
  }, [])

  const recordScrollPosition = useCallback(() => {
    const latest = scrollRef.current
    if (!latest) return
    lastScrollTopRef.current = latest.scrollTop
    lastScrollHeightRef.current = latest.scrollHeight
  }, [])

  const cancelInitialScrollToEnd = useCallback(() => {
    initialBottomPinnedChatRef.current = chatId
    initialScrollStartedAtRef.current = 0
    if (initialScrollRafRef.current != null) {
      cancelAnimationFrame(initialScrollRafRef.current)
      initialScrollRafRef.current = null
    }
  }, [chatId])

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
    const extraBefore = !initialRangeWarm ? 3 : isCoarsePointer ? (isWarm ? 18 : 10) : (isWarm ? 10 : 5)
    const extraAfter = !initialRangeWarm ? 2 : isCoarsePointer ? (isWarm ? 6 : 4) : (isWarm ? 3 : 2)
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

  const scheduleInitialScrollToEnd = useCallback((instance: Virtualizer<HTMLDivElement, Element>) => {
    if (!hasRows || virtualListItems.length === 0 || initialBottomPinnedChatRef.current === chatId) return
    if (!scrollRef.current) return
    if (initialScrollRafRef.current != null) return
    if (initialScrollStartedAtRef.current === 0) {
      initialScrollStartedAtRef.current = performance.now()
    }

    initialScrollRafRef.current = requestAnimationFrame(() => {
      initialScrollRafRef.current = null
      const el = scrollRef.current
      if (!el || initialBottomPinnedChatRef.current === chatId) return

      if (instance.getTotalSize() <= el.clientHeight) {
        recordScrollPosition()
        initialBottomPinnedChatRef.current = chatId
        return
      }

      const hasLastVirtualItem = instance.getVirtualItems().some((item) => item.index === virtualListItems.length - 1)
      if (hasLastVirtualItem && instance.isAtEnd(SCROLL_END_THRESHOLD)) {
        recordScrollPosition()
        initialBottomPinnedChatRef.current = chatId
        return
      }

      isPinnedRef.current = true
      instance.scrollToEnd({ behavior: 'auto' })
      recordScrollPosition()

      if (performance.now() - initialScrollStartedAtRef.current <= INITIAL_SCROLL_TO_END_MAX_MS) {
        scheduleInitialScrollToEnd(instance)
      }
    })
  }, [chatId, hasRows, recordScrollPosition, virtualListItems.length])

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
    overscan: initialRangeWarm ? (isCoarsePointer ? 8 : 5) : 2,
    getItemKey,
    rangeExtractor,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: SCROLL_END_THRESHOLD,
    paddingEnd: inputSafeZone,
    scrollPaddingEnd: inputSafeZone,
    directDomUpdates: true,
    onChange: (instance, sync) => {
      if (!sync) scheduleInitialScrollToEnd(instance)
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

  const virtualItems = rowVirtualizer.getVirtualItems()

  // Trigger the chat-load fade-in as soon as the virtualizer has real rows.
  // We dispatch an event so the parent ChatView can perform a container-wide
  // enter animation including the input area and toolbars.
  const hasPopulated = virtualItems.some((item) => virtualListItems[item.index]?.type === 'message')
  useEffect(() => {
    if (!hasFadedInRef.current && hasPopulated) {
      hasFadedInRef.current = true
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('lumiverse:chat-items-populated'))
        })
      })
    }
  }, [hasPopulated, virtualItems])

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
    if (rowVirtualizer.getTotalSize() <= el.clientHeight) return
    if (rowVirtualizer.isAtEnd(SCROLL_END_THRESHOLD)) return
    isProgrammaticScrollRef.current = true
    programmaticScrollTargetRef.current = null
    rowVirtualizer.scrollToEnd({ behavior: 'auto' })
    requestAnimationFrame(() => {
      const latest = scrollRef.current
      if (!latest) return
      lastScrollTopRef.current = latest.scrollTop
      lastScrollHeightRef.current = latest.scrollHeight
    })
  }, [hasInListEditableFocus, rowVirtualizer])

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
    if (rowVirtualizer.getTotalSize() <= el.clientHeight) return

    isPinnedRef.current = true
    // Smooth scroll emits a stream of events with no single target
    // position — consume the first one unconditionally (null target).
    isProgrammaticScrollRef.current = true
    programmaticScrollTargetRef.current = null
    rowVirtualizer.scrollToEnd({ behavior })
  }, [rowVirtualizer, virtualListItems.length])

  // The route changes before the async tail request resolves, so wait until
  // this chat's first loaded rows are present before asking TanStack to land at
  // the end. End anchoring handles later dynamic growth from there.
  useLayoutEffect(() => {
    if (!hasRows || initialBottomPinnedChatRef.current === chatId) return

    const el = scrollRef.current
    if (!el || virtualListItems.length === 0) return

    scheduleInitialScrollToEnd(rowVirtualizer)
  }, [chatId, hasRows, rowVirtualizer, scheduleInitialScrollToEnd, virtualListItems.length])

  const BOTTOM_REPIN_EPSILON = SCROLL_END_THRESHOLD

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

    if (deltaTop < 0) {
      cancelInitialScrollToEnd()
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = false
    } else if (!suppressNextPinUpdateRef.current) {
      updatePinState(el.scrollTop, el.scrollHeight, el.clientHeight)
    } else {
      suppressNextPinUpdateRef.current = false
    }

    const topLoadThreshold = getTopLoadThreshold(el.clientHeight, isCoarsePointer)
    const effectiveScrollTop = el.scrollTop

    if (effectiveScrollTop > topLoadThreshold) {
      topLoadArmedRef.current = true
    }

    if (effectiveScrollTop <= topLoadThreshold && topLoadArmedRef.current && hasMore && !loadingOlder) {
      topLoadArmedRef.current = false
      loadMore()
    }
  }, [cancelInitialScrollToEnd, hasMore, isCoarsePointer, loadingOlder, loadMore, recoverTailVoid])

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -30) {
      cancelInitialScrollToEnd()
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = true
    }
  }, [cancelInitialScrollToEnd])

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchYRef.current = event.touches[0]?.clientY ?? null
  }, [])

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const previousY = touchYRef.current
    const nextY = event.touches[0]?.clientY ?? null
    if (previousY != null && nextY != null && nextY > previousY + 10) {
      cancelInitialScrollToEnd()
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = true
    }
    touchYRef.current = nextY
  }, [cancelInitialScrollToEnd])

  const handleTouchEnd = useCallback(() => {
    touchYRef.current = null
  }, [])

  // TanStack's end anchoring owns prepend stability. This effect now only
  // consumes the pagination flag, warms the mounted range, and keeps loader
  // state/bookkeeping in sync.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (justPrependedRef.current) {
      isPrependingRef.current = true
      justPrependedRef.current = false
      warmMobileRange(900)
      isPrependingRef.current = false
    }

    lastScrollHeightRef.current = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop

    const topLoadThreshold = getTopLoadThreshold(el.clientHeight, isCoarsePointer)
    const effectiveScrollTop = el.scrollTop

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
  }, [virtualItems, justPrependedRef, hasMore, isCoarsePointer, loadingOlder, loadMore, warmMobileRange])

  // Fallback re-pin during iOS keyboard animation. The safe-zone inset is
  // now passed to TanStack as paddingEnd, so normal safe-zone growth keeps
  // an end-pinned viewport pinned automatically. visualViewport resize/scroll
  // events during the keyboard animation (~250-350ms) can still land
  // mid-transition, so we nudge the viewport back to the bottom a few times
  // once the keyboard and safe-zone have settled. Skipped while streaming —
  // the unified scroll guard already handles content growth.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

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

    const repinIfAnchored = () => {
      if (isStreamingRef.current) return
      if (!isPinnedRef.current) return
      requestAnimationFrame(pinToBottom)
      clearSettleTimers()
      settleTimers.push(window.setTimeout(pinToBottom, 180))
      settleTimers.push(window.setTimeout(pinToBottom, 420))
    }

    const vv = window.visualViewport
    vv?.addEventListener('resize', repinIfAnchored)
    vv?.addEventListener('scroll', repinIfAnchored)

    return () => {
      vv?.removeEventListener('resize', repinIfAnchored)
      vv?.removeEventListener('scroll', repinIfAnchored)
      clearSettleTimers()
    }
  }, [pinToBottomIfNeeded])

  useEffect(() => {
    const handleScrollToBottom = () => scrollToHistoryBottom('smooth')
    window.addEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
    return () => window.removeEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
  }, [scrollToHistoryBottom])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const LAYOUT_MEASURE_DEBOUNCE_MS = 80
    let layoutTimer = 0
    let settleTimer = 0
    let pendingRow: HTMLElement | null = null

    const handleMessageContentLayout = (event: Event) => {
      const target = event.target
      pendingRow = target instanceof Element
        ? target.closest<HTMLElement>('[data-virtual-index]')
        : null

      // Debounce the burst of layout events fired during streaming/content
      // changes so we don't re-measure the same row multiple times per frame.
      if (layoutTimer) window.clearTimeout(layoutTimer)
      layoutTimer = window.setTimeout(() => {
        layoutTimer = 0
        const row = pendingRow
        pendingRow = null
        if (row && el.contains(row)) {
          rowVirtualizer.measureElement(row)
        } else {
          measureMountedRows()
        }

        // followOnAppend keeps a pinned viewport at the bottom when the last
        // row grows, so we don't need to manually scroll here. recoverTailVoid
        // is kept as a safety net for the rare case where measurements drift.
        if (recoverTailVoid()) return
        if (settleTimer) window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => {
          settleTimer = 0
          recoverTailVoid()
        }, LAYOUT_MEASURE_DEBOUNCE_MS)
      }, LAYOUT_MEASURE_DEBOUNCE_MS)
    }

    el.addEventListener(MESSAGE_CONTENT_LAYOUT_EVENT, handleMessageContentLayout)
    return () => {
      el.removeEventListener(MESSAGE_CONTENT_LAYOUT_EVENT, handleMessageContentLayout)
      if (layoutTimer) window.clearTimeout(layoutTimer)
      if (settleTimer) window.clearTimeout(settleTimer)
    }
  }, [measureMountedRows, recoverTailVoid, rowVirtualizer])

  return (
    <div
      data-component="MessageList"
      className={styles.list}
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      data-chat-scroll="true"
      data-group-chat={isGroupChat || undefined}
    >
      {isGroupChat && <GroupChatMemberBar chatId={chatId} />}
      <div
        ref={rowVirtualizer.containerRef}
        className={styles.virtualSpace}
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
  styleMode?: 'bounded' | 'extension-relaxed'
  measureElement: (el: Element | null) => void
  children: ReactNode
}

const VirtualRow = memo(function VirtualRow({ virtualIndex, itemType, messageIndex, messageId, measureKey, styleMode, measureElement, children }: VirtualRowProps) {
  const elRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return

    let pendingRaf = 0
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

    // Initial measure during commit, before paint.
    // Rely on TanStack's ResizeObserver (via measureElement) and the
    // MESSAGE_CONTENT_LAYOUT_EVENT dispatched by MessageContent for ongoing
    // size changes. The MutationObserver that was here fired on every token
    // during streaming and caused a measurement storm.
    measure()

    el.addEventListener('load', scheduleMeasure, true)
    el.addEventListener('error', scheduleMeasure, true)

    return () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
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
    >
      {children}
    </div>
  )
})
