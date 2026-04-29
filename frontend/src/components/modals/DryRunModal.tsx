import { useEffect, useMemo, useRef, useState } from 'react'
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
  if (!normalized) return '(empty message)'
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
  onSelect: () => void
}

function MessageListItem({ msg, index, selected, onSelect }: MessageListItemProps) {
  const preview = summarizeMessage(msg.content)
  const lineCount = countLines(msg.content)

  return (
    <button
      type="button"
      className={clsx(styles.messageRow, selected && styles.messageRowActive)}
      onClick={onSelect}
    >
      <div className={styles.messageRowHeader}>
        <Badge color={ROLE_COLOR[msg.role] ?? 'neutral'} size="sm" className={styles.roleBadge}>
          {msg.role}
        </Badge>
        <span className={styles.messageIndex}>#{index + 1}</span>
        <span className={styles.messageMeta}>
          {msg.content.length.toLocaleString()} chars
          {lineCount > 0 && ` • ${lineCount.toLocaleString()} lines`}
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
          {expanded ? 'Show less' : `Show full (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </>
  )
}

interface VirtualizedMessagesProps {
  messages: DryRunMessage[]
  selectedIndex: number
  onSelect: (index: number) => void
}

function VirtualizedMessages({ messages, selectedIndex, onSelect }: VirtualizedMessagesProps) {
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
  const modalProps = useStore((s) => s.modalProps) as DryRunResponse
  const closeModal = useStore((s) => s.closeModal)

  const { messages, breakdown, parameters, assistantPrefill, model, provider, tokenCount, worldInfoStats, memoryStats, databankStats, contextClipStats } = modalProps

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

  const rawButtonLabel = rawView === 'off' ? 'Raw' : rawView === 'text' ? 'JSON' : 'Visual'

  // Memoise derived values so toggling a sibling section doesn't re-serialise
  // potentially large payloads on every render.
  const tokenBreakdown = useMemo(
    () => tokenCount?.breakdown || [],
    [tokenCount],
  )

  const parametersJson = useMemo(
    () => JSON.stringify(parameters, null, 2),
    [parameters],
  )

  const databankRetrievalStateLabel = useMemo(() => {
    switch (databankStats?.retrievalState) {
      case 'cache_hit': return 'cache hit'
      case 'awaited_prefetch': return 'awaited prefetch'
      case 'awaited_direct': return 'direct fetch'
      case 'skipped_embeddings_disabled': return 'embeddings disabled'
      case 'skipped_no_active_banks': return 'no active banks'
      default: return null
    }
  }, [databankStats?.retrievalState])

  const selectedMessage = messages[selectedMessageIndex] ?? null
  const selectedMessageLineCount = selectedMessage ? countLines(selectedMessage.content) : 0

  const handleSelectMessage = (index: number) => {
    setSelectedMessageIndex(index)
    setMobileInspectorOpen(true)
  }

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth="clamp(340px, 94vw, min(1100px, var(--lumiverse-content-max-width, 1100px)))" className={styles.modal}>
          {/* Header */}
          <div className={styles.header}>
            <h3 className={styles.headerTitle}>Prompt Dry Run</h3>
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
                Messages ({messages.length}
                {contextClipStats?.enabled && contextClipStats.messagesDropped > 0 && (
                  <span style={{ color: '#ffab00', marginLeft: 6 }}>
                    , {contextClipStats.messagesDropped} clipped
                  </span>
                )}
                )
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
                              Messages
                            </button>
                            <Badge color={ROLE_COLOR[selectedMessage.role] ?? 'neutral'} size="sm" className={styles.roleBadge}>
                              {selectedMessage.role}
                            </Badge>
                            <span className={styles.messageIndex}>#{selectedMessageIndex + 1}</span>
                          </div>
                          <span className={styles.messageInspectorMeta}>
                            {selectedMessage.content.length.toLocaleString()} chars
                            {selectedMessageLineCount > 0 && ` • ${selectedMessageLineCount.toLocaleString()} lines`}
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
                <p className={styles.prefillLabel}>Assistant Prefill</p>
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
                  Assembly Breakdown ({breakdown.length})
                </button>
                {breakdownOpen && (
                  <div className={styles.collapsibleBody}>
                    {tokenCount && (
                      <div className={styles.breakdownSummary}>
                        <span>{tokenCount.total_tokens.toLocaleString()} total tokens</span>
                        {tokenCount.tokenizer_name && (
                          <span className={styles.breakdownSource}>via {tokenCount.tokenizer_name}</span>
                        )}
                      </div>
                    )}
                      <div className={styles.breakdownList}>
                        {breakdown.map((entry, i) => {
                          const tokens = tokenBreakdown[i]?.tokens
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
                            {tokens != null && (
                              <span className={styles.breakdownTokens}>
                                {tokens.toLocaleString()} tokens
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
                  World Info ({worldInfoStats.totalActivated} activated
                  {worldInfoStats.evictedByBudget > 0 && `, ${worldInfoStats.evictedByBudget} evicted`})
                </button>
                {wiStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Total candidates</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.totalCandidates}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Keyword activated</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.keywordActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Vector activated</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.vectorActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Activated (final)</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.totalActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Activated (before budget)</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.activatedBeforeBudget}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Activated (after budget)</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.activatedAfterBudget}</span>
                      </div>
                      {worldInfoStats.evictedByBudget > 0 && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>Evicted by budget</span>
                          <span className={styles.breakdownTokens} style={{ color: '#ffab00' }}>
                            {worldInfoStats.evictedByBudget}
                          </span>
                        </div>
                      )}
                      {worldInfoStats.evictedByMinPriority > 0 && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>Below min priority</span>
                          <span className={styles.breakdownTokens} style={{ color: '#ffab00' }}>
                            {worldInfoStats.evictedByMinPriority}
                          </span>
                        </div>
                      )}
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Estimated tokens</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.estimatedTokens.toLocaleString()}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Recursion passes used</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.recursionPassesUsed}</span>
                      </div>
                      {worldInfoStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>Vector query preview</span>
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
                  Long-Term Memory ({memoryStats.chunksRetrieved} retrieved
                  {memoryStats.chunksPending > 0 && `, ${memoryStats.chunksPending} pending`})
                </button>
                {memStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Injection method</span>
                        <span className={styles.breakdownTokens}>{memoryStats.injectionMethod}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Chunks available</span>
                        <span className={styles.breakdownTokens}>{memoryStats.chunksAvailable}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Chunks pending vectorization</span>
                        <span className={styles.breakdownTokens} style={memoryStats.chunksPending > 0 ? { color: '#ffab00' } : undefined}>
                          {memoryStats.chunksPending}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Settings source</span>
                        <span className={styles.breakdownTokens}>{memoryStats.settingsSource}</span>
                      </div>
                      {memoryStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>Query preview</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {memoryStats.queryPreview}
                          </span>
                        </div>
                      )}
                      {memoryStats.retrievedChunks.length > 0 && (
                        <>
                          <div className={styles.breakdownEntry} style={{ marginTop: 8 }}>
                            <span className={styles.breakdownLabel} style={{ fontWeight: 600 }}>Retrieved Chunks</span>
                          </div>
                          {memoryStats.retrievedChunks.map((chunk, i) => (
                            <div key={i} className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingLeft: 8 }}>
                              <span className={styles.breakdownLabel}>
                                #{i + 1} — score: {chunk.score.toFixed(4)}, ~{chunk.tokenEstimate} tokens
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
                  Databanks ({databankStats.activeBankCount} active, {databankStats.chunksRetrieved} retrieved)
                </button>
                {databankStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Embeddings enabled</span>
                        <span className={styles.breakdownTokens}>{databankStats.embeddingsEnabled ? 'Yes' : 'No'}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Injection method</span>
                        <span className={styles.breakdownTokens}>{databankStats.injectionMethod}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Retrieval state</span>
                        <span className={styles.breakdownTokens}>{databankRetrievalStateLabel ?? databankStats.retrievalState}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Active databanks</span>
                        <span className={styles.breakdownTokens}>{databankStats.activeBankCount}</span>
                      </div>
                      {databankStats.activeDatabankIds.length > 0 && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>Active databank IDs</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {databankStats.activeDatabankIds.join('\n')}
                          </span>
                        </div>
                      )}
                      {databankStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>Query preview</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {databankStats.queryPreview}
                          </span>
                        </div>
                      )}
                      {databankStats.retrievedChunks.length > 0 && (
                        <>
                          <div className={styles.breakdownEntry} style={{ marginTop: 8 }}>
                            <span className={styles.breakdownLabel} style={{ fontWeight: 600 }}>Retrieved Chunks</span>
                          </div>
                          {databankStats.retrievedChunks.map((chunk, i) => (
                            <div key={i} className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingLeft: 8 }}>
                              <span className={styles.breakdownLabel}>
                                #{i + 1} — {chunk.documentName}, score: {chunk.score.toFixed(4)}, ~{chunk.tokenEstimate} tokens
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
                  Context Budget
                  {!contextClipStats.enabled && (
                    <span className={styles.breakdownSource} style={{ marginLeft: 6 }}>
                      (no max_context_length set — clipping disabled)
                    </span>
                  )}
                  {contextClipStats.enabled && contextClipStats.budgetInvalid && (
                    <span style={{ color: '#ff5470', marginLeft: 6 }}>
                      (budget invalid — context size ≤ reserved response tokens)
                    </span>
                  )}
                  {contextClipStats.enabled && !contextClipStats.budgetInvalid && contextClipStats.messagesDropped > 0 && (
                    <span style={{ color: '#ffab00', marginLeft: 6 }}>
                      ({contextClipStats.messagesDropped} message{contextClipStats.messagesDropped === 1 ? '' : 's'} clipped, {contextClipStats.tokensDropped.toLocaleString()} tokens)
                    </span>
                  )}
                  {contextClipStats.enabled && !contextClipStats.budgetInvalid && contextClipStats.messagesDropped === 0 && (
                    <span className={styles.breakdownSource} style={{ marginLeft: 6 }}>
                      (fits within budget)
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
                          Budget cannot fit any chat history
                        </span>
                        <span className={styles.breakdownSource}>
                          input budget = max_context ({contextClipStats.maxContext.toLocaleString()})
                          {' − '}max_tokens ({contextClipStats.maxResponseTokens.toLocaleString()})
                          {' − '}safety ({contextClipStats.safetyMargin.toLocaleString()}) ={' '}
                          {contextClipStats.inputBudget.toLocaleString()}. Raise Context Size or
                          lower Max Tokens.
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
                          {contextClipStats.fixedOverBudget
                            ? 'Fixed prompt overhead already exceeds the budget'
                            : 'Fixed prompt overhead leaves no room for chat history'}
                        </span>
                        <span className={styles.breakdownSource}>
                          Chat history is the only clip-eligible section. System prompt, WI, persona, and other fixed blocks stay in the prompt, leaving{' '}
                          {Math.max(0, contextClipStats.remainingHistoryBudget).toLocaleString()} tokens for history.
                          {contextClipStats.fixedOverBudget && (
                            <> Fixed overhead is over budget by {Math.abs(contextClipStats.remainingHistoryBudget).toLocaleString()} tokens.</>
                          )}
                        </span>
                      </div>
                    )}
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Max context length</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.maxContext > 0
                            ? `${contextClipStats.maxContext.toLocaleString()} tokens`
                            : '— (unset)'}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Reserved for response</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.maxResponseTokens.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Safety margin</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.safetyMargin.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Input budget before fixed overhead</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.budgetInvalid ? { color: '#ff5470' } : undefined}
                        >
                          {contextClipStats.inputBudget.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Fixed overhead (system / WI / persona / etc.)</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.fixedTokens.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Remaining room for chat history</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.remainingHistoryBudget < 0 ? { color: '#ff5470' } : contextClipStats.remainingHistoryBudget === 0 ? { color: '#ffab00' } : undefined}
                        >
                          {Math.max(0, contextClipStats.remainingHistoryBudget).toLocaleString()} tokens
                          {contextClipStats.remainingHistoryBudget < 0
                            ? ` (${Math.abs(contextClipStats.remainingHistoryBudget).toLocaleString()} over)`
                            : ''}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Chat history before clip</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.chatHistoryTokensBefore.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Chat history after clip</span>
                        <span className={styles.breakdownTokens}>
                          {contextClipStats.chatHistoryTokensAfter.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Messages dropped</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.messagesDropped > 0 ? { color: '#ffab00' } : undefined}
                        >
                          {contextClipStats.messagesDropped.toLocaleString()}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Tokens dropped</span>
                        <span
                          className={styles.breakdownTokens}
                          style={contextClipStats.tokensDropped > 0 ? { color: '#ffab00' } : undefined}
                        >
                          {contextClipStats.tokensDropped.toLocaleString()}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Tokenizer used</span>
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
                  Parameters
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
              {messages.length} message{messages.length === 1 ? '' : 's'}
            </span>
            {tokenCount && (
              <span className={styles.footerMax}>
                {tokenCount.total_tokens.toLocaleString()} tokens
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
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
    </ModalShell>
  )
}
