import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronRight, Copy, Check, Code } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { generateApi, type DryRunResponse } from '@/api/generate'
import type { BreakdownCacheEntry } from '@/types/store'
import { groupBreakdownEntries, getBlockDisplayColor } from '@/lib/prompt-breakdown'
import type { BreakdownGroup } from '@/lib/prompt-breakdown'
import { copyTextToClipboard } from '@/lib/clipboard'
import { dryRunToRawPromptInput, formatRawPrompt, type RawPromptView } from '@/lib/formatRawPrompt'
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

export default function PromptItemizerModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const breakdownCache = useStore((s) => s.breakdownCache)
  const cacheBreakdown = useStore((s) => s.cacheBreakdown)
  const activeChatId = useStore((s) => s.activeChatId)
  const messages = useStore((s) => s.messages)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)

  const messageId = modalProps?.messageId as string | undefined
  const chatId = useMemo(() => {
    if (!messageId) return activeChatId
    const m = messages.find((x) => x.id === messageId) as { chat_id?: string } | undefined
    return m?.chat_id ?? activeChatId
  }, [messageId, messages, activeChatId])

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<BreakdownCacheEntry | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set(['Lumiverse Prompts', 'Chat History', 'Long-Term Memory']),
  )
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null)
  const [rawView, setRawView] = useState<'off' | RawPromptView>('off')
  const [copied, setCopied] = useState(false)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [rawData, setRawData] = useState<DryRunResponse | null>(null)

  useEffect(() => {
    if (!messageId) return

    const cached = breakdownCache[messageId]
    if (cached) {
      setData(cached)
      return
    }

    setLoading(true)
    generateApi.getBreakdown(messageId)
      .then((res) => {
        const entry: BreakdownCacheEntry = {
          entries: res.entries,
          totalTokens: res.totalTokens,
          maxContext: res.maxContext,
          model: res.model,
          provider: res.provider,
          presetName: res.presetName,
          tokenizer_name: res.tokenizer_name,
        }
        cacheBreakdown(messageId, entry)
        setData(entry)
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [messageId, breakdownCache, cacheBreakdown])

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      next.has(label) ? next.delete(label) : next.add(label)
      return next
    })
  }

  const ensureRawData = useCallback(async (): Promise<DryRunResponse | null> => {
    if (rawData) return rawData
    if (!chatId || !messageId) {
      setRawError('Missing chat context — open this modal from an active chat.')
      return null
    }
    setRawLoading(true)
    setRawError(null)
    try {
      const res = await generateApi.dryRun({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
        exclude_message_id: messageId,
      })
      setRawData(res)
      return res
    } catch (err: any) {
      setRawError(err?.message || 'Failed to reassemble prompt.')
      return null
    } finally {
      setRawLoading(false)
    }
  }, [rawData, chatId, messageId, activeProfileId, activePersonaId, getActivePresetForGeneration])

  const handleToggleRaw = useCallback(async () => {
    if (rawView !== 'off') {
      setRawView((v) => (v === 'text' ? 'json' : 'off'))
      return
    }
    const res = await ensureRawData()
    if (res) setRawView('text')
  }, [rawView, ensureRawData])

  const handleCopy = useCallback(async () => {
    const res = await ensureRawData()
    if (!res) return
    const view: RawPromptView = rawView === 'json' ? 'json' : 'text'
    const text = formatRawPrompt(dryRunToRawPromptInput(res), view)
    copyTextToClipboard(text).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [ensureRawData, rawView])

  const rawText = useMemo(() => {
    if (rawView === 'off' || !rawData) return ''
    return formatRawPrompt(dryRunToRawPromptInput(rawData), rawView)
  }, [rawView, rawData])

  const rawButtonLabel = rawView === 'off' ? 'Raw' : rawView === 'text' ? 'JSON' : 'Visual'

  const groups = useMemo(() => (data ? groupBreakdownEntries(data.entries) : []), [data])
  const sidecarGroup = groups.find((g) => g.label === 'Sidecar (Lumi Pipeline)')
  const mainGroups = groups.filter((g) => g.label !== 'Sidecar (Lumi Pipeline)')
  const flatEntries = useMemo(
    () => groups.flatMap((group) => group.entries.map((entry, index) => ({
      key: getEntryKey(group.label, index),
      groupLabel: group.label,
      entry,
    }))),
    [groups],
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

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth="clamp(340px, 94vw, min(900px, var(--lumiverse-content-max-width, 900px)))" zIndex={10001} className={styles.modal}>
          <div className={styles.header}>
            <h2 className={styles.title}>Prompt Breakdown</h2>
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

          <div className={styles.body}>
            {loading && <div className={styles.loading}>Loading breakdown...</div>}
            {!loading && !data && <div className={styles.empty}>No breakdown data available for this message.</div>}
            {!loading && data && rawView === 'off' && (
              <>
                <StackedBar groups={mainGroups} total={data.totalTokens} />
                <Legend groups={mainGroups} />
                {mainGroups.map((group) => (
                  <GroupAccordion
                    key={group.label}
                    group={group}
                    total={data.totalTokens}
                    open={openGroups.has(group.label)}
                    onToggle={() => toggleGroup(group.label)}
                    selectedEntryKey={selectedEntryKey}
                    onSelectEntry={setSelectedEntryKey}
                  />
                ))}
                {sidecarGroup && sidecarGroup.tokens > 0 && (
                  <>
                    <div className={styles.sidecarDivider}>
                      <span>Sidecar (separate LLM calls)</span>
                    </div>
                    <GroupAccordion
                      group={sidecarGroup}
                      total={sidecarGroup.tokens}
                      open={openGroups.has(sidecarGroup.label)}
                      onToggle={() => toggleGroup(sidecarGroup.label)}
                      selectedEntryKey={selectedEntryKey}
                      onSelectEntry={setSelectedEntryKey}
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
                          <span className={styles.headerBadge}>{selectedEntry.entry.tokens.toLocaleString()} tokens</span>
                          <span className={styles.headerBadge}>{selectedEntry.entry.type}</span>
                          {selectedEntry.entry.role && (
                            <span className={clsx(styles.tokenRole, ROLE_CLASS[selectedEntry.entry.role])}>
                              {selectedEntry.entry.role}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {selectedEntry.entry.content ? (
                      <pre className={styles.entryInspectorContent}>{selectedEntry.entry.content}</pre>
                    ) : (
                      <div className={styles.entryInspectorEmpty}>
                        This stored breakdown only has token counts for this block. Newly generated messages now preserve the block text for inspection here.
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {!loading && data && rawView !== 'off' && (
              <>
                <div className={styles.rawCaveat}>
                  Re-assembled from current state. May differ from the original send — chat
                  variables, world-info state, preset, persona, and character edits can drift
                  between then and now.
                </div>
                {rawLoading && <div className={styles.loading}>Reassembling prompt…</div>}
                {!rawLoading && rawError && <div className={styles.empty}>{rawError}</div>}
                {!rawLoading && !rawError && rawData && (
                  <pre className={styles.rawView}>{rawText}</pre>
                )}
              </>
            )}
          </div>

          {data && (
            <div className={styles.footer}>
              <span className={styles.footerTotal}>{data.totalTokens.toLocaleString()} tokens</span>
              {data.maxContext > 0 && (
                <span className={styles.footerMax}>
                  / {data.maxContext.toLocaleString()} ({((data.totalTokens / data.maxContext) * 100).toFixed(1)}%)
                </span>
              )}
              {sidecarGroup && sidecarGroup.tokens > 0 && (
                <span className={styles.footerMax} style={{ marginLeft: 6, color: '#e05daa' }}>
                  + {sidecarGroup.tokens.toLocaleString()} sidecar
                </span>
              )}
              <div className={styles.footerSpacer} />
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
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
    </ModalShell>
  )
}

function StackedBar({ groups, total }: { groups: BreakdownGroup[]; total: number }) {
  if (total === 0) return null
  return (
    <div className={styles.stackedBar}>
      {groups.map((g) => {
        const pct = (g.tokens / total) * 100
        if (pct < 0.5) return null
        return (
          <div
            key={g.label}
            className={styles.stackedBarSegment}
            style={{ width: `${pct}%`, background: g.color }}
            title={`${g.label}: ${g.tokens.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
          />
        )
      })}
    </div>
  )
}

function Legend({ groups }: { groups: BreakdownGroup[] }) {
  return (
    <div className={styles.legend}>
      {groups.map((g) => (
        <div key={g.label} className={styles.legendItem}>
          <div className={styles.legendDot} style={{ background: g.color }} />
          <span>{g.label}</span>
          <span className={styles.legendTokens}>{g.tokens.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

function GroupAccordion({ group, total, open, onToggle, selectedEntryKey, onSelectEntry }: {
  group: BreakdownGroup
  total: number
  open: boolean
  onToggle: () => void
  selectedEntryKey?: string | null
  onSelectEntry?: (key: string) => void
}) {
  return (
    <div className={styles.accordion}>
      <button type="button" className={styles.accordionHeader} onClick={onToggle}>
        <div className={styles.accordionDot} style={{ background: group.color }} />
        <span>{group.label}</span>
        <span className={styles.accordionTokens}>{group.tokens.toLocaleString()} tokens</span>
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
              const entryKey = getEntryKey(group.label, i)

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
