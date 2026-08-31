import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { ChevronRight, ChevronUp, ChevronDown, Copy, Check, Code, Search, X } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { selectAgentRunForTarget } from '@/store/slices/agent-runs'
import { generateApi, type DryRunMessage } from '@/api/generate'
import { agentRunsApi } from '@/api/agent-runs'
import type { BreakdownCacheEntry } from '@/types/store'
import { findExpandedTextMatches } from '@/lib/expandedTextSearch'
import {
  GROUP_COLORS,
  groupBreakdownEntries,
  getBlockDisplayColor,
  inspectionAttemptTargetMessageId,
  inspectionDetailToBreakdown,
  workInspectionCheckpointLabel,
  type BreakdownEntry,
  type BreakdownGroup,
} from '@/lib/prompt-breakdown'
import { translateBreakdownGroupLabel } from '@/lib/i18n/breakdownGroupLabel'
import { formatPromptItemizerOutcomeReason } from '@/lib/i18n/promptItemizerOutcome'
import { getAnthropicBreakdownCacheHints, getAnthropicCacheUsageSummary } from '@/lib/anthropic-breakdown-cache'
import { getNanoGptCacheUsageSummary } from '@/lib/nanogpt-breakdown-cache'
import { getOpenAiCompatibleCacheUsageSummary } from '@/lib/openai-compatible-breakdown-cache'
import { copyTextToClipboard } from '@/lib/clipboard'
import { dryRunToRawPromptInput, formatRawPrompt, type RawPromptInput, type RawPromptView } from '@/lib/formatRawPrompt'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import styles from './PromptItemizerModal.module.css'
import clsx from 'clsx'

function getEntryKey(groupLabel: string, index: number): string {
  return `${groupLabel}:${index}`
}

const ROLE_CLASS: Record<string, string> = {
  system: styles.roleSystem,
  user: styles.roleUser,
  assistant: styles.roleAssistant,
}

const INSPECTION_PAGE_SIZE = 12

function summarizeMessage(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return i18n.t('shared.emptyMessage', { ns: 'modals' })
  return normalized
}

function countLines(content: string): number {
  if (!content) return 0
  return content.split(/\r\n|\r|\n/).length
}


