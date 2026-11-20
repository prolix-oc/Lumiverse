import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { Activity, AlertTriangle, CheckCircle2, Copy, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { ApiError, RequestTimeoutError } from '@/api/client'
import { memoryCortexApi, type CortexHealthCheck, type CortexHealthReport, type CortexProbeStatus } from '@/api/memory-cortex'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { copyTextToClipboard } from '@/lib/clipboard'
import styles from './MemoryCortexDiagnosticsModal.module.css'

function formatCheckLabel(status: CortexHealthCheck['status']) {
  switch (status) {
    case 'pass':
      return i18n.t('memoryCortexDiagnostics.pass', { ns: 'modals' })
    case 'warn':
      return i18n.t('memoryCortexDiagnostics.warn', { ns: 'modals' })
    case 'fail':
      return i18n.t('memoryCortexDiagnostics.fail', { ns: 'modals' })
    default:
      return i18n.t('memoryCortexDiagnostics.info', { ns: 'modals' })
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

function formatProbeSummary(probe: CortexProbeStatus, fallback?: string): string {
  const notRun = fallback ?? i18n.t('memoryCortexDiagnostics.notRun', { ns: 'modals' })
  if (!probe.attempted) return notRun
  const parts = [probe.message]
  const duration = formatProbeDuration(probe.durationMs)
  if (duration) parts.push(duration)
  if (probe.timedOut) parts.push(i18n.t('memoryCortexDiagnostics.timedOut', { ns: 'modals' }))
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

const et = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`memoryCortexDiagnostics.errors.${key}`, { ns: 'modals', ...opts })

function describeDiagnosticsError(error: unknown, chatId?: string | null): DiagnosticsErrorState {
  const chatLine = chatId
    ? et('chatLine', { id: chatId })
    : et('chatNone')

  if (error instanceof RequestTimeoutError) {
    return {
      summary: i18n.t('memoryCortexDiagnostics.timeoutSummary', { ns: 'modals' }),
      details: [
        et('requestLine', { url: error.url }),
        et('timeoutLine', { ms: error.timeoutMs }),
        chatLine,
        et('backendWaiting'),
      ],
    }
  }

  if (error instanceof ApiError) {
    const bodyText = stringifyBody(error.body)
    const bodyError = typeof error.body?.error === 'string' ? error.body.error : null
    return {
      summary: bodyError || i18n.t('memoryCortexDiagnostics.requestFailed', { ns: 'modals' }),
      details: [
        et('httpLine', { status: error.status, statusText: error.statusText }),
        chatLine,
        ...(bodyText && bodyText !== bodyError ? [et('bodyLine', { body: bodyText })] : []),
      ],
    }
  }

  if (error instanceof Error) {
    return {
      summary: error.message || i18n.t('memoryCortexDiagnostics.loadFailed', { ns: 'modals' }),
      details: [
        et('errorType', { type: error.name || 'Error' }),
        chatLine,
      ],
    }
  }

  return {
    summary: i18n.t('memoryCortexDiagnostics.loadFailed', { ns: 'modals' }),
    details: [chatLine],
  }
}

function buildReportText(report: CortexHealthReport): string {
  const rt = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`memoryCortexDiagnostics.report.${key}`, { ns: 'modals', ...opts })
  const rv = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`memoryCortexDiagnostics.values.${key}`, { ns: 'modals', ...opts })
  const yesNo = (v: boolean) => rv(v ? 'yes' : 'no')
  const notRun = i18n.t('memoryCortexDiagnostics.notRun', { ns: 'modals' })

  const lines: string[] = []

  lines.push(rt('title'))
  lines.push(rt('generated', { date: new Date(report.generatedAt).toLocaleString() }))
  lines.push(report.healthy ? rt('overallHealthy') : rt('overallNeedsAttention'))
  lines.push('')

  lines.push(rt('summary'))
  lines.push(rt('failures', { count: report.summary.failures }))
  lines.push(rt('warnings', { count: report.summary.warnings }))
  lines.push(rt('passes', { count: report.summary.passes }))
  lines.push(rt('info', { count: report.summary.info }))
  lines.push('')

  lines.push(rt('checks'))
  for (const check of report.checks) {
    lines.push(rt('checkLine', { status: formatCheckLabel(check.status), label: check.label, message: check.message }))
  }
  lines.push('')

  lines.push(rt('config'))
  lines.push(rt('configEnabled', { value: yesNo(report.config.enabled) }))
  lines.push(rt('configPreset', { value: report.config.presetMode ?? rv('manual') }))
  lines.push(rt('configEntity', { value: report.config.entityExtractionMode }))
  lines.push(rt('configSalience', { value: report.config.salienceScoringMode }))
  lines.push(rt('configFormatter', { value: report.config.formatterMode }))
  lines.push('')

  lines.push(rt('embeddings'))
  lines.push(rt('embEnabled', { value: yesNo(report.embeddings.enabled) }))
  lines.push(rt('embApiKey', { value: report.embeddings.hasApiKey ? rv('present') : rv('missing') }))
  lines.push(rt('embVectorize', { value: yesNo(report.embeddings.vectorizeChatMessages) }))
  lines.push(rt('embProviderModel', { provider: report.embeddings.provider || rv('na'), model: report.embeddings.model || rv('na') }))
  lines.push(rt('embDimensions', { value: report.embeddings.dimensions ?? rv('unknown') }))
  lines.push(rt('embConnectivity', { value: formatProbeSummary(report.embeddings.connectivity, notRun) }))
  if (report.embeddings.connectivity.error && report.embeddings.connectivity.error !== report.embeddings.connectivity.message) {
    lines.push(rt('embProbeError', { error: report.embeddings.connectivity.error }))
  }
  lines.push('')

  lines.push(rt('sidecar'))
  lines.push(rt('sideRequired', { value: yesNo(report.sidecar.required) }))
  lines.push(rt('sideConfigured', { value: yesNo(report.sidecar.configured) }))
  lines.push(rt('sideConnection', { value: report.sidecar.connectionName ?? rv('none') }))
  lines.push(rt('sideProviderModel', { provider: report.sidecar.provider ?? rv('na'), model: report.sidecar.model ?? rv('default') }))
  lines.push(rt('sideApiKey', { value: report.sidecar.hasApiKey ? rv('ready') : rv('missingNotRequired') }))
  lines.push(rt('sideConnectivity', { value: formatProbeSummary(report.sidecar.connectivity, notRun) }))
  if (report.sidecar.connectivity.error && report.sidecar.connectivity.error !== report.sidecar.connectivity.message) {
    lines.push(rt('sideProbeError', { error: report.sidecar.connectivity.error }))
  }
  lines.push('')

  lines.push(rt('chat'))
  if (!report.chat) {
    lines.push(rt('chatNoneSelected'))
  } else if (!report.chat.exists) {
    lines.push(rt('chatNotFound', { id: report.chat.id }))
  } else {
    lines.push(rt('chatName', { name: report.chat.name ?? report.chat.id }))
    lines.push(rt('chatMessages', { count: report.chat.messageCount }))
    lines.push(rt('chatChunks', { count: report.chat.chunkCount }))
    lines.push(rt('chatVectorized', { count: report.chat.vectorizedChunkCount }))
    lines.push(rt('chatPending', { count: report.chat.pendingChunkCount }))
    lines.push(rt('chatEntities', { total: report.chat.entityCount, active: report.chat.activeEntityCount }))
    lines.push(rt('chatRelations', { count: report.chat.relationCount }))
    lines.push(rt('chatConsolidations', { count: report.chat.consolidationCount }))
    lines.push(rt('chatRebuild', { status: report.chat.rebuildStatus.status }))
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
  const { t } = useTranslation('modals', { keyPrefix: 'memoryCortexDiagnostics' })
  const yesNo = useCallback((v: boolean) => t(v ? 'values.yes' : 'values.no'), [t])
  const notRunLabel = t('notRun')

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
            <div className={styles.eyebrow}>{t('eyebrow')}</div>
            <h2 className={styles.title}>{t('title')}</h2>
            <p className={styles.subtitle}>
              {t('subtitle')}
              {chatId ? t('subtitleChat', { id: chatId }) : t('subtitleNoChat')}
            </p>
          </div>

          <div className={styles.headerActions}>
            <div className={styles.actions}>
              <button type="button" className={styles.actionBtn} onClick={() => void loadReport()} disabled={loading}>
                <RefreshCw size={15} className={loading ? styles.spinning : undefined} />
                {t('refresh')}
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
                {copyState === 'copied' ? t('copied') : copyState === 'error' ? t('copyFailed') : t('copyReport')}
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
                        {!report ? t('loadingReport') : report.healthy ? t('healthy') : t('needsAttention')}
                      </div>
                      <div className={styles.overviewMeta}>
                        {report ? t('generated', { date: new Date(report.generatedAt).toLocaleString() }) : t('runningChecks')}
                      </div>
                    </div>
                  </div>
                  {report && (
                    <div className={styles.summaryGrid}>
                      <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{report.summary.failures}</span>
                        <span className={styles.summaryLabel}>{t('failures')}</span>
                      </div>
                      <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{report.summary.warnings}</span>
                        <span className={styles.summaryLabel}>{t('warnings')}</span>
                      </div>
                      <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{report.summary.passes}</span>
                        <span className={styles.summaryLabel}>{t('passes')}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.section}>
                <div className={styles.sectionHeader}>{t('sectionChecks')}</div>
                {waitingForInitialReport ? (
                  <div className={styles.loadingRow}>{t('running')}</div>
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
                  <div className={styles.sectionHeader}>{t('sectionEmbeddings')}</div>
                  {!report ? (
                    <div className={styles.loadingRow}>{t('waitingReport')}</div>
                  ) : (
                    <div className={styles.metaList}>
                      <div className={styles.metaRow}><span>{t('fields.enabled')}</span><strong>{yesNo(report.embeddings.enabled)}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.apiKey')}</span><strong>{report.embeddings.hasApiKey ? t('values.present') : t('values.missing')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.vectorizeChatMessages')}</span><strong>{yesNo(report.embeddings.vectorizeChatMessages)}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.provider')}</span><strong>{report.embeddings.provider || t('values.na')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.model')}</span><strong>{report.embeddings.model || t('values.na')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.dimensions')}</span><strong>{report.embeddings.dimensions ?? t('values.unknown')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.liveProbe')}</span><strong>{formatProbeSummary(report.embeddings.connectivity, notRunLabel)}</strong></div>
                      {report.embeddings.connectivity.error && report.embeddings.connectivity.error !== report.embeddings.connectivity.message && (
                        <div className={styles.metaRow}><span>{t('fields.probeError')}</span><strong>{report.embeddings.connectivity.error}</strong></div>
                      )}
                    </div>
                  )}
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionHeader}>{t('sectionSidecar')}</div>
                  {!report ? (
                    <div className={styles.loadingRow}>{t('waitingReport')}</div>
                  ) : (
                    <div className={styles.metaList}>
                      <div className={styles.metaRow}><span>{t('fields.required')}</span><strong>{yesNo(report.sidecar.required)}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.configured')}</span><strong>{yesNo(report.sidecar.configured)}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.connection')}</span><strong>{report.sidecar.connectionName ?? t('values.none')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.provider')}</span><strong>{report.sidecar.provider ?? t('values.na')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.model')}</span><strong>{report.sidecar.model ?? t('values.default')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.apiKey')}</span><strong>{report.sidecar.hasApiKey ? t('values.ready') : t('values.missingNotRequired')}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.liveProbe')}</span><strong>{formatProbeSummary(report.sidecar.connectivity, notRunLabel)}</strong></div>
                      {report.sidecar.connectivity.error && report.sidecar.connectivity.error !== report.sidecar.connectivity.message && (
                        <div className={styles.metaRow}><span>{t('fields.probeError')}</span><strong>{report.sidecar.connectivity.error}</strong></div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.section}>
                <div className={styles.sectionHeader}>{t('sectionChat')}</div>
                {!report ? (
                  <div className={styles.loadingRow}>{t('waitingReport')}</div>
                ) : !report.chat ? (
                  <div className={styles.emptyRow}>{t('noChatSelected')}</div>
                ) : !report.chat.exists ? (
                  <div className={styles.emptyRow}>{t('chatNotFound')}</div>
                ) : (
                  <div className={styles.selectedChatWrap}>
                    <div className={styles.metaList}>
                      <div className={styles.metaRow}><span>{t('fields.name')}</span><strong>{report.chat.name ?? report.chat.id}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.messages')}</span><strong>{report.chat.messageCount}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.chunks')}</span><strong>{report.chat.chunkCount}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.vectorizedChunks')}</span><strong>{report.chat.vectorizedChunkCount}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.pendingChunks')}</span><strong>{report.chat.pendingChunkCount}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.entities')}</span><strong>{report.chat.entityCount} ({t('values.activeCount', { count: report.chat.activeEntityCount })})</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.relations')}</span><strong>{report.chat.relationCount}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.consolidations')}</span><strong>{report.chat.consolidationCount}</strong></div>
                      <div className={styles.metaRow}><span>{t('fields.rebuildStatus')}</span><strong>{report.chat.rebuildStatus.status}</strong></div>
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
