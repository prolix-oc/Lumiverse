import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, ChevronRight, Copy, Check, Code } from 'lucide-react'
import { useStore } from '@/store'
import { generateApi } from '@/api/generate'
import type { BreakdownCacheEntry } from '@/types/store'
import { groupBreakdownEntries, getBlockDisplayColor } from '@/lib/prompt-breakdown'
import type { BreakdownGroup } from '@/lib/prompt-breakdown'
import styles from './PromptItemizerModal.module.css'
import clsx from 'clsx'

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

  const messageId = modalProps?.messageId as string | undefined
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<BreakdownCacheEntry | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['lumiverse', 'chatHistory', 'longTermMemory']))
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)

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

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [closeModal])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) closeModal() },
    [closeModal],
  )

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      next.has(label) ? next.delete(label) : next.add(label)
      return next
    })
  }

  const handleCopy = () => {
    if (!data) return
    const text = data.entries.map((e) => `[${e.type}] ${e.name}: ${e.tokens} tokens`).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const groups = data ? groupBreakdownEntries(data.entries) : []
  const sidecarGroup = groups.find((g) => g.label === 'Sidecar (Lumi Pipeline)')
  const mainGroups = groups.filter((g) => g.label !== 'Sidecar (Lumi Pipeline)')

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={styles.backdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleBackdropClick}
      >
        <motion.div
          className={styles.modal}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => e.stopPropagation()}
        >
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
            <button type="button" className={styles.closeBtn} onClick={closeModal}>
              <X size={15} />
            </button>
          </div>

          <div className={styles.body}>
            {loading && <div className={styles.loading}>Loading breakdown...</div>}
            {!loading && !data && <div className={styles.empty}>No breakdown data available for this message.</div>}
            {!loading && data && !showRaw && (
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
                    />
                  </>
                )}
              </>
            )}
            {!loading && data && showRaw && (
              <div className={styles.rawView}>
                {JSON.stringify(data, null, 2)}
              </div>
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
              <button type="button" className={styles.footerBtn} onClick={() => setShowRaw(!showRaw)}>
                <Code size={12} /> {showRaw ? 'Visual' : 'Raw'}
              </button>
              <button type="button" className={styles.footerBtn} onClick={handleCopy}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
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

function GroupAccordion({ group, total, open, onToggle }: {
  group: BreakdownGroup
  total: number
  open: boolean
  onToggle: () => void
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
          <table className={styles.tokenTable}>
            <tbody>
              {group.entries.map((entry, i) => {
                const pct = total > 0 ? ((entry.tokens / total) * 100).toFixed(1) : '0.0'
                return (
                  <tr key={i}>
                    <td>
                      <div className={styles.tokenName}>
                        <div className={styles.tokenColor} style={{ background: getBlockDisplayColor(i) }} />
                        <span>{entry.name}</span>
                        {entry.role && (
                          <span className={clsx(styles.tokenRole, ROLE_CLASS[entry.role])}>
                            {entry.role}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={styles.tokenCount}>{entry.tokens.toLocaleString()}</td>
                    <td className={styles.tokenPct}>{pct}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
