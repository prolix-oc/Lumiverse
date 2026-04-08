import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Copy, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { ApiError, RequestTimeoutError } from '@/api/client'
import { memoryCortexApi, type CortexHealthCheck, type CortexHealthReport, type CortexProbeStatus } from '@/api/memory-cortex'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import styles from './MemoryCortexDiagnosticsModal.module.css'

function formatCheckLabel(status: CortexHealthCheck['status']) {
  switch (status) {
    case 'pass':
      return 'Pass'
    case 'warn':
      return 'Warn'
    case 'fail':
      return 'Fail'
    default:
      return 'Info'
  }
}

interface DiagnosticsErrorState {
  summary: string
  details: string[]
}

function formatProbeDuration(durationMs?: number | null): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null
  return `${Math.max(0, Math.round(durationMs))}ms`
}

function formatProbeSummary(probe: CortexProbeStatus, fallback = 'Not run'): string {
  if (!probe.attempted) return fallback
  const parts = [probe.message]
  const duration = formatProbeDuration(probe.durationMs)
  if (duration) parts.push(duration)
  if (probe.timedOut) parts.push('timed out')
  return parts.join(' | ')
}

function stringifyBody(body: unknown): string | null {
  if (!body) return null
  if (typeof body === 'string') return body
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body)
    } catch {
      return null
    }
  }
  return String(body)
}

function describeDiagnosticsError(error: unknown, chatId?: string | null): DiagnosticsErrorState {
  if (error instanceof RequestTimeoutError) {
    return {
      summary: 'Diagnostics request timed out before the server finished the live health checks.',
      details: [
        `Request: ${error.url}`,
        `Timeout: ${error.timeoutMs}ms`,
        chatId ? `Chat: ${chatId}` : 'Chat: none',
        'The backend health endpoint was still waiting on one or more live provider probes.',
      ],
    }
  }

  if (error instanceof ApiError) {
    const bodyText = stringifyBody(error.body)
    const bodyError = typeof error.body?.error === 'string' ? error.body.error : null
    return {
      summary: bodyError || 'Memory Cortex diagnostics request failed.',
      details: [
        `HTTP: ${error.status} ${error.statusText}`,
        chatId ? `Chat: ${chatId}` : 'Chat: none',
        ...(bodyText && bodyText !== bodyError ? [`Body: ${bodyText}`] : []),
      ],
    }
  }

  if (error instanceof Error) {
    return {
      summary: error.message || 'Failed to load Memory Cortex diagnostics.',
      details: [
        `Error type: ${error.name || 'Error'}`,
        chatId ? `Chat: ${chatId}` : 'Chat: none',
      ],
    }
  }

  return {
    summary: 'Failed to load Memory Cortex diagnostics.',
    details: [chatId ? `Chat: ${chatId}` : 'Chat: none'],
  }
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    const successful = document.execCommand('copy')
    if (!successful) {
      throw new Error('Copy command failed.')
    }
  } finally {
    document.body.removeChild(textarea)
  }
}