export default function PromptItemizerModal() {
  const { t } = useTranslation('modals', { keyPrefix: 'promptItemizer' })
  const { t: ts } = useTranslation('modals', { keyPrefix: 'shared' })
  const { t: tChat } = useTranslation('chat')

  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const breakdownCache = useStore((s) => s.breakdownCache)
  const cacheBreakdown = useStore((s) => s.cacheBreakdown)
  const activeChatId = useStore((s) => s.activeChatId)
  const messages = useStore((s) => s.messages)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)

  const messageId = typeof modalProps?.messageId === 'string' && modalProps.messageId
    ? modalProps.messageId
    : undefined
  const modalChatId = typeof modalProps?.chatId === 'string' && modalProps.chatId
    ? modalProps.chatId
    : undefined
  const modalAttemptId = typeof modalProps?.inspectionAttemptId === 'string' && modalProps.inspectionAttemptId
    ? modalProps.inspectionAttemptId
    : undefined
  const chatId = useMemo(() => {
    if (modalChatId) return modalChatId
    if (!messageId) return activeChatId
    const m = messages.find((x) => x.id === messageId) as { chat_id?: string } | undefined
    return m?.chat_id ?? activeChatId
  }, [modalChatId, messageId, messages, activeChatId])
  const sourceMessage = useMemo(
    () => messageId ? messages.find((message) => message.id === messageId) ?? null : null,
    [messageId, messages],
  )
  const sourceAgentRun = useStore((state) => (
    chatId && messageId && typeof sourceMessage?.swipe_id === 'number'
      ? selectAgentRunForTarget(state, chatId, messageId, sourceMessage.swipe_id)
      : undefined
  ))
  const inspectionAttemptId = modalAttemptId ?? sourceAgentRun?.inspectionAttemptId
  const rawTargetCharacterId = useMemo(() => {
    if (typeof sourceMessage?.extra?.character_id === 'string') {
      return sourceMessage.extra.character_id
    }
    return activeGroupCharacterId ?? activeCharacterId ?? null
  }, [sourceMessage, activeGroupCharacterId, activeCharacterId])

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<BreakdownCacheEntry | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(['lumiverse', 'chatHistory', 'longTermMemory', 'nativeDatabank']),
  )
  const [visiblePromptEntryCount, setVisiblePromptEntryCount] = useState(INSPECTION_PAGE_SIZE)
  const [visibleLoomEntryCount, setVisibleLoomEntryCount] = useState(INSPECTION_PAGE_SIZE)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null)
  const [rawView, setRawView] = useState<'off' | RawPromptView>('off')
  const [copied, setCopied] = useState(false)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [rawInput, setRawInput] = useState<RawPromptInput | null>(null)
  useEffect(() => {
    setRawInput(null)
    setRawError(null)
    setLoadError(null)
    setRawView('off')
    setVisiblePromptEntryCount(INSPECTION_PAGE_SIZE)
    setVisibleLoomEntryCount(INSPECTION_PAGE_SIZE)
  }, [messageId, inspectionAttemptId])
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [matchNavTick, setMatchNavTick] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (messageId) {
      const cached = breakdownCache[messageId]
      if (cached) {
        setLoadError(null)
        setLoading(false)
        setData(cached)
        return
      }

      setLoading(true)
      setLoadError(null)
      generateApi.getBreakdown(messageId)
        .then((res) => {
          setLoadError(null)
          const entry: BreakdownCacheEntry = {
            entries: res.entries,
            messages: res.messages,
            totalTokens: res.totalTokens,
            chatHistoryTokens: res.chatHistoryTokens,
            maxContext: res.maxContext,
            model: res.model,
            provider: res.provider,
            parameters: res.parameters,
            usage: res.usage,
            presetName: res.presetName,
            tokenizer_name: res.tokenizer_name,
            assemblySurface: res.assemblySurface,
            loomPromptInspection: res.loomPromptInspection,
          }
          cacheBreakdown(messageId, entry)
          setData(entry)
        })
        .catch(() => {
          if (!inspectionAttemptId) {
            setData(null)
            setLoadError(t('ar007.loadError'))
            return
          }
          return agentRunsApi.inspection(inspectionAttemptId, chatId ?? undefined)
            .then((detail) => {
              const entry = inspectionDetailToBreakdown(detail)
              const attemptMessageId = inspectionAttemptTargetMessageId(detail)
              if (messageId && attemptMessageId === messageId) {
                cacheBreakdown(messageId, entry)
              }
              setLoadError(null)
              setData(entry)
            })
            .catch(() => {
              setData(null)
              setLoadError(t('ar007.loadError'))
            })
        })
        .finally(() => setLoading(false))
      return
    }

    if (!inspectionAttemptId) return

    setLoading(true)
    setLoadError(null)
    agentRunsApi.inspection(inspectionAttemptId, chatId ?? undefined)
      .then((detail) => {
        const entry = inspectionDetailToBreakdown(detail)
        setLoadError(null)
        setData(entry)
      })
      .catch(() => {
        setData(null)
        setLoadError(t('ar007.loadError'))
      })
      .finally(() => setLoading(false))
  }, [messageId, inspectionAttemptId, chatId, breakdownCache, cacheBreakdown, t])

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      next.has(label) ? next.delete(label) : next.add(label)
      return next
    })
  }

  const ensureRawInput = useCallback(async (): Promise<RawPromptInput | null> => {
    if (rawInput) return rawInput
    if (data?.messages) {
      const generationType = typeof sourceMessage?.extra?.generation_type === 'string'
        ? sourceMessage.extra.generation_type
        : data.assemblySurface === 'WORK'
          ? 'stored_work_target'
          : 'normal'
      const stored: RawPromptInput = {
        messages: data.messages,
        parameters: data.parameters,
        model: data.model,
        provider: data.provider,
        assemblySurface: data.assemblySurface,
        source: 'stored_breakdown',
        target: {
          generationType,
          messageId: messageId ?? null,
          swipeId: sourceMessage?.swipe_id ?? null,
        },
        loomPromptInspection: data.loomPromptInspection,
      }
      setRawInput(stored)
      return stored
    }
    if (!chatId || !messageId) {
      setRawError(t('missingChat'))
      return null
    }
    setRawLoading(true)
    setRawError(null)
    try {
      const presetId = getActivePresetForGeneration() || undefined
      const response = await generateApi.dryRun({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        exclude_message_id: messageId,
        target_character_id: rawTargetCharacterId || undefined,
      })
      const fallback = {
        ...dryRunToRawPromptInput(response),
        target: {
          generationType: 'normal',
          messageId,
          swipeId: sourceMessage?.swipe_id ?? null,
        },
      } satisfies RawPromptInput
      setRawInput(fallback)
      return fallback
    } catch (err: unknown) {
      setRawError(err instanceof Error && err.message ? err.message : t('rawFailed'))
      return null
    } finally {
      setRawLoading(false)
    }
  }, [rawInput, chatId, messageId, data, sourceMessage, activeProfileId, activePersonaId, activeCharacterId, getActivePresetForGeneration, rawTargetCharacterId, t])

  const handleToggleRaw = useCallback(async () => {
    if (rawView !== 'off') {
      setRawView((v) => (v === 'text' ? 'json' : 'off'))
      return
    }
    const input = await ensureRawInput()
    if (input) setRawView('text')
  }, [rawView, ensureRawInput])

  const handleCopy = useCallback(async () => {
    const input = await ensureRawInput()
    if (!input) return
    const view: RawPromptView = rawView === 'json' ? 'json' : 'text'
    const text = formatRawPrompt(input, view)
    copyTextToClipboard(text).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [ensureRawInput, rawView])

  const rawText = useMemo(() => {
    if (rawView === 'off' || !rawInput) return ''
    return formatRawPrompt(rawInput, rawView)
  }, [rawView, rawInput])

  const rawButtonLabel = rawView === 'off' ? ts('raw') : rawView === 'text' ? ts('json') : ts('visual')

  useEffect(() => {
    setMatchIndex(0)
  }, [rawView])

  const groups = useMemo(() => {
    if (!data) return []
    const ordinaryEntries: BreakdownEntry[] = []
    const databankEntries: BreakdownEntry[] = []
    for (const entry of data.entries) {
      if (entry.type === 'databank' || entry.type === 'databank_mention') {
        databankEntries.push(entry)
      } else {
        ordinaryEntries.push(entry)
      }
    }
    const grouped = groupBreakdownEntries(ordinaryEntries)
    if (databankEntries.length === 0) return grouped

    const databankGroup: BreakdownGroup = {
      id: 'nativeDatabank',
      label: 'Databank',
      color: GROUP_COLORS.worldInfo,
      tokens: databankEntries.reduce((total, entry) => total + entry.tokens, 0),
      entries: databankEntries,
    }
    const worldInfoIndex = grouped.findIndex((group) => group.id === 'worldInfo')
    const firstTrailingIndex = grouped.findIndex((group) => (
      group.id === 'sidecar' || group.id === 'extensions' || group.id === 'system'
    ))
    const insertionIndex = worldInfoIndex >= 0
      ? worldInfoIndex + 1
      : firstTrailingIndex >= 0
        ? firstTrailingIndex
        : grouped.length
    return [
      ...grouped.slice(0, insertionIndex),
      databankGroup,
      ...grouped.slice(insertionIndex),
    ]
  }, [data])
  const loomInspection = data?.loomPromptInspection
  const responseOmission = loomInspection?.responseOmission
  const assemblySurface = sourceAgentRun || data?.assemblySurface === 'WORK' || loomInspection?.surface === 'WORK'
    ? 'WORK'
    : 'RESPONSE'
  const groupLabel = useCallback((id: string, fallback: string) => {
    if (id === 'nativeDatabank') return fallback
    return translateBreakdownGroupLabel(id, t)
  }, [t])
  const roleByBlockId = useMemo(() => {
    const roles = new Map<string, string>()
    for (const entry of data?.entries ?? []) {
      if (entry.blockId && entry.role && !roles.has(entry.blockId)) roles.set(entry.blockId, entry.role)
    }
    return roles
  }, [data])
  const visiblePromptEntries = data?.entries.slice(0, visiblePromptEntryCount) ?? []
  const visibleLoomItems = loomInspection?.items.slice(0, visibleLoomEntryCount) ?? []
  const visibleEffectiveEntryIds = loomInspection?.effectiveEntryIds.slice(0, visibleLoomEntryCount) ?? []
  const visibleResponseSources = responseOmission?.source.slice(0, visibleLoomEntryCount) ?? []
  const visibleOmittedEntryIds = responseOmission?.omittedEntryIds.slice(0, visibleLoomEntryCount) ?? []
  const visibleOmittedPhases = responseOmission?.omittedPhaseInstructions.slice(0, visibleLoomEntryCount) ?? []
  const retainedLoomEvidenceCount = Math.max(
    loomInspection?.items.length ?? 0,
    loomInspection?.effectiveEntryIds.length ?? 0,
    responseOmission?.source.length ?? 0,
    responseOmission?.omittedEntryIds.length ?? 0,
    responseOmission?.omittedPhaseInstructions.length ?? 0,
  )
  const sidecarGroup = groups.find((g) => g.id === 'sidecar')
  const chatHistoryGroup = data?.chatHistoryTokens != null && data.chatHistoryTokens > 0
    ? {
        id: 'chatHistory',
        label: 'Chat History',
        color: GROUP_COLORS.chatHistory,
        tokens: data.chatHistoryTokens,
        entries: [],
      }
    : null
  const mainGroups = groups.filter((g) => g.id !== 'sidecar')
  const summaryGroups = chatHistoryGroup ? [chatHistoryGroup, ...mainGroups] : mainGroups
  const flatEntries = useMemo(
    () => groups.flatMap((group) => group.entries.map((entry, index) => ({
      key: getEntryKey(group.id, index),
      groupId: group.id,
      groupLabel: groupLabel(group.id, group.label),
      entry,
    }))),
    [groups, groupLabel],
  )

  useEffect(() => {
    if (flatEntries.length === 0) {
      setSelectedEntryKey(null)
      return
    }

    setSelectedEntryKey((prev) => {
      if (prev && flatEntries.some((item) => item.key === prev)) return prev
      return (flatEntries.find((item) => item.entry.content) ?? flatEntries[0]).key
    })
  }, [flatEntries])

  const selectedEntry = flatEntries.find((item) => item.key === selectedEntryKey) ?? null

  // ---- Find in prompt ----
  // Name and content are matched separately so content offsets line up with
  // the inspector highlight; chat-history entries fall back to their
  // reassembled messages when the snapshot carries no inline content.
  // Name-only matches navigate to the entry but highlight nothing (start<0).
  const entryContentSearchText = useCallback((entry: typeof flatEntries[number]['entry']): string => {
    if (
      entry.type === 'chat_history' &&
      entry.content == null &&
      data?.messages &&
      entry.firstMessageIndex != null &&
      entry.messageCount != null && entry.messageCount > 0
    ) {
      return data.messages
        .slice(entry.firstMessageIndex, entry.firstMessageIndex + entry.messageCount)
        .map((message) => message.content)
        .join('\n')
    }
    return entry.content ?? ''
  }, [data?.messages])

  type FindMatch =
    | { kind: 'breakdown'; entryKey: string; groupId: string; start: number; end: number }
    | { kind: 'raw'; start: number; end: number }

  const breakdownFindMatches = useMemo<FindMatch[]>(() => {
    if (assemblySurface === 'WORK') return []
    const query = findQuery.trim()
    if (!query) return []
    const matches: FindMatch[] = []
    for (const item of flatEntries) {
      for (const _nameMatch of findExpandedTextMatches(item.entry.name, query)) {
        matches.push({
          kind: 'breakdown',
          entryKey: item.key,
          groupId: item.groupId,
          start: -1,
          end: -1,
        })
      }
      for (const range of findExpandedTextMatches(entryContentSearchText(item.entry), query)) {
        matches.push({
          kind: 'breakdown',
          entryKey: item.key,
          groupId: item.groupId,
          start: range.start,
          end: range.end,
        })
      }
    }
    return matches
  }, [assemblySurface, findQuery, flatEntries, entryContentSearchText])

  const rawFindMatches = useMemo<FindMatch[]>(() => {
    const query = findQuery.trim()
    if (assemblySurface === 'WORK' || !query || rawView === 'off' || !rawText) return []
    return findExpandedTextMatches(rawText, query).map((range) => ({
      kind: 'raw' as const,
      start: range.start,
      end: range.end,
    }))
  }, [assemblySurface, findQuery, rawText, rawView])

  const findMatches = rawView === 'off' ? breakdownFindMatches : rawFindMatches
  const currentMatchIndex = findMatches.length === 0
    ? 0
    : Math.min(matchIndex, findMatches.length - 1)
  const currentMatch = findMatches[currentMatchIndex] ?? null

  const goToMatch = useCallback((nextIndex: number) => {
    if (findMatches.length === 0) return
    const wrapped = ((nextIndex % findMatches.length) + findMatches.length) % findMatches.length
    setMatchIndex(wrapped)
    const match = findMatches[wrapped]
    if (match.kind === 'breakdown') {
      setSelectedEntryKey(match.entryKey)
      setOpenGroups((prev) => new Set(prev).add(match.groupId))
    }
    setMatchNavTick((tick) => tick + 1)
  }, [findMatches])

  // Ctrl/Cmd+F opens find, mirroring the expanded editor.
  useEffect(() => {
    if (assemblySurface === 'WORK') return
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        setFindOpen(true)
        requestAnimationFrame(() => findInputRef.current?.focus())
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [assemblySurface])

  // Scroll only on explicit find navigation. Scope the lookup to this modal
  // and move its own scroll container directly; document-level scrollIntoView
  // is unreliable inside the nested modal/raw-view layout.
  useEffect(() => {
    if (!findOpen || !findQuery.trim() || !currentMatch) return
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current
      const mark = body?.querySelector<HTMLElement>('[data-find-current="true"]')
      if (!body || !mark) return
      const bodyRect = body.getBoundingClientRect()
      const markRect = mark.getBoundingClientRect()
      const top = body.scrollTop
        + (markRect.top - bodyRect.top)
        - ((body.clientHeight - markRect.height) / 2)
      body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [matchNavTick, findOpen, findQuery, currentMatch])

  const highlightFindMatches = (text: string): ReactNode => {
    const query = findQuery.trim()
    if (!query) return text
    const ranges = findExpandedTextMatches(text, query)
    if (ranges.length === 0) return text
    const nodes: ReactNode[] = []
    let cursor = 0
    ranges.forEach((range, index) => {
      if (range.start > cursor) nodes.push(text.slice(cursor, range.start))
      const isCurrent = currentMatch?.kind === 'breakdown'
        && selectedEntryKey === currentMatch.entryKey
        && currentMatch.start === range.start
        && currentMatch.end === range.end
      nodes.push(
        <mark
          key={index}
          className={isCurrent ? styles.findMarkCurrent : styles.findMark}
          data-find-current={isCurrent ? 'true' : undefined}
        >
          {text.slice(range.start, range.end)}
        </mark>,
      )
      cursor = range.end
    })
    if (cursor < text.length) nodes.push(text.slice(cursor))
    return nodes
  }

  const highlightRawFindMatches = (text: string): ReactNode => {
    const query = findQuery.trim()
    if (!query) return text
    const ranges = findExpandedTextMatches(text, query)
    if (ranges.length === 0) return text

    const nodes: ReactNode[] = []
    let cursor = 0
    ranges.forEach((range, index) => {
      if (range.start > cursor) nodes.push(text.slice(cursor, range.start))
      const isCurrent = currentMatch?.kind === 'raw'
        && currentMatch.start === range.start
        && currentMatch.end === range.end
      nodes.push(
        <mark
          key={index}
          className={isCurrent ? styles.findMarkCurrent : styles.findMark}
          data-find-current={isCurrent ? 'true' : undefined}
        >
          {text.slice(range.start, range.end)}
        </mark>,
      )
      cursor = range.end
    })
    if (cursor < text.length) nodes.push(text.slice(cursor))
    return nodes
  }

  const cacheHints = useMemo(
    () => data
      ? getAnthropicBreakdownCacheHints({
          provider: data.provider,
          parameters: data.parameters,
          breakdown: data.entries,
        })
      : [],
    [data],
  )
  const anthropicCacheUsage = useMemo(
    () => data ? getAnthropicCacheUsageSummary(data.provider, data.usage) : null,
    [data],
  )
  const nanoGptCacheUsage = useMemo(
    () => data ? getNanoGptCacheUsageSummary(data.provider, data.usage) : null,
    [data],
  )
  const openAiCompatibleCacheUsage = useMemo(
    () => data ? getOpenAiCompatibleCacheUsageSummary(data.provider, data.usage) : null,
    [data],
  )
  const cacheHintsByKey = useMemo(() => {
    const hintByEntry = new Map<BreakdownEntry, (typeof cacheHints)[number]>()
    data?.entries.forEach((entry, index) => {
      const hint = cacheHints[index]
      if (hint) hintByEntry.set(entry, hint)
    })
    const hintByKey = new Map<string, { kind: 'cached' | 'miss'; label: string }>()
    for (const item of flatEntries) {
      const hint = hintByEntry.get(item.entry)
      if (hint) hintByKey.set(item.key, hint)
    }
    return hintByKey
  }, [data, flatEntries, cacheHints])
  const selectedCacheHint = selectedEntry ? cacheHintsByKey.get(selectedEntry.key) : undefined
  const selectedChatHistoryMessages = useMemo(() => {
    if (!selectedEntry || selectedEntry.entry.type !== 'chat_history') return null

    const firstMessageIndex = selectedEntry.entry.firstMessageIndex
    const messageCount = selectedEntry.entry.messageCount
    if (firstMessageIndex == null || messageCount == null || messageCount <= 0) return null

    const sourceMessages = data?.messages ?? rawInput?.messages
    if (!sourceMessages) return null

    return sourceMessages.slice(firstMessageIndex, firstMessageIndex + messageCount)
  }, [selectedEntry, data?.messages, rawInput?.messages])

  const selectedChatHistoryUsesReassembledMessages = Boolean(
    selectedEntry?.entry.type === 'chat_history' && !data?.messages && selectedChatHistoryMessages,
  )

  useEffect(() => {
    if (
      assemblySurface === 'WORK' ||
      rawView !== 'off' ||
      !selectedEntry ||
      selectedEntry.entry.type !== 'chat_history' ||
      data?.messages ||
      selectedChatHistoryMessages ||
      rawLoading ||
      rawError
    ) {
      return
    }
    void ensureRawInput()
  }, [assemblySurface, data?.messages, ensureRawInput, rawError, rawLoading, rawView, selectedChatHistoryMessages, selectedEntry])

  return (
    <ModalShell
      isOpen={true}
      onClose={closeModal}
      maxWidth="clamp(340px, 94vw, min(900px, var(--lumiverse-content-max-width, 900px)))"
      maxHeight="var(--prompt-itemizer-modal-max-height)"
      zIndex={10001}
      className={styles.modal}
    >
          <div className={styles.header}>
            <h2 className={styles.title}>{t('title')}</h2>
            {data && (
              <>
                <span className={styles.headerBadge}>{data.provider} / {data.model}</span>
                {data.tokenizer_name && (
                  <span className={styles.headerBadge}>{data.tokenizer_name}</span>
                )}
              </>
            )}
            <CloseButton onClick={closeModal} iconSize={15} />
          </div>

          <div ref={bodyRef} className={styles.body}>
            {!loading && !data && loadError && (
              <div className={styles.loadError} role="alert">
                <strong>{t('ar007.unavailableTitle')}</strong>
                <span>{loadError}</span>
              </div>
            )}
            {!loading && !data && !loadError && <div className={styles.empty}>{t('empty')}</div>}
            {!loading && data && assemblySurface !== 'WORK' && findOpen && (
              <div className={styles.findBar}>
                <Search size={12} className={styles.findBarIcon} />
                <input
                  ref={findInputRef}
                  className={styles.findInput}
                  value={findQuery}
                  placeholder={t('findPlaceholder')}
                  onChange={(e) => {
                    setFindQuery(e.target.value)
                    setMatchIndex(0)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      goToMatch(e.shiftKey ? currentMatchIndex - 1 : currentMatchIndex + 1)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setFindOpen(false)
                    }
                  }}
                />
                <span className={styles.findCount}>
                  {findQuery.trim()
                    ? findMatches.length > 0
                      ? `${currentMatchIndex + 1}/${findMatches.length}`
                      : t('noMatches')
                    : ''}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ChevronUp size={12} />}
                  disabled={findMatches.length === 0}
                  onClick={() => goToMatch(currentMatchIndex - 1)}
                  aria-label={t('findPrevious')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ChevronDown size={12} />}
                  disabled={findMatches.length === 0}
                  onClick={() => goToMatch(currentMatchIndex + 1)}
                  aria-label={t('findNext')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={12} />}
                  onClick={() => setFindOpen(false)}
                  aria-label={ts('close')}
                />
              </div>
            )}

            {!loading && data && (rawView === 'off' || assemblySurface === 'WORK') && (
              <>
                <section className={styles.effectivePromptInspection} aria-labelledby="effective-prompt-inspection-title">
                  <header className={styles.effectivePromptHeader}>
                    <div>
                      <p className={styles.effectivePromptEyebrow}>
                        <code>{assemblySurface}</code>
                        <span aria-hidden="true">·</span>
                        <code>{workInspectionCheckpointLabel(assemblySurface, loomInspection?.checkpoint)}</code>
                      </p>
                      <h3 id="effective-prompt-inspection-title">{t('inspectionTitle')}</h3>
                      <p>
                        {t('ar007.sourceSummary', { entries: data.entries.length.toLocaleString(), tokens: data.totalTokens.toLocaleString() })}
                      </p>
                    </div>
                    <span className={styles.readOnlyBadge}>{t('ar007.readOnly')}</span>
                  </header>

                  <div className={styles.effectivePromptBoundary}>
                    <p>
                      <strong>{t('ar007.nativeContextTitle')}</strong> {t('ar007.nativeContext')}
                    </p>
                    {assemblySurface === 'WORK' ? (
                      <p className={styles.privacyBoundary}>
                        <strong>{t('ar007.workBoundaryTitle')}</strong> {t('ar007.workBoundary')}
                      </p>
                    ) : (
                      <p>
                        <strong>{t('ar007.ordinaryResponseTitle')}</strong> {t('ar007.ordinaryResponse')}
                      </p>
                    )}
                  </div>

                  <section className={styles.effectivePromptSection} aria-labelledby="effective-prompt-source-order">
                    <div className={styles.effectivePromptSectionHeader}>
                      <div>
                        <h4 id="effective-prompt-source-order">{t('ar007.orderedSourcesTitle')}</h4>
                        <p>{t('ar007.orderedSourcesSummary')}</p>
                      </div>
                      <span>{visiblePromptEntries.length}/{data.entries.length}</span>
                    </div>
                    {visiblePromptEntries.length > 0 ? (
                      <ol className={styles.effectivePromptOrder}>
                        {visiblePromptEntries.map((entry, index) => {
                          const nativeWorldInfo = entry.type === 'world_info'
                          const nativeDatabank = entry.type === 'databank' || entry.type === 'databank_mention'
                          const nativeSource = nativeWorldInfo || nativeDatabank
                          const sourceLabel = nativeWorldInfo
                            ? t('ar007.nativeWorldInfo')
                            : nativeDatabank
                              ? t('ar007.nativeDatabank')
                              : t('ar007.ordinaryPrompt')
                          return (
                            <li className={styles.effectivePromptItem} key={`${entry.type}:${entry.blockId ?? entry.name}:${index}`}>
                              <header className={styles.promptItemHeader}>
                                <span className={styles.promptOrderBadge}>{index + 1}</span>
                                <div>
                                  <strong>{entry.name}</strong>
                                  <span>{entry.type}</span>
                                </div>
                                <span className={nativeSource ? styles.nativeSourceBadge : styles.promptSourceBadge}>
                                  {sourceLabel}
                                </span>
                              </header>
                              <dl className={styles.promptItemFields}>
                                <div>
                                  <dt>{t('ar007.role')}</dt>
                                  <dd><code>{entry.role ?? t('ar007.notRecorded')}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.tokens')}</dt>
                                  <dd>{entry.tokens.toLocaleString()}</dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.sourceIdentity')}</dt>
                                  <dd><code>{entry.blockId ?? t('ar007.notRecorded')}</code></dd>
                                </div>
                                {nativeSource ? (
                                  <div>
                                    <dt>{t('ar007.contentHash')}</dt>
                                    <dd><code>{t('ar007.ownerInspection')}</code></dd>
                                  </div>
                                ) : null}
                              </dl>
                              {nativeSource ? (
                                <p className={styles.nativeEvidenceGap}>
                                  {t('ar007.nativeEvidenceGap')}
                                </p>
                              ) : null}
                              {entry.content != null && assemblySurface !== 'WORK' ? (
                                <details className={styles.promptContent}>
                                  <summary>{t('ar007.inspectContent')}</summary>
                                  <pre>{entry.content}</pre>
                                </details>
                              ) : entry.content != null ? (
                                <p className={styles.loomPrivacyGap}>{t('ar007.contentHidden')}</p>
                              ) : null}
                            </li>
                          )
                        })}
                      </ol>
                    ) : (
                      <p className={styles.loomEvidenceGap}>{t('ar007.noOrderedSources')}</p>
                    )}
                    {data.entries.length > visiblePromptEntryCount ? (
                      <div className={styles.inspectionReveal}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setVisiblePromptEntryCount((count) => Math.min(count + INSPECTION_PAGE_SIZE, data.entries.length))}
                        >
                          {t('ar007.showNext', { count: Math.min(INSPECTION_PAGE_SIZE, data.entries.length - visiblePromptEntryCount) })}
                        </Button>
                      </div>
                    ) : null}
                  </section>

                  {loomInspection ? (
                    <section className={styles.loomInspection} aria-labelledby="loom-prompt-inspection-title">
                      <header className={styles.loomInspectionHeader}>
                        <div>
                          <p className={styles.loomInspectionEyebrow}>
                            <code>{loomInspection.surface}</code>
                            <span aria-hidden="true">·</span>
                            <code>{loomInspection.checkpoint}</code>
                          </p>
                          <h4 id="loom-prompt-inspection-title">{t('inspectionTitle')}</h4>
                          <p>{t('inspectionSummary', {
                            count: loomInspection.items.length,
                            effectiveCount: loomInspection.effectiveEntryIds.length,
                          })}</p>
                        </div>
                        <details className={styles.loomEffectiveOrder}>
                          <summary>{t('inspectionEffectiveOrder')}</summary>
                          <code>{visibleEffectiveEntryIds.join(' → ') || '—'}</code>
                        </details>
                      </header>
                      <p className={styles.loomRouteNotice}>
                        {t('ar007.fixedRoutes')}
                      </p>
                      <ol className={styles.loomInspectionList}>
                        {visibleLoomItems.map((item, index) => {
                          const outcomeReason = 'reason' in item.outcome ? item.outcome.reason : null
                          const outcomeStatus = t(`ar007.outcomeStatus.${item.outcome.status}`, { defaultValue: item.outcome.status })
                          const outcomeDetail = item.outcome.status === 'included'
                            ? t('ar007.outcomeIncluded', { status: outcomeStatus, index: item.outcome.effectiveIndex + 1 })
                            : item.outcome.status === 'deduplicated'
                              ? t('ar007.outcomeDeduplicated', { status: outcomeStatus, entry: item.outcome.keptEntryId, destination: item.outcome.destination })
                              : formatPromptItemizerOutcomeReason(outcomeStatus, item.outcome.reason, tChat)

                          const repairRequired = outcomeReason === 'stale_source'
                            || outcomeReason === 'invalid_source'
                            || outcomeReason === 'required_source_unavailable'
                            || item.conditionResult === 'invalid'
                          return (
                            <li className={styles.loomInspectionItem} key={`${item.entryId}-${index}`}>
                              <div className={styles.loomInspectionItemHeader}>
                                <span>{t('inspectionItemOrder', { order: index + 1 })}</span>
                                <code>{item.entryId}</code>
                                <span className={styles.loomOutcome} data-outcome={item.outcome.status}>{outcomeDetail}</span>
                              </div>
                              <dl className={styles.loomInspectionFields}>
                                <div>
                                  <dt>{t('ar007.exactBlock')}</dt>
                                  <dd><code>{item.source.blockId}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.presetRevision')}</dt>
                                  <dd><code>{item.source.presetRevision}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.blockRevision')}</dt>
                                  <dd><code>{item.source.blockRevision}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.sourcePromptOrder')}</dt>
                                  <dd><code>{item.source.promptOrder}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.fixedRole')}</dt>
                                  <dd><code>{item.bucket}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('inspectionRoute')}</dt>
                                  <dd><code>{`${item.bucket} → ${item.destination} @ ${item.checkpoint}`}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('inspectionRequired')}</dt>
                                  <dd><code>{String(item.required)}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('inspectionCondition')}</dt>
                                  <dd><code>{item.condition ? JSON.stringify(item.condition) : t('ar007.notApplicable')}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('inspectionConditionResult')}</dt>
                                  <dd><code>{item.conditionResult ?? 'not_applicable'}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.ordinaryPromptSuppressed')}</dt>
                                  <dd><code>{item.ordinaryPromptSuppressed ? t('ar007.booleanTrue') : t('ar007.booleanFalse')}</code></dd>
                                </div>
                                <div>
                                  <dt>{t('ar007.outcomeReasonLabel')}</dt>
                                  <dd><code>{outcomeReason ? tChat(`ownerInspection.values.${outcomeReason}`, { defaultValue: outcomeReason }) : t('ar007.notApplicable')}</code></dd>
                                </div>
                                {item.outcome.status === 'deduplicated' ? (
                                  <>
                                    <div>
                                      <dt>{t('ar007.dedupeRetainedEntry')}</dt>
                                      <dd><code>{item.outcome.keptEntryId}</code></dd>
                                    </div>
                                    <div>
                                      <dt>{t('ar007.dedupeRetainedDestination')}</dt>
                                      <dd><code>{item.outcome.destination}</code></dd>
                                    </div>
                                  </>
                                ) : null}
                              </dl>
                              {repairRequired ? (
                                <p className={styles.loomRepair}>
                                  <strong>{t('ar007.repairRequired')}</strong> {t('ar007.repairDetail')}
                                </p>
                              ) : null}
                              {item.effectiveText === null ? (
                                <p className={styles.loomInspectionEmpty}>{t('inspectionNoEffectiveText')}</p>
                              ) : item.destination === 'render' ? (
                                <details className={styles.loomInspectionContent}>
                                  <summary>{t('inspectionEffectiveText')}</summary>
                                  <pre>{item.effectiveText}</pre>
                                </details>
                              ) : (
                                <p className={styles.loomPrivacyGap}>
                                  {t('ar007.workTextHidden')}
                                </p>
                              )}
                            </li>
                          )
                        })}
                      </ol>
                      {assemblySurface === 'WORK' ? (
                        <p className={styles.loomEvidenceGap}>
                          {t('ar007.structuredCustomPhase')}
                        </p>
                      ) : null}
                    </section>
                  ) : (
                    <p className={styles.loomEvidenceGap}>
                      {t('ar007.noStructuredInspection')}
                    </p>
                  )}

                  {responseOmission ? (
                    <section
                      className={styles.responseOmission}
                      role="note"
                      aria-label={t('responseOmissionTitle')}
                    >
                      <strong>{t('responseOmissionTitle')}</strong>
                      <span className={styles.responseOmissionSummary}>
                        {t('responseOmissionSummary', {
                          entryCount: responseOmission.omittedEntryIds.length,
                          phaseCount: responseOmission.omittedPhaseInstructions.length,
                        })}
                      </span>
                      <p className={styles.responseOmissionExplanation}>
                        {t('ar007.responseOmissionText', { reason: responseOmission.reason })}
                      </p>
                      <details className={styles.responseOmissionDetails}>
                        <summary>{t('responseOmissionDetails')}</summary>
                        <dl>
                          <div>
                            <dt>{t('responseOmissionCheckpoint')}</dt>
                            <dd>{loomInspection?.checkpoint}</dd>
                          </div>
                          <div>
                            <dt>{t('responseOmissionEntries')}</dt>
                            <dd>{visibleOmittedEntryIds.join(', ') || '—'}</dd>
                          </div>
                          <div>
                            <dt>{t('responseOmissionSources')}</dt>
                            <dd>
                              <ul className={styles.loomExactList}>
                                {visibleResponseSources.map((source) => (
                                  <li key={`${source.blockId}-${source.blockRevision}-${source.promptOrder}`}>
                                    <code>{`${source.blockId}@${source.blockRevision} · preset:${source.presetRevision} · order:${source.promptOrder}`}</code>
                                  </li>
                                ))}
                              </ul>
                            </dd>
                          </div>
                          {responseOmission.omittedPhaseInstructions.length > 0 ? (
                            <div>
                              <dt>{t('responseOmissionPhases')}</dt>
                              <dd>
                                <ul className={styles.loomExactList}>
                                  {visibleOmittedPhases.map(({ phaseId, source }) => (
                                    <li key={`${phaseId}-${source.blockId}-${source.blockRevision}-${source.promptOrder}`}>
                                      <code>{`${phaseId}: ${source.blockId}@${source.blockRevision} · preset:${source.presetRevision} · order:${source.promptOrder}`}</code>
                                    </li>
                                  ))}
                                </ul>
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </details>
                    </section>
                  ) : null}

                  {retainedLoomEvidenceCount > visibleLoomEntryCount ? (
                    <div className={styles.inspectionReveal}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setVisibleLoomEntryCount((count) => Math.min(
                          count + INSPECTION_PAGE_SIZE,
                          retainedLoomEvidenceCount,
                        ))}
                      >
                        {t('ar007.showNextLoom', { count: Math.min(INSPECTION_PAGE_SIZE, retainedLoomEvidenceCount - visibleLoomEntryCount) })}
                      </Button>
                    </div>
                  ) : null}
                </section>
                <div className={styles.tokenExplorerHeading}>
                  <h3>{t('ar007.tokenDistribution')}</h3>
                  <p>{t('ar007.tokenDistributionSummary')}</p>
                </div>
                <StackedBar groups={summaryGroups} total={data.totalTokens} groupLabel={groupLabel} />
                {data.chatHistoryTokens != null && data.chatHistoryTokens > 0 && (
                  <div className={styles.cacheSummary}>
                    <span>{t('chatHistoryTokens')}</span>
                    <span className={styles.cacheSummaryMetric}>{ts('tokens', { count: data.chatHistoryTokens })}</span>
                  </div>
                )}
                {anthropicCacheUsage && (
                  <div className={styles.cacheSummary}>
                    <span>{t('anthropicCache')}</span>
                    <span className={styles.cacheSummaryMetric}>{t('cacheRead', { count: anthropicCacheUsage.cacheReadInputTokens.toLocaleString() })}</span>
                    <span className={styles.cacheSummaryMetric}>{t('cacheWrite', { count: anthropicCacheUsage.cacheCreationInputTokens.toLocaleString() })}</span>
                    {anthropicCacheUsage.cacheCreation5mInputTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cache5m', { count: anthropicCacheUsage.cacheCreation5mInputTokens.toLocaleString() })}</span>
                    )}
                    {anthropicCacheUsage.cacheCreation1hInputTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cache1h', { count: anthropicCacheUsage.cacheCreation1hInputTokens.toLocaleString() })}</span>
                    )}
                  </div>
                )}
                {nanoGptCacheUsage && (
                  <div className={styles.cacheSummary}>
                    <span>{t('nanoGptCache')}</span>
                    {nanoGptCacheUsage.cacheReadInputTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cacheRead', { count: nanoGptCacheUsage.cacheReadInputTokens.toLocaleString() })}</span>
                    )}
                    {nanoGptCacheUsage.cacheCreationInputTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cacheWrite', { count: nanoGptCacheUsage.cacheCreationInputTokens.toLocaleString() })}</span>
                    )}
                    {nanoGptCacheUsage.cachedTokensOpenAiStyle > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cacheCached', { count: nanoGptCacheUsage.cachedTokensOpenAiStyle.toLocaleString() })}</span>
                    )}
                  </div>
                )}
                {openAiCompatibleCacheUsage && (
                  <div className={styles.cacheSummary}>
                    <span>{data.provider === 'openrouter' ? t('openRouterCache') : t('openAiCache')}</span>
                    {openAiCompatibleCacheUsage.cacheReadInputTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cacheRead', { count: openAiCompatibleCacheUsage.cacheReadInputTokens.toLocaleString() })}</span>
                    )}
                    {openAiCompatibleCacheUsage.cacheCreationInputTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cacheWrite', { count: openAiCompatibleCacheUsage.cacheCreationInputTokens.toLocaleString() })}</span>
                    )}
                    {openAiCompatibleCacheUsage.cachedTokens > 0 && (
                      <span className={styles.cacheSummaryMetric}>{t('cacheCached', { count: openAiCompatibleCacheUsage.cachedTokens.toLocaleString() })}</span>
                    )}
                  </div>
                )}
                <Legend groups={summaryGroups} groupLabel={groupLabel} />
                {mainGroups.map((group) => (
                  <GroupAccordion
                    key={group.id}
                    group={group}
                    displayLabel={groupLabel(group.id, group.label)}
                    total={data.totalTokens}
                    open={openGroups.has(group.id)}
                    onToggle={() => toggleGroup(group.id)}
                    selectedEntryKey={selectedEntryKey}
                    onSelectEntry={setSelectedEntryKey}
                    cacheHintsByKey={cacheHintsByKey}
                  />
                ))}
                {sidecarGroup && sidecarGroup.tokens > 0 && (
                  <>
                    <div className={styles.sidecarDivider}>
                      <span>{t('sidecarDivider')}</span>
                    </div>
                    <GroupAccordion
                      group={sidecarGroup}
                      displayLabel={groupLabel(sidecarGroup.id, sidecarGroup.label)}
                      total={sidecarGroup.tokens}
                      open={openGroups.has(sidecarGroup.id)}
                      onToggle={() => toggleGroup(sidecarGroup.id)}
                      selectedEntryKey={selectedEntryKey}
                      onSelectEntry={setSelectedEntryKey}
                      cacheHintsByKey={cacheHintsByKey}
                    />
                  </>
                )}
                {selectedEntry && (
                  <div className={styles.entryInspector}>
                    <div className={styles.entryInspectorHeader}>
                      <div className={styles.entryInspectorTitleWrap}>
                        <span className={styles.entryInspectorEyebrow}>{selectedEntry.groupLabel}</span>
                        <div className={styles.entryInspectorTitleRow}>
                          <span className={styles.entryInspectorTitle}>{selectedEntry.entry.name}</span>
                          <span className={styles.headerBadge}>{ts('tokens', { count: selectedEntry.entry.tokens })}</span>
                          <span className={styles.headerBadge}>{selectedEntry.entry.type}</span>
                          {selectedCacheHint && (
                            <span
                              className={clsx(
                                styles.cacheHint,
                                selectedCacheHint.kind === 'cached'
                                  ? styles.cacheHintCached
                                  : styles.cacheHintMiss,
                              )}
                            >
                              {selectedCacheHint.kind === 'cached' ? ts('cached') : ts('uncached')}
                            </span>
                          )}
                          {selectedEntry.entry.role && (
                            <span className={clsx(styles.tokenRole, ROLE_CLASS[selectedEntry.entry.role])}>
                              {selectedEntry.entry.role}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {assemblySurface === 'WORK' ? (
                      <div className={styles.entryInspectorEmpty}>
                        {t('ar007.workContentHidden')}
                      </div>
                    ) : selectedChatHistoryMessages && selectedChatHistoryMessages.length > 0 ? (
                      <div className={styles.messageInspectorList}>
                        {selectedChatHistoryUsesReassembledMessages && (
                          <div className={styles.messageInspectorNotice}>
                            {t('messageBoundaryNotice')}
                          </div>
                        )}
                        {selectedChatHistoryMessages.map((message, index) => (
                          <ChatHistoryMessageCard
                            key={`${selectedEntry.key}:${selectedEntry.entry.firstMessageIndex ?? 0}:${index}`}
                            message={message}
                            index={(selectedEntry.entry.firstMessageIndex ?? 0) + index}
                          />
                        ))}
                      </div>
                    ) : selectedEntry.entry.type === 'chat_history' && rawLoading ? (
                      <div className={styles.entryInspectorEmpty}>{t('loadingMessages')}</div>
                    ) : selectedEntry.entry.content != null ? (
                      <pre className={styles.entryInspectorContent}>
                        {findOpen ? highlightFindMatches(selectedEntry.entry.content) : selectedEntry.entry.content}
                      </pre>
                    ) : (
                      <div className={styles.entryInspectorEmpty}>
                        {t('tokenCountsOnly')}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {!loading && data && assemblySurface !== 'WORK' && rawView !== 'off' && (
              <>
                <div className={styles.rawCaveat}>
                  {t('rawCaveat')}
                </div>
                {rawLoading && <div className={styles.loading}>{t('reassembling')}</div>}
                {!rawLoading && rawError && <div className={styles.empty}>{rawError}</div>}
                {!rawLoading && !rawError && rawInput && (
                  <pre className={styles.rawView}>
                    {findOpen ? highlightRawFindMatches(rawText) : rawText}
                  </pre>
                )}
              </>
            )}
          </div>

          {data && (
            <div className={styles.footer}>
              <span className={styles.footerTotal}>{ts('tokens', { count: data.totalTokens })}</span>
              {data.maxContext > 0 && (
                <span className={styles.footerMax}>
                  / {data.maxContext.toLocaleString()} ({((data.totalTokens / data.maxContext) * 100).toFixed(1)}%)
                </span>
              )}
              {sidecarGroup && sidecarGroup.tokens > 0 && (
                <span className={clsx(styles.footerMax, styles.footerMetric)} style={{ color: sidecarGroup.color }}>
                  {t('footerSidecar', { count: sidecarGroup.tokens })}
                </span>
              )}
              {data.chatHistoryTokens != null && data.chatHistoryTokens > 0 && (
                <span className={clsx(styles.footerMax, styles.footerMetric)}>
                  {t('footerChatHistory', { count: data.chatHistoryTokens })}
                </span>
              )}
              <div className={styles.footerSpacer} />
              {assemblySurface !== 'WORK' ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Search size={12} />}
                    onClick={() => {
                      setFindOpen((open) => !open)
                      requestAnimationFrame(() => findInputRef.current?.focus())
                    }}
                  >
                    {t('find')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Code size={12} />}
                    onClick={handleToggleRaw}
                    loading={rawLoading && rawView === 'off'}
                  >
                    {rawButtonLabel}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={copied ? <Check size={12} /> : <Copy size={12} />}
                    onClick={handleCopy}
                    loading={rawLoading && !copied}
                  >
                    {copied ? ts('copied') : ts('copy')}
                  </Button>
                </>
              ) : (
                <span className={styles.workPrivacyFooter}>{t('ar007.workContentsOwnerOnly')}</span>
              )}
            </div>
          )}
    </ModalShell>
  )
}

function ChatHistoryMessageCard({ message, index }: { message: DryRunMessage; index: number }) {
  const { t: ts } = useTranslation('modals', { keyPrefix: 'shared' })
  const lineCount = countLines(message.content)

  return (
    <div className={styles.messageCard}>
      <div className={styles.messageCardHeader}>
        <span className={clsx(styles.tokenRole, ROLE_CLASS[message.role])}>{message.role}</span>
        <span className={styles.messageCardIndex}>#{index + 1}</span>
        <span className={styles.messageCardMeta}>
          {ts('chars', { count: message.content.length })}
          {lineCount > 0 && ` • ${ts('lines', { count: lineCount })}`}
        </span>
      </div>
      <div className={styles.messageCardPreview}>{summarizeMessage(message.content)}</div>
      <pre className={styles.messageCardContent}>{message.content || ts('emptyMessage')}</pre>
    </div>
  )
}

function StackedBar({
  groups,
  total,
  groupLabel,
}: {
  groups: BreakdownGroup[]
  total: number
  groupLabel: (id: string, fallback: string) => string
}) {
  if (total === 0) return null
  return (
    <div className={styles.stackedBar}>
      {groups.map((g) => {
        const pct = (g.tokens / total) * 100
        if (pct < 0.5) return null
        return (
          <div
            key={g.id}
            className={styles.stackedBarSegment}
            style={{ width: `${pct}%`, background: g.color }}
            title={i18n.t('promptItemizer.segmentTitle', {
              ns: 'modals',
              label: groupLabel(g.id, g.label),
              tokens: g.tokens.toLocaleString(),
              percent: pct.toFixed(1),
            })}
          />
        )
      })}
    </div>
  )
}

function Legend({
  groups,
  groupLabel,
}: {
  groups: BreakdownGroup[]
  groupLabel: (id: string, fallback: string) => string
}) {
  return (
    <div className={styles.legend}>
      {groups.map((g) => (
        <div key={g.id} className={styles.legendItem}>
          <div className={styles.legendDot} style={{ background: g.color }} />
          <span>{groupLabel(g.id, g.label)}</span>
          <span className={styles.legendTokens}>{g.tokens.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

function GroupAccordion({ group, displayLabel, total, open, onToggle, selectedEntryKey, onSelectEntry, cacheHintsByKey }: {
  group: BreakdownGroup
  displayLabel: string
  total: number
  open: boolean
  onToggle: () => void
  selectedEntryKey?: string | null
  onSelectEntry?: (key: string) => void
  cacheHintsByKey: Map<string, { kind: 'cached' | 'miss'; label: string }>
}) {
  return (
    <div className={styles.accordion}>
      <button type="button" className={styles.accordionHeader} onClick={onToggle}>
        <div className={styles.accordionDot} style={{ background: group.color }} />
        <span>{displayLabel}</span>
        <span className={styles.accordionTokens}>{i18n.t('shared.tokens', { ns: 'modals', count: group.tokens })}</span>
        <ChevronRight
          size={13}
          className={clsx(styles.accordionChevron, open && styles.accordionChevronOpen)}
        />
      </button>
      {open && (
        <div className={styles.accordionBody}>
          <div className={styles.entryList}>
            {group.entries.map((entry, i) => {
              const pct = total > 0 ? ((entry.tokens / total) * 100).toFixed(1) : '0.0'
              const entryKey = getEntryKey(group.id, i)
              const cacheHint = cacheHintsByKey.get(entryKey)

              return (
                <button
                  key={entryKey}
                  type="button"
                  className={clsx(
                    styles.entryRow,
                    selectedEntryKey === entryKey && styles.entryRowActive,
                  )}
                  onClick={() => onSelectEntry?.(entryKey)}
                >
                  <div className={styles.tokenName}>
                    <div className={styles.tokenColor} style={{ background: getBlockDisplayColor(i) }} />
                    <span>{entry.name}</span>
                    {entry.extensionName && (
                      <span className={styles.tokenRole}>{entry.extensionName}</span>
                    )}
                    {entry.role && (
                      <span className={clsx(styles.tokenRole, ROLE_CLASS[entry.role])}>
                        {entry.role}
                      </span>
                    )}
                    {cacheHint && (
                      <span
                        className={clsx(
                          styles.cacheHint,
                          cacheHint.kind === 'cached' ? styles.cacheHintCached : styles.cacheHintMiss,
                        )}
                        title={cacheHint.label}
                      >
                        {cacheHint.kind === 'cached'
                          ? i18n.t('shared.cached', { ns: 'modals' })
                          : i18n.t('shared.uncached', { ns: 'modals' })}
                      </span>
                    )}
                  </div>
                  <div className={styles.entryMetrics}>
                    <span className={styles.tokenCount}>{entry.tokens.toLocaleString()}</span>
                    <span className={styles.tokenPct}>{pct}%</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
