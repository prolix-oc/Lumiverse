import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Clock, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
import { Marked } from 'marked'
import { useStore } from '@/store'
import type { CouncilToolResult } from 'lumiverse-spindle-types'
import { Spinner } from '@/components/shared/Spinner'
import { copyTextToClipboard } from '@/lib/clipboard'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import styles from './CouncilFeedback.module.css'

// Minimal markdown renderer for council tool output — no fenced-code chrome,
// no custom emphasis classes, just basic GFM.
const minimalMarked = new Marked({ gfm: true, breaks: true })

function renderMinimalMarkdown(text: string): string {
  const html = minimalMarked.parse(text, { async: false }) as string
  return sanitizeRichHtml(html)
}

export default function CouncilFeedback() {
  const { t } = useTranslation('panels')
  const councilExecuting = useStore((s) => s.councilExecuting)
  const councilEnabled = useStore((s) => s.councilSettings.councilMode)
  const councilToolResults = useStore((s) => s.councilToolResults)
  const councilExecutionResult = useStore((s) => s.councilExecutionResult)

  const hasResults = councilToolResults.length > 0

  // Group results by member
  const byMember = new Map<string, CouncilToolResult[]>()
  for (const r of councilToolResults) {
    const existing = byMember.get(r.memberName) || []
    existing.push(r)
    byMember.set(r.memberName, existing)
  }

  return (
    <div className={styles.container}>
      {/* Status Bar */}
      <div className={styles.statusBar}>
        {councilExecuting ? (
          <div className={styles.statusRunning}>
            <Spinner size={14} />
            <span>{t('councilFeedback.executing')}</span>
          </div>
        ) : hasResults ? (
          <div className={styles.statusComplete}>
            <CheckCircle2 size={14} />
            <span>
              {t('councilFeedback.complete', { count: councilToolResults.length })}
            </span>
            {councilExecutionResult && (
              <span className={styles.duration}>
                <Clock size={11} /> {(councilExecutionResult.totalDurationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        ) : (
          <div className={styles.statusIdle}>{councilEnabled ? t('councilFeedback.ready', { defaultValue: 'Council enabled — waiting for tool feedback' }) : t('councilFeedback.noResultsYet')}</div>
        )}
      </div>

      {/* Results by member */}
      {Array.from(byMember.entries()).map(([memberName, results]) => (
        <MemberSection key={memberName} memberName={memberName} results={results} />
      ))}

      {/* Empty state */}
      {!hasResults && !councilExecuting && (
        <div className={styles.emptyState}>
          {t('councilFeedback.emptyHint')}
        </div>
      )}
    </div>
  )
}

function MemberSection({
  memberName,
  results,
}: {
  memberName: string
  results: CouncilToolResult[]
}) {
  const { t } = useTranslation('panels')
  return (
    <div className={styles.memberSection}>
      <div className={styles.memberHeader}>
        <span className={styles.memberName}>{memberName}</span>
        <span className={styles.memberResultCount}>{t('councilFeedback.toolCount', { count: results.length })}</span>
      </div>
      {results.map((r, i) => (
        <ToolResultCard key={`${r.toolName}-${i}`} result={r} />
      ))}
    </div>
  )
}

function ToolResultCard({ result }: { result: CouncilToolResult }) {
  const { t } = useTranslation('panels')
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const html = useMemo(
    () => (result.success ? renderMinimalMarkdown(result.content) : ''),
    [result.success, result.content],
  )

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    copyTextToClipboard(result.success ? result.content : (result.error || '')).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={styles.resultCard}>
      <button type="button" className={styles.resultHeader} onClick={() => setExpanded(!expanded)}>
        <span className={styles.resultIcon}>
          {result.success ? (
            <CheckCircle2 size={12} className={styles.successIcon} />
          ) : (
            <XCircle size={12} className={styles.failIcon} />
          )}
        </span>
        <span className={styles.resultToolName}>{result.toolDisplayName}</span>
        <span className={styles.resultDuration}>{(result.durationMs / 1000).toFixed(1)}s</span>
        <span
          role="button"
          tabIndex={0}
          className={styles.copyBtn}
          onClick={handleCopy}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCopy(e as unknown as React.MouseEvent) } }}
          title={t('councilFeedback.copyOutput')}
          aria-label={t('councilFeedback.copyOutput')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className={styles.resultContent}>
          {result.success ? (
            <div className={styles.resultText} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <div className={styles.resultError}>{result.error || t('councilFeedback.unknownError')}</div>
          )}
        </div>
      )}
    </div>
  )
}