function buildReportText(report: CortexHealthReport): string {
  const lines: string[] = []

  lines.push('Memory Cortex Diagnostics')
  lines.push(`Generated: ${new Date(report.generatedAt).toLocaleString()}`)
  lines.push(`Overall: ${report.healthy ? 'Healthy' : 'Needs attention'}`)
  lines.push('')

  lines.push('Summary')
  lines.push(`- Failures: ${report.summary.failures}`)
  lines.push(`- Warnings: ${report.summary.warnings}`)
  lines.push(`- Passes: ${report.summary.passes}`)
  lines.push(`- Info: ${report.summary.info}`)
  lines.push('')

  lines.push('Checks')
  for (const check of report.checks) {
    lines.push(`- [${formatCheckLabel(check.status)}] ${check.label}: ${check.message}`)
  }
  lines.push('')

  lines.push('Config')
  lines.push(`- Enabled: ${report.config.enabled ? 'Yes' : 'No'}`)
  lines.push(`- Preset: ${report.config.presetMode ?? 'manual'}`)
  lines.push(`- Entity extraction: ${report.config.entityExtractionMode}`)
  lines.push(`- Salience scoring: ${report.config.salienceScoringMode}`)
  lines.push(`- Formatter: ${report.config.formatterMode}`)
  lines.push('')

  lines.push('Embeddings')
  lines.push(`- Enabled: ${report.embeddings.enabled ? 'Yes' : 'No'}`)
  lines.push(`- API key: ${report.embeddings.hasApiKey ? 'Present' : 'Missing'}`)
  lines.push(`- Vectorize chat messages: ${report.embeddings.vectorizeChatMessages ? 'Yes' : 'No'}`)
  lines.push(`- Provider/model: ${report.embeddings.provider || 'N/A'} / ${report.embeddings.model || 'N/A'}`)
  lines.push(`- Dimensions: ${report.embeddings.dimensions ?? 'Unknown'}`)
  lines.push(`- Connectivity: ${formatProbeSummary(report.embeddings.connectivity, 'Not run')}`)
  if (report.embeddings.connectivity.error && report.embeddings.connectivity.error !== report.embeddings.connectivity.message) {
    lines.push(`- Probe error: ${report.embeddings.connectivity.error}`)
  }
  lines.push('')

  lines.push('Sidecar')
  lines.push(`- Required: ${report.sidecar.required ? 'Yes' : 'No'}`)
  lines.push(`- Configured: ${report.sidecar.configured ? 'Yes' : 'No'}`)
  lines.push(`- Connection: ${report.sidecar.connectionName ?? 'None'}`)
  lines.push(`- Provider/model: ${report.sidecar.provider ?? 'N/A'} / ${report.sidecar.model ?? 'Default'}`)
  lines.push(`- API key: ${report.sidecar.hasApiKey ? 'Ready' : 'Missing or not required'}`)
  lines.push(`- Connectivity: ${formatProbeSummary(report.sidecar.connectivity, 'Not run')}`)
  if (report.sidecar.connectivity.error && report.sidecar.connectivity.error !== report.sidecar.connectivity.message) {
    lines.push(`- Probe error: ${report.sidecar.connectivity.error}`)
  }
  lines.push('')

  lines.push('Chat')
  if (!report.chat) {
    lines.push('- No chat selected')
  } else if (!report.chat.exists) {
    lines.push(`- Requested chat was not found: ${report.chat.id}`)
  } else {
    lines.push(`- Chat: ${report.chat.name ?? report.chat.id}`)
    lines.push(`- Messages: ${report.chat.messageCount}`)
    lines.push(`- Chunks: ${report.chat.chunkCount}`)
    lines.push(`- Vectorized chunks: ${report.chat.vectorizedChunkCount}`)
    lines.push(`- Pending chunks: ${report.chat.pendingChunkCount}`)
    lines.push(`- Entities: ${report.chat.entityCount} (${report.chat.activeEntityCount} active)`)
    lines.push(`- Relations: ${report.chat.relationCount}`)
    lines.push(`- Consolidations: ${report.chat.consolidationCount}`)
    lines.push(`- Rebuild status: ${report.chat.rebuildStatus.status}`)
  }

  return lines.join('\n')
}

function StatusBadge({ status }: { status: CortexHealthCheck['status'] }) {
  return (
    <span
      className={clsx(
        styles.statusBadge,
        status === 'pass' && styles.statusPass,
        status === 'warn' && styles.statusWarn,
        status === 'fail' && styles.statusFail,
        status === 'info' && styles.statusInfo,
      )}
    >
      {formatCheckLabel(status)}
    </span>
  )
}

interface Props {
  chatId?: string | null
  onClose: () => void
}

