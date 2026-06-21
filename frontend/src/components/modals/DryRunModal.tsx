import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronLeft, ChevronRight, Check, Code, Copy } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Badge } from '@/components/shared/Badge'
import { Button } from '@/components/shared/FormComponents'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import type { DryRunResponse, DryRunMessage } from '@/api/generate'
import { copyTextToClipboard } from '@/lib/clipboard'
import { dryRunToRawPromptInput, formatRawPrompt, type RawPromptView } from '@/lib/formatRawPrompt'
import i18n from '@/i18n'
import { getAnthropicBreakdownCacheHints, getAnthropicCacheUsageSummary } from '@/lib/anthropic-breakdown-cache'
import { getNanoGptCacheUsageSummary } from '@/lib/nanogpt-breakdown-cache'
import styles from './DryRunModal.module.css'
import clsx from 'clsx'

const ROLE_COLOR: Record<string, 'warning' | 'info' | 'primary'> = {
  system: 'warning',
  user: 'info',
  assistant: 'primary',
}

// Auto-collapse the messages section above this count to keep the modal snappy on open.
const MESSAGES_AUTO_COLLAPSE_THRESHOLD = 50
// Fixed-height rows keep the list stable even when prompt content is huge.
const MESSAGE_ROW_HEIGHT = 68
const MESSAGE_PREVIEW_CAP = 220
// Memory chunk previews are clipped to this many characters by default.
const CHUNK_PREVIEW_CAP = 500

function summarizeMessage(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return i18n.t('shared.emptyMessage', { ns: 'modals' })
  return normalized.length > MESSAGE_PREVIEW_CAP
    ? `${normalized.slice(0, MESSAGE_PREVIEW_CAP - 1)}…`
    : normalized
}

function countLines(content: string): number {
  if (!content) return 0
  return content.split(/\r\n|\r|\n/).length
}

interface MessageListItemProps {
  msg: DryRunMessage
  index: number
  selected: boolean
  clipBoundary: boolean
  clipBoundaryLabel?: string
  onSelect: () => void
}

function MessageListItem({ msg, index, selected, clipBoundary, clipBoundaryLabel, onSelect }: MessageListItemProps) {
  const { t: ts } = useTranslation('modals', { keyPrefix: 'shared' })
  const preview = summarizeMessage(msg.content)
  const lineCount = countLines(msg.content)

  return (
    <button
      type="button"
      className={clsx(
        styles.messageRow,
        clipBoundary && styles.messageRowClipBoundary,
        selected && styles.messageRowActive,
      )}
      onClick={onSelect}
    >
      <div className={styles.messageRowHeader}>
        <Badge color={ROLE_COLOR[msg.role] ?? 'neutral'} size="sm" className={styles.roleBadge}>
          {msg.role}
        </Badge>
        <span className={styles.messageIndex}>#{index + 1}</span>
        {clipBoundary && clipBoundaryLabel && (
          <span className={styles.messageClipBadge}>{clipBoundaryLabel}</span>
        )}
        <span className={styles.messageMeta}>
          {ts('chars', { count: msg.content.length })}
          {lineCount > 0 && ` • ${ts('lines', { count: lineCount })}`}
        </span>
      </div>
      <div className={styles.messagePreview}>{preview}</div>
    </button>
  )
}

interface ChunkPreviewProps {
  text: string
}

function ChunkPreview({ text }: ChunkPreviewProps) {
  const { t: ts } = useTranslation('modals', { keyPrefix: 'shared' })
  const [expanded, setExpanded] = useState(false)
  const needsToggle = text.length > CHUNK_PREVIEW_CAP
  const display = expanded || !needsToggle ? text : text.slice(0, CHUNK_PREVIEW_CAP) + '…'
  return (
    <>
      <span className={styles.chunkPreview}>{display}</span>
      {needsToggle && (
        <button
          type="button"
          className={styles.inlineExpandButton}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? ts('showLess') : ts('showFull', { count: text.length })}
        </button>
      )}
    </>
  )
}

interface VirtualizedMessagesProps {
  messages: DryRunMessage[]
  selectedIndex: number
  clipBoundaryIndex: number
  clipBoundaryLabel?: string
  onSelect: (index: number) => void
}

function VirtualizedMessages({ messages, selectedIndex, clipBoundaryIndex, clipBoundaryLabel, onSelect }: VirtualizedMessagesProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => MESSAGE_ROW_HEIGHT,
    overscan: 10,
  })

  return (
    <div ref={parentRef} className={styles.messagesScroll}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const msg = messages[virtualRow.index]
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom: 8,
              }}
            >
              <MessageListItem
                msg={msg}
                index={virtualRow.index}
                selected={selectedIndex === virtualRow.index}
                clipBoundary={virtualRow.index === clipBoundaryIndex}
                clipBoundaryLabel={clipBoundaryLabel}
                onSelect={() => onSelect(virtualRow.index)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function DryRunModal() {
  const { t } = useTranslation('modals', { keyPrefix: 'dryRun' })
  const { t: ts } = useTranslation('modals', { keyPrefix: 'shared' })
  const modalProps = useStore((s) => s.modalProps) as DryRunResponse
  const closeModal = useStore((s) => s.closeModal)

  const { messages, breakdown, parameters, assistantPrefill, model, provider, tokenCount, chatHistoryTokens, worldInfoStats, memoryStats, databankStats, contextClipStats } = modalProps

  const [messagesOpen, setMessagesOpen] = useState(
    messages.length <= MESSAGES_AUTO_COLLAPSE_THRESHOLD,
  )
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [wiStatsOpen, setWiStatsOpen] = useState(false)
  const [memStatsOpen, setMemStatsOpen] = useState(false)
  const [databankStatsOpen, setDatabankStatsOpen] = useState(false)
  // Auto-open the budget section when clipping is in a problem state so
  // users discover why their chat history is missing without hunting.
  const [budgetOpen, setBudgetOpen] = useState(
    Boolean(contextClipStats?.budgetInvalid) || (contextClipStats?.messagesDropped ?? 0) > 0,
  )
  const [rawView, setRawView] = useState<'off' | RawPromptView>('off')
  const [copied, setCopied] = useState(false)
  const [selectedMessageIndex, setSelectedMessageIndex] = useState(0)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)

  useEffect(() => {
    setSelectedMessageIndex((prev) => {
      if (messages.length === 0) return 0
      return Math.min(prev, messages.length - 1)
    })
  }, [messages.length])

  useEffect(() => {
    if (!messagesOpen) setMobileInspectorOpen(false)
  }, [messagesOpen])

  const rawInput = useMemo(() => dryRunToRawPromptInput(modalProps), [modalProps])
  const rawText = useMemo(
    () => (rawView === 'off' ? '' : formatRawPrompt(rawInput, rawView)),
    [rawInput, rawView],
  )

  const handleCopy = () => {
    const text = formatRawPrompt(rawInput, rawView === 'json' ? 'json' : 'text')
    copyTextToClipboard(text).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const cycleRawView = () => {
    setRawView((v) => (v === 'off' ? 'text' : v === 'text' ? 'json' : 'off'))
  }

  const rawButtonLabel = rawView === 'off' ? ts('raw') : rawView === 'text' ? ts('json') : ts('visual')

  // Memoise derived values so toggling a sibling section doesn't re-serialise
  // potentially large payloads on every render.
  const tokenBreakdown = useMemo(
    () => tokenCount?.breakdown || [],
    [tokenCount],
  )
  const breakdownCacheHints = useMemo(
    () => getAnthropicBreakdownCacheHints({ provider, parameters, breakdown }),
    [provider, parameters, breakdown],
  )
  const anthropicCacheUsage = useMemo(
    () => getAnthropicCacheUsageSummary(provider, modalProps.usage),
    [provider, modalProps.usage],
  )
  const nanoGptCacheUsage = useMemo(
    () => getNanoGptCacheUsageSummary(provider, modalProps.usage),
    [provider, modalProps.usage],
  )

  const parametersJson = useMemo(
    () => JSON.stringify(parameters, null, 2),
    [parameters],
  )

  const databankRetrievalStateLabel = useMemo(() => {
    const state = databankStats?.retrievalState
    if (!state) return null
    return t(`retrieval.${state}`)
  }, [databankStats?.retrievalState, t])

  const selectedMessage = messages[selectedMessageIndex] ?? null
  const selectedMessageLineCount = selectedMessage ? countLines(selectedMessage.content) : 0
  const clippedMessagesText = contextClipStats?.enabled && contextClipStats.messagesDropped > 0
    ? t('clipped', { count: contextClipStats.messagesDropped }).trim()
    : ''
  const clippedMessagesSeparator = clippedMessagesText.match(/^[,，、]\s*/)?.[0] ?? ', '
  const clippedMessagesLabel = clippedMessagesText.replace(/^[,，、]\s*/, '').trim()
  const clipBoundaryIndex = useMemo(() => {
    if (!contextClipStats?.enabled || contextClipStats.messagesDropped <= 0 || messages.length === 0) return -1
    const firstKeptHistoryIndex = messages.findIndex((msg) => msg.__chatHistorySource)
    return firstKeptHistoryIndex >= 0 ? firstKeptHistoryIndex : 0
  }, [contextClipStats?.enabled, contextClipStats?.messagesDropped, messages])
  const clipBoundaryLabel = clipBoundaryIndex >= 0
    ? t('clipBoundaryMarker', { defaultValue: 'first kept after clip' })
    : undefined

  const handleSelectMessage = (index: number) => {
    setSelectedMessageIndex(index)
    setMobileInspectorOpen(true)
  }

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth="clamp(340px, 94vw, min(1100px, var(--lumiverse-content-max-width, 1100px)))" className={styles.modal}>
          {/* Header */}
          <div className={styles.header}>
            <h3 className={styles.headerTitle}>{t('title')}</h3>
            <Badge color="primary">
              {provider} / {model}
            </Badge>
            <CloseButton onClick={closeModal} variant="solid" className={styles.closeBtn} />
          </div>

          {/* Scrollable body */}
          <div className={styles.body}>
            {rawView !== 'off' ? (
              <pre className={styles.rawView}>{rawText}</pre>
            ) : (
              <>
            {/* Messages — collapsible + virtualised so 600+ message chats stay responsive */}
            <div className={styles.collapsible}>
              <button
                type="button"
                className={styles.collapsibleHeader}
                onClick={() => setMessagesOpen((o) => !o)}
              >
                <ChevronRight
                  size={14}
                  className={clsx(styles.chevron, messagesOpen && styles.chevronOpen)}
                />
                <span className={styles.collapsibleTitleText}>
                  {t('messages')} ({messages.length}
                  {clippedMessagesLabel && (
                    <>
                      {clippedMessagesSeparator}
                      <span className={styles.clippedInlineLabel}>{clippedMessagesLabel}</span>
                    </>
                  )}
                  )
                </span>
              </button>
              {messagesOpen && messages.length > 0 && (
                <div
                  className={clsx(
                    styles.messagesCollapsibleBody,
                    mobileInspectorOpen && styles.messagesMobileInspectorVisible,
                  )}
                >
                  <VirtualizedMessages
                    messages={messages}
                    selectedIndex={selectedMessageIndex}
                    clipBoundaryIndex={clipBoundaryIndex}
                    clipBoundaryLabel={clipBoundaryLabel}
                    onSelect={handleSelectMessage}
                  />
                  <div className={styles.messageInspector}>
                    {selectedMessage && (
                      <>
                        <div className={styles.messageInspectorHeader}>
                          <div className={styles.messageInspectorTitleRow}>
                            <button
                              type="button"
                              className={styles.mobileBackButton}
                              onClick={() => setMobileInspectorOpen(false)}
                            >
                              <ChevronLeft size={14} />
                              {t('messages')}
                            </button>
                            <Badge color={ROLE_COLOR[selectedMessage.role] ?? 'neutral'} size="sm" className={styles.roleBadge}>
                              {selectedMessage.role}
                            </Badge>
                            <span className={styles.messageIndex}>#{selectedMessageIndex + 1}</span>
                          </div>
                          <span className={styles.messageInspectorMeta}>
                            {ts('chars', { count: selectedMessage.content.length })}
                            {selectedMessageLineCount > 0 && ` • ${ts('lines', { count: selectedMessageLineCount })}`}
                          </span>
                        </div>
                        <pre className={styles.messageInspectorContent}>{selectedMessage.content}</pre>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Assistant prefill */}
            {assistantPrefill && (
              <div className={styles.prefillSection}>
                <p className={styles.prefillLabel}>{t('assistantPrefill')}</p>
                <div className={styles.prefillContent}>{assistantPrefill}</div>
              </div>
            )}

            {/* Breakdown */}
            {breakdown.length > 0 && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setBreakdownOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, breakdownOpen && styles.chevronOpen)}
                  />
                  {t('assemblyBreakdown', { count: breakdown.length })}
                </button>
                {breakdownOpen && (
                  <div className={styles.collapsibleBody}>
                    {tokenCount && (
                      <div className={styles.breakdownSummary}>
                        <span>{t('totalTokens', { count: tokenCount.total_tokens })}</span>
                        {chatHistoryTokens != null && chatHistoryTokens > 0 && (
                          <span className={styles.breakdownSource}>{t('chatHistoryTokens', { count: chatHistoryTokens })}</span>
                        )}
                        {tokenCount.tokenizer_name && (
                          <span className={styles.breakdownSource}>{t('viaTokenizer', { name: tokenCount.tokenizer_name })}</span>
                        )}
                        {anthropicCacheUsage && (
                          <span className={styles.breakdownSource}>
                            {t('cacheReadWrite', {
                              read: anthropicCacheUsage.cacheReadInputTokens.toLocaleString(),
                              write: anthropicCacheUsage.cacheCreationInputTokens.toLocaleString(),
                            })}
                            {anthropicCacheUsage.cacheCreation5mInputTokens > 0 && t('cache5m', { count: anthropicCacheUsage.cacheCreation5mInputTokens })}
                            {anthropicCacheUsage.cacheCreation1hInputTokens > 0 && t('cache1h', { count: anthropicCacheUsage.cacheCreation1hInputTokens })}
                          </span>
                        )}
                        {nanoGptCacheUsage && (
                          <span className={styles.breakdownSource}>
                            {[
                              nanoGptCacheUsage.cacheReadInputTokens > 0 && `read ${nanoGptCacheUsage.cacheReadInputTokens.toLocaleString()}`,
                              nanoGptCacheUsage.cacheCreationInputTokens > 0 && `write ${nanoGptCacheUsage.cacheCreationInputTokens.toLocaleString()}`,
                              nanoGptCacheUsage.cachedTokensOpenAiStyle > 0 && `cached ${nanoGptCacheUsage.cachedTokensOpenAiStyle.toLocaleString()}`,
                            ].filter(Boolean).join(' • ')}
                          </span>
                        )}
                      </div>
                    )}
                      <div className={styles.breakdownList}>
                        {breakdown.map((entry, i) => {
                          const tokens = tokenBreakdown[i]?.tokens
                          const cacheHint = breakdownCacheHints[i]
                          return (
                            <div key={i} className={styles.breakdownEntry}>
                              <span className={styles.breakdownLabel}>{entry.name}</span>
                              {entry.extensionName && (
                                <span className={styles.breakdownRole}>{entry.extensionName}</span>
                              )}
                              <span className={styles.breakdownSource}>{entry.type}</span>
                              {entry.role && (
                                <span className={styles.breakdownRole}>{entry.role}</span>
                             )}
                              {cacheHint && (
                                <span
                                  className={clsx(
                                    styles.breakdownCacheHint,
                                    cacheHint.kind === 'cached'
                                      ? styles.breakdownCacheHintCached
                                      : styles.breakdownCacheHintMiss,
                                  )}
                                  title={cacheHint.label}
                                >
                                  {cacheHint.kind === 'cached' ? t('cached') : t('uncached')}
                                </span>
                              )}
                             {tokens != null && (
                               <span className={styles.breakdownTokens}>
                                 {ts('tokens', { count: tokens })}
                               </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* World Info Stats */}
            {worldInfoStats && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setWiStatsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, wiStatsOpen && styles.chevronOpen)}
                  />
                  {t('worldInfoSection', {
                    activated: worldInfoStats.totalActivated,
                    evicted: worldInfoStats.evictedByBudget > 0
                      ? t('worldInfoEvicted', { count: worldInfoStats.evictedByBudget })
                      : '',
                  })}
                </button>
                {wiStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.totalCandidates')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.totalCandidates}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.keywordActivated')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.keywordActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.vectorActivated')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.vectorActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.activatedFinal')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.totalActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.activatedBeforeBudget')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.activatedBeforeBudget}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.activatedAfterBudget')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.activatedAfterBudget}</span>
                      </div>
                      {worldInfoStats.evictedByBudget > 0 && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>{t('wi.evictedByBudget')}</span>
                          <span className={styles.breakdownTokens} style={{ color: '#ffab00' }}>
                            {worldInfoStats.evictedByBudget}
                          </span>
                        </div>
                      )}
                      {worldInfoStats.evictedByMinPriority > 0 && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>{t('wi.belowMinPriority')}</span>
                          <span className={styles.breakdownTokens} style={{ color: '#ffab00' }}>
                            {worldInfoStats.evictedByMinPriority}
                          </span>
                        </div>
                      )}
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.estimatedTokens')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.estimatedTokens.toLocaleString()}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('wi.recursionPasses')}</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.recursionPassesUsed}</span>
                      </div>
                      {worldInfoStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>{t('wi.vectorQueryPreview')}</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {worldInfoStats.queryPreview}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Memory Stats */}
            {memoryStats && memoryStats.enabled && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setMemStatsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, memStatsOpen && styles.chevronOpen)}
                  />
                  {t('memorySection', {
                    retrieved: memoryStats.chunksRetrieved,
                    pending: memoryStats.chunksPending > 0
                      ? t('memoryPending', { count: memoryStats.chunksPending })
                      : '',
                  })}
                </button>
                {memStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('memory.injectionMethod')}</span>
                        <span className={styles.breakdownTokens}>{memoryStats.injectionMethod}</span>
                      </div>
                      {memoryStats.retrievalMode && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>Retrieval mode</span>
                          <span
                            className={styles.breakdownTokens}
                            style={memoryStats.retrievalMode === 'recency' ? { color: '#ffab00' } : undefined}
                            title={memoryStats.retrievalMode === 'recency'
                              ? 'Vector search was unavailable (e.g. the query embedding failed); chunks were chosen by recency and have no similarity score.'
                              : undefined}
                          >
                            {memoryStats.retrievalMode === 'recency' ? 'recency fallback' : memoryStats.retrievalMode}
                          </span>
                        </div>
                      )}
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('memory.chunksAvailable')}</span>
                        <span className={styles.breakdownTokens}>{memoryStats.chunksAvailable}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('memory.chunksPending')}</span>
                        <span className={styles.breakdownTokens} style={memoryStats.chunksPending > 0 ? { color: '#ffab00' } : undefined}>
                          {memoryStats.chunksPending}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('memory.settingsSource')}</span>
                        <span className={styles.breakdownTokens}>{memoryStats.settingsSource}</span>
                      </div>
                      {memoryStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>{t('memory.queryPreview')}</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {memoryStats.queryPreview}
                          </span>
                        </div>
                      )}
                      {memoryStats.retrievedChunks.length > 0 && (
                        <>
                          <div className={styles.breakdownEntry} style={{ marginTop: 8 }}>
                            <span className={styles.breakdownLabel} style={{ fontWeight: 600 }}>{t('memory.retrievedChunks')}</span>
                          </div>
                          {memoryStats.retrievedChunks.map((chunk, i) => (
                            <div key={i} className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingLeft: 8 }}>
                              <span className={styles.breakdownLabel}>
                                {t('memory.chunkLine', { index: i + 1, score: chunk.score != null ? chunk.score.toFixed(4) : 'n/a', tokens: chunk.tokenEstimate })}
                              </span>
                              <ChunkPreview text={chunk.preview} />
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Databank Stats */}
            {databankStats && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setDatabankStatsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, databankStatsOpen && styles.chevronOpen)}
                  />
                  {t('databankSection', {
                    banks: databankStats.activeBankCount,
                    retrieved: databankStats.chunksRetrieved,
                  })}
                </button>
                {databankStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('databank.embeddingsEnabled')}</span>
                        <span className={styles.breakdownTokens}>{databankStats.embeddingsEnabled ? t('yes') : t('no')}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('databank.injectionMethod')}</span>
                        <span className={styles.breakdownTokens}>{databankStats.injectionMethod}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('databank.retrievalState')}</span>
                        <span className={styles.breakdownTokens}>{databankRetrievalStateLabel ?? databankStats.retrievalState}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('databank.activeBanks')}</span>
                        <span className={styles.breakdownTokens}>{databankStats.activeBankCount}</span>
                      </div>
                      {databankStats.activeDatabankIds.length > 0 && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>{t('databank.activeBankIds')}</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {databankStats.activeDatabankIds.join('\n')}
                          </span>
                        </div>
                      )}
                      {databankStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>{t('databank.queryPreview')}</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {databankStats.queryPreview}
                          </span>
                        </div>
                      )}
                      {databankStats.retrievedChunks.length > 0 && (
                        <>
                          <div className={styles.breakdownEntry} style={{ marginTop: 8 }}>
                            <span className={styles.breakdownLabel} style={{ fontWeight: 600 }}>{t('databank.retrievedChunks')}</span>
                          </div>
                          {databankStats.retrievedChunks.map((chunk, i) => (
                            <div key={i} className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingLeft: 8 }}>
                              <span className={styles.breakdownLabel}>
                                {t('databank.chunkLine', {
                                  index: i + 1,
                                  document: chunk.documentName,
                                  score: chunk.score.toFixed(4),
                                  tokens: chunk.tokenEstimate,
                                })}
                              </span>
                              <ChunkPreview text={chunk.preview} />
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Context Budget — surfaces history clipping so users understand
                why their 600-message chat shrank to 240 in the prompt. */}
            {contextClipStats && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setBudgetOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, budgetOpen && styles.chevronOpen)}
                  />
                  {t('contextBudget')}
                  {!contextClipStats.enabled && (
                    <span className={styles.breakdownSource} style={{ marginLeft: 6 }}>
                      {t('clippingDisabled')}
                    </span>
                  )}
                  {contextClipStats.enabled && contextClipStats.budgetInvalid && (
                    <span style={{ color: '#ff5470', marginLeft: 6 }}>
                      {t('budgetInvalid')}
                    </span>
                  )}
                  {contextClipStats.enabled && !contextClipStats.budgetInvalid && contextClipStats.messagesDropped > 0 && (
                    <span style={{ color: '#ffab00', marginLeft: 6 }}>
                      {t('messagesClipped', {
                        count: contextClipStats.messagesDropped,
                        messages: contextClipStats.messagesDropped,
                        tokens: contextClipStats.tokensDropped.toLocaleString(),
                      })}
                    </span>
                  )}
                  {contextClipStats.enabled && !contextClipStats.budgetInvalid && contextClipStats.messagesDropped === 0 && (
                    <span className={styles.breakdownSource} style={{ marginLeft: 6 }}>
                      {t('fitsBudget')}
                    </span>
                  )}
                </button>
                {budgetOpen && (
                  <div className={styles.collapsibleBody}>
                  {contextClipStats.enabled && contextClipStats.budgetInvalid && (
                    <div
                      className={styles.breakdownEntry}
                        style={{
                          marginBottom: 8,
                          background: 'rgba(255, 84, 112, 0.08)',
                          borderLeft: '3px solid #ff5470',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 4,
                        }}
                      >
                        <span className={styles.breakdownLabel} style={{ color: '#ff5470' }}>
                          {t('budgetNoHistory')}
                        </span>
                        <span className={styles.breakdownSource}>
                          {t('budgetNoHistoryDetail', {
                            max: contextClipStats.maxContext.toLocaleString(),
                            reserved: contextClipStats.maxResponseTokens.toLocaleString(),
                            safety: contextClipStats.safetyMargin.toLocaleString(),
                            input: contextClipStats.inputBudget.toLocaleString(),
                          })}
                        </span>
                      </div>
                    )}
                    {contextClipStats.enabled && !contextClipStats.budgetInvalid && contextClipStats.remainingHistoryBudget <= 0 && (
                      <div
                        className={styles.breakdownEntry}
                        style={{
                          marginBottom: 8,
                          background: contextClipStats.fixedOverBudget ? 'rgba(255, 84, 112, 0.08)' : 'rgba(255, 171, 0, 0.08)',
                          borderLeft: `3px solid ${contextClipStats.fixedOverBudget ? '#ff5470' : '#ffab00'}`,
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 4,
                        }}
                      >
                        <span
                          className={styles.breakdownLabel}
                          style={{ color: contextClipStats.fixedOverBudget ? '#ff5470' : '#ffab00' }}
                        >
                          {contextClipStats.fixedOverBudget ? t('fixedOverBudget') : t('fixedNoHistoryRoom')}
                        </span>
                        <span className={styles.breakdownSource}>
                          {t('fixedNoHistoryDetail', {
                            remaining: Math.max(0, contextClipStats.remainingHistoryBudget).toLocaleString(),
                          })}
                          {contextClipStats.fixedOverBudget && (
                            <> {t('fixedOverBy', { count: Math.abs(contextClipStats.remainingHistoryBudget).toLocaleString() })}</>
                          )}
                        </span>
                      </div>
                    )}
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.maxContext')}</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.maxContext > 0
                            ? t('budget.tokens', { count: contextClipStats.maxContext })
                            : t('budget.unset')}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.reservedResponse')}</span>
                        <span className={styles.breakdownTokens}>
                          {t('budget.tokens', { count: contextClipStats.maxResponseTokens })}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.safetyMargin')}</span>
                        <span className={styles.breakdownTokens}>
                          {t('budget.tokens', { count: contextClipStats.safetyMargin })}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.inputBeforeFixed')}</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.budgetInvalid ? { color: '#ff5470' } : undefined}
                        >
                          {t('budget.tokens', { count: contextClipStats.inputBudget })}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.fixedOverhead')}</span>
                        <span className={styles.breakdownTokens}>
                          {t('budget.tokens', { count: contextClipStats.fixedTokens })}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.remainingHistory')}</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.remainingHistoryBudget < 0 ? { color: '#ff5470' } : contextClipStats.remainingHistoryBudget === 0 ? { color: '#ffab00' } : undefined}
                        >
                          {t('budget.tokens', { count: Math.max(0, contextClipStats.remainingHistoryBudget) })}
                          {contextClipStats.remainingHistoryBudget < 0
                            ? t('budget.overBudget', { count: Math.abs(contextClipStats.remainingHistoryBudget) })
                            : ''}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.historyBefore')}</span>
                        <span className={styles.breakdownTokens}>
                          {t('budget.tokens', { count: contextClipStats.chatHistoryTokensBefore })}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.historyAfter')}</span>
                        <span className={styles.breakdownTokens}>
                          {t('budget.tokens', { count: contextClipStats.chatHistoryTokensAfter })}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.messagesDropped')}</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.messagesDropped > 0 ? { color: '#ffab00' } : undefined}
                        >
                          {contextClipStats.messagesDropped.toLocaleString()}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.tokensDropped')}</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.tokensDropped > 0 ? { color: '#ffab00' } : undefined}
                        >
                          {contextClipStats.tokensDropped.toLocaleString()}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>{t('budget.tokenizerUsed')}</span>
                        <span className={styles.breakdownSource}>{contextClipStats.tokenizerUsed}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Parameters */}
            {Object.keys(parameters).length > 0 && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setParamsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, paramsOpen && styles.chevronOpen)}
                  />
                  {t('parameters')}
                </button>
                {paramsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.parametersJson}>
                      {parametersJson}
                    </div>
                  </div>
                )}
              </div>
            )}
              </>
            )}
          </div>

          <div className={styles.footer}>
            <span className={styles.footerTotal}>
              {t('footerMessages', { count: messages.length })}
            </span>
            {tokenCount && (
              <span className={styles.footerMax}>
                {ts('tokens', { count: tokenCount.total_tokens })}
              </span>
            )}
            {chatHistoryTokens != null && chatHistoryTokens > 0 && (
              <span className={styles.footerMax}>
                {t('footerChatHistory', { count: chatHistoryTokens })}
              </span>
            )}
            <div className={styles.footerSpacer} />
            <Button variant="ghost" size="sm" icon={<Code size={12} />} onClick={cycleRawView}>
              {rawButtonLabel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={copied ? <Check size={12} /> : <Copy size={12} />}
              onClick={handleCopy}
            >
              {copied ? ts('copied') : ts('copy')}
            </Button>
          </div>
    </ModalShell>
  )
}