export default function MemoryCortexDiagnosticsModal({ chatId, onClose }: Props) {
  const [report, setReport] = useState<CortexHealthReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<DiagnosticsErrorState | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  const loadReport = useCallback(async () => {
    setLoading(true)
    setError(null)
    setReport((current) => ((current?.chat?.id ?? null) === (chatId ?? null) ? current : null))
    try {
      const nextReport = await memoryCortexApi.getHealth({
        chatId: chatId || undefined,
        probeConnectivity: true,
      })
      setReport(nextReport)
    } catch (err: unknown) {
      setError(describeDiagnosticsError(err, chatId))
    } finally {
      setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    void loadReport()
  }, [loadReport])

  const handleCopy = useCallback(async () => {
    if (!report) return

    try {
      await copyTextToClipboard(buildReportText(report))
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }

    window.setTimeout(() => setCopyState('idle'), 2000)
  }, [report])

  const overallTone = useMemo(() => {
    if (!report) return 'info'
    if (report.summary.failures > 0) return 'fail'
    if (report.summary.warnings > 0) return 'warn'
    return 'pass'
  }, [report])

  const waitingForInitialReport = loading && !report

  return (
    <ModalShell
      isOpen={true}
      onClose={onClose}
      maxWidth={1100}
      maxHeight="88vh"
      className={styles.modal}
    >
      <div className={styles.shell}>
        <div className={styles.header}>
          <div className={styles.titleWrap}>
            <div className={styles.eyebrow}>Popup Diagnostics</div>
            <h2 className={styles.title}>Memory Cortex Diagnostics</h2>
            <p className={styles.subtitle}>
              Focused health checks for cortex setup, embeddings, sidecar readiness, and the selected chat.
              {chatId ? ` Chat: ${chatId}` : ' Open this from an active chat for chat-specific checks.'}
            </p>
          </div>

          <div className={styles.headerActions}>
            <div className={styles.actions}>
              <button type="button" className={styles.actionBtn} onClick={() => void loadReport()} disabled={loading}>
                <RefreshCw size={15} className={loading ? styles.spinning : undefined} />
                Refresh
              </button>
              <button
                type="button"
                className={clsx(
                  styles.actionBtn,
                  copyState === 'copied' && styles.actionBtnDone,
                  copyState === 'error' && styles.actionBtnError,
                )}
                onClick={() => void handleCopy()}
                disabled={!report}
              >
                <Copy size={15} />
                {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy Report'}
              </button>
            </div>
            <CloseButton onClick={onClose} />
          </div>
        </div>

        <div className={styles.body}>
          {error && (
            <div className={styles.errorState}>
              <AlertTriangle size={18} />
              <div className={styles.errorCopy}>
                <div className={styles.errorTitle}>{error.summary}</div>
                {error.details.length > 0 && (
                  <div className={styles.errorDetails}>
                    {error.details.map((detail) => (
                      <div key={detail}>{detail}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && !report ? null : (
            <>
              <div
                className={clsx(
                  styles.overview,
                  overallTone === 'pass' && styles.overviewPass,
                  overallTone === 'warn' && styles.overviewWarn,
                  overallTone === 'fail' && styles.overviewFail,
                  overallTone === 'info' && styles.overviewInfo,
                )}
              >
                <div className={styles.overviewHeader}>
                  <div className={styles.overviewTitleWrap}>
                    {overallTone === 'pass' ? <CheckCircle2 size={18} /> : overallTone === 'fail' ? <AlertTriangle size={18} /> : <Activity size={18} />}
                    <div>
                      <div className={styles.overviewTitle}>
                        {!report ? 'Loading health report...' : report.healthy ? 'Memory Cortex looks healthy' : 'Memory Cortex needs attention'}
                      </div>
                      <div className={styles.overviewMeta}>
                        {report ? `Generated ${new Date(report.generatedAt).toLocaleString()}` : 'Running live health checks'}
                      </div>
                    </div>
                  </div>
                  {report && (
                    <div className={styles.summaryGrid}>
                      <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{report.summary.failures}</span>
                        <span className={styles.summaryLabel}>Failures</span>
                      </div>
                      <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{report.summary.warnings}</span>
                        <span className={styles.summaryLabel}>Warnings</span>
                      </div>
                      <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{report.summary.passes}</span>
                        <span className={styles.summaryLabel}>Passes</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.section}>
                <div className={styles.sectionHeader}>Checks</div>
                {waitingForInitialReport ? (
                  <div className={styles.loadingRow}>Running diagnostics...</div>
                ) : (
                  <div className={styles.checkListWrap}>
                    <div className={styles.checkList}>
                      {report?.checks.map((check) => (
                        <div key={check.key} className={styles.checkRow}>
                          <div className={styles.checkTop}>
                            <div className={styles.checkLabel}>{check.label}</div>
                            <StatusBadge status={check.status} />
                          </div>
                          <div className={styles.checkMessage}>{check.message}</div>
                        </div>
                      ))}
                      <div className={styles.scrollSpacer} aria-hidden="true" />
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.detailGrid}>
                <div className={styles.section}>
                  <div className={styles.sectionHeader}>Embeddings</div>
                  {!report ? (
                    <div className={styles.loadingRow}>Waiting for diagnostics report...</div>
                  ) : (
                    <div className={styles.metaList}>
                      <div className={styles.metaRow}><span>Enabled</span><strong>{report.embeddings.enabled ? 'Yes' : 'No'}</strong></div>
                      <div className={styles.metaRow}><span>API key</span><strong>{report.embeddings.hasApiKey ? 'Present' : 'Missing'}</strong></div>
                      <div className={styles.metaRow}><span>Vectorize chat messages</span><strong>{report.embeddings.vectorizeChatMessages ? 'Yes' : 'No'}</strong></div>
                      <div className={styles.metaRow}><span>Provider</span><strong>{report.embeddings.provider || 'N/A'}</strong></div>
                      <div className={styles.metaRow}><span>Model</span><strong>{report.embeddings.model || 'N/A'}</strong></div>
                      <div className={styles.metaRow}><span>Dimensions</span><strong>{report.embeddings.dimensions ?? 'Unknown'}</strong></div>
                      <div className={styles.metaRow}><span>Live probe</span><strong>{formatProbeSummary(report.embeddings.connectivity, 'Not run')}</strong></div>
                      {report.embeddings.connectivity.error && report.embeddings.connectivity.error !== report.embeddings.connectivity.message && (
                        <div className={styles.metaRow}><span>Probe error</span><strong>{report.embeddings.connectivity.error}</strong></div>
                      )}
                    </div>
                  )}
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionHeader}>Sidecar</div>
                  {!report ? (
                    <div className={styles.loadingRow}>Waiting for diagnostics report...</div>
                  ) : (
                    <div className={styles.metaList}>
                      <div className={styles.metaRow}><span>Required</span><strong>{report.sidecar.required ? 'Yes' : 'No'}</strong></div>
                      <div className={styles.metaRow}><span>Configured</span><strong>{report.sidecar.configured ? 'Yes' : 'No'}</strong></div>
                      <div className={styles.metaRow}><span>Connection</span><strong>{report.sidecar.connectionName ?? 'None'}</strong></div>
                      <div className={styles.metaRow}><span>Provider</span><strong>{report.sidecar.provider ?? 'N/A'}</strong></div>
                      <div className={styles.metaRow}><span>Model</span><strong>{report.sidecar.model ?? 'Default'}</strong></div>
                      <div className={styles.metaRow}><span>API key</span><strong>{report.sidecar.hasApiKey ? 'Ready' : 'Missing / not required'}</strong></div>
                      <div className={styles.metaRow}><span>Live probe</span><strong>{formatProbeSummary(report.sidecar.connectivity, 'Not run')}</strong></div>
                      {report.sidecar.connectivity.error && report.sidecar.connectivity.error !== report.sidecar.connectivity.message && (
                        <div className={styles.metaRow}><span>Probe error</span><strong>{report.sidecar.connectivity.error}</strong></div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.section}>
                <div className={styles.sectionHeader}>Selected Chat</div>
                {!report ? (
                  <div className={styles.loadingRow}>Waiting for diagnostics report...</div>
                ) : !report.chat ? (
                  <div className={styles.emptyRow}>No chat was selected when this popup was opened.</div>
                ) : !report.chat.exists ? (
                  <div className={styles.emptyRow}>The requested chat could not be found.</div>
                ) : (
                  <div className={styles.selectedChatWrap}>
                    <div className={styles.metaList}>
                      <div className={styles.metaRow}><span>Name</span><strong>{report.chat.name ?? report.chat.id}</strong></div>
                      <div className={styles.metaRow}><span>Messages</span><strong>{report.chat.messageCount}</strong></div>
                      <div className={styles.metaRow}><span>Chunks</span><strong>{report.chat.chunkCount}</strong></div>
                      <div className={styles.metaRow}><span>Vectorized chunks</span><strong>{report.chat.vectorizedChunkCount}</strong></div>
                      <div className={styles.metaRow}><span>Pending chunks</span><strong>{report.chat.pendingChunkCount}</strong></div>
                      <div className={styles.metaRow}><span>Entities</span><strong>{report.chat.entityCount} ({report.chat.activeEntityCount} active)</strong></div>
                      <div className={styles.metaRow}><span>Relations</span><strong>{report.chat.relationCount}</strong></div>
                      <div className={styles.metaRow}><span>Consolidations</span><strong>{report.chat.consolidationCount}</strong></div>
                      <div className={styles.metaRow}><span>Rebuild status</span><strong>{report.chat.rebuildStatus.status}</strong></div>
                      <div className={styles.scrollSpacer} aria-hidden="true" />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
