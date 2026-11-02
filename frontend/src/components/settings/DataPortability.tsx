import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload, X, KeyRound, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { refreshAppDataAfterImport } from '@/hooks/useAppInit'
import { flushSettingsNow } from '@/store/slices/settings'
import { useStore } from '@/store'
import { pendingImportJob, trackImportJob } from '@/lib/import-recovery'
import {
  userDataApi,
  type DecryptionTicket,
  type ImportJobStatus,
  type ImportJobProgress,
  type TicketSubmissionResponse,
} from '@/api/user-data'
import styles from './DataPortability.module.css'

interface ExportProgress {
  phase: string
  table?: string
  processed?: number
  total?: number
}

interface ImportProgress extends ImportJobProgress {
  jobId: string
}

type ImportSummary = ImportJobStatus['summary']
type FileSummary = ImportJobStatus['fileSummary']

export default function DataPortability() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  // ── Export state ──────────────────────────────────────────────────────
  const [includeVectors, setIncludeVectors] = useState(true)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [includeExtensionData, setIncludeExtensionData] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportWarnings, setExportWarnings] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const downloadAnchorRef = useRef<HTMLAnchorElement | null>(null)

  // ── Import state ──────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(() => {
    const userId = useStore.getState().user?.id
    return Boolean(userId && pendingImportJob(userId))
  })
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [importUploadPct, setImportUploadPct] = useState<number | null>(null)
  const [importJobId, setImportJobId] = useState<string | null>(() => {
    const userId = useStore.getState().user?.id
    return userId ? pendingImportJob(userId) : null
  })
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [importFileSummary, setImportFileSummary] = useState<FileSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [interruptedJobId, setInterruptedJobId] = useState<string | null>(null)
  const importRequestStarted = useRef(false)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  // Secret-ticket UX state
  const [awaitingTicket, setAwaitingTicket] = useState<{
    jobId: string
    secretsCount: number
  } | null>(null)
  const [ticketSubmitting, setTicketSubmitting] = useState(false)
  const [ticketReuseWarning, setTicketReuseWarning] = useState<TicketSubmissionResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const userId = useStore.getState().user?.id
    if (!userId) return
    void userDataApi.getImportJobs().then(({ jobs }) => {
      if (cancelled || importRequestStarted.current || !jobs.length) return
      const job = jobs[0]
      trackImportJob(userId, job.jobId)
      setImportJobId(job.jobId)
      setImporting(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // ── WebSocket wiring ──────────────────────────────────────────────────
  useEffect(() => {
    const unsubs: Array<() => void> = []
    unsubs.push(
      wsClient.on(EventType.USER_EXPORT_PROGRESS, (payload: ExportProgress) => {
        setExportProgress(payload)
        if (payload.phase === 'complete') {
          // Clear shortly after — the browser is finishing the download stream.
          setTimeout(() => {
            setExportProgress(null)
            setExporting(false)
          }, 1200)
        }
      }),
    )
    unsubs.push(
      wsClient.on(EventType.USER_IMPORT_PROGRESS, (payload: ImportProgress & { secretsCount?: number }) => {
        setImportProgress(payload)
        if (payload.phase === 'awaiting_ticket') {
          setAwaitingTicket({
            jobId: payload.jobId || '',
            secretsCount: payload.secretsCount ?? 0,
          })
        }
        if (payload.phase === 'ticket_accepted' || payload.phase === 'ticket_skipped') {
          setAwaitingTicket(null)
        }
      }),
    )
    unsubs.push(
      wsClient.on(
        EventType.USER_IMPORT_COMPLETE,
        (payload: { jobId: string; summary: ImportSummary; fileSummary: FileSummary }) => {
          setImportSummary(payload.summary)
          setImportFileSummary(payload.fileSummary)
          setImporting(false)
          setImportProgress(null)
          setAwaitingTicket(null)
          setImportSuccess(t('dataPortability.importComplete'))
          void refreshAppDataAfterImport(payload.jobId)
            .catch((error) => setImportError(error.message))
        },
      ),
    )
    unsubs.push(
      wsClient.on(
        EventType.USER_IMPORT_FAILED,
        (payload: { error?: string; cancelled?: boolean }) => {
          setImporting(false)
          setImportProgress(null)
          setAwaitingTicket(null)
          if (payload.cancelled) {
            setImportError(t('dataPortability.importCancelled'))
          } else {
            setImportError(payload.error || t('dataPortability.importFailed'))
          }
        },
      ),
    )
    return () => {
      for (const u of unsubs) u()
    }
  }, [t])

  // File pickers/backgrounding can interrupt Android's WebSocket. Continue
  // polling until a terminal state, including while waiting for a ticket.
  useEffect(() => {
    if (!importing || !importJobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const status = await userDataApi.getImportStatus(importJobId)
        if (cancelled) return
        if (status.progress) setImportProgress({ ...status.progress, jobId: status.jobId })
        if (status.status === 'interrupted') {
          setInterruptedJobId(status.jobId)
          setImporting(false)
          setAwaitingTicket(null)
          setImportError(t('dataPortability.importInterrupted'))
          return
        }
        if (status.status === 'complete') {
          setImportSummary(status.summary)
          setImportFileSummary(status.fileSummary)
          setImporting(false)
          setImportProgress(null)
          setAwaitingTicket(null)
          setImportSuccess(t('dataPortability.importComplete'))
          void refreshAppDataAfterImport(status.jobId)
            .catch((error) => { if (!cancelled) setImportError(error.message) })
          return
        }
        if (status.status === 'failed' || status.status === 'cancelled') {
          setImporting(false)
          setImportProgress(null)
          setAwaitingTicket(null)
          setImportError(status.error || t(status.status === 'cancelled' ? 'dataPortability.importCancelled' : 'dataPortability.importFailed'))
          return
        }
        if (status.status === 'awaiting_ticket') {
          setAwaitingTicket({ jobId: status.jobId, secretsCount: status.manifest?.secretsCount ?? 0 })
        } else {
          setAwaitingTicket(null)
        }
      } catch { /* Reconnect on the next poll. */ }
      if (!cancelled) timer = setTimeout(poll, 1000)
    }
    timer = setTimeout(poll, 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [importing, importJobId, t])

  // ── Export action ─────────────────────────────────────────────────────
  const handleExport = async () => {
    setExportError(null)
    setExportWarnings([])
    setExporting(true)
    setExportProgress({ phase: 'start' })
    const a = downloadAnchorRef.current
    if (!a) {
      setExportError(t('dataPortability.exportAnchorMissing'))
      setExporting(false)
      return
    }

    if (!includeSecrets) {
      // Single-step path: browser handles a streaming GET as a native download.
      a.href = userDataApi.exportUrl(includeVectors, includeExtensionData)
      a.click()
      return
    }

    // Two-step path: prepare → fetch ticket + URL → trigger ticket save → kick the archive download.
    try {
      const resp = await userDataApi.prepareSecretsExport(includeVectors, includeExtensionData)
      if (resp.unreachableSecrets?.length) {
        setExportWarnings(resp.unreachableSecrets)
      }
      // Save the ticket as a downloadable file via a Blob URL.
      if (resp.ticket && resp.ticketFilename) {
        const ticketBlob = new Blob([JSON.stringify(resp.ticket, null, 2)], {
          type: 'application/json',
        })
        const ticketUrl = URL.createObjectURL(ticketBlob)
        a.href = ticketUrl
        a.download = resp.ticketFilename
        a.click()
        // Revoke after the browser has had a chance to start the download.
        setTimeout(() => URL.revokeObjectURL(ticketUrl), 5000)
      }
      // Brief delay before kicking the archive download so the ticket save
      // dialog (on browsers that show one) doesn't get swallowed.
      await new Promise((r) => setTimeout(r, 600))
      a.removeAttribute('download')
      a.href = resp.archiveUrl
      a.click()
    } catch (err: any) {
      setExportError(err?.body?.error || err?.message || t('dataPortability.exportPrepareFailed'))
      setExporting(false)
    }
  }

  // ── Import action ─────────────────────────────────────────────────────
  const handleImport = async () => {
    if (!file) return
    importRequestStarted.current = true
    setInterruptedJobId(null)
    setImportError(null)
    setImportSuccess(null)
    setImportSummary(null)
    setImportFileSummary(null)
    setImportProgress(null)
    setImportUploadPct(0)
    setImportJobId(null)
    setAwaitingTicket(null)
    setImporting(true)
    try {
      const userId = useStore.getState().user?.id
      await flushSettingsNow()
      const { jobId } = await userDataApi.startImport(file, (pct) => {
        setImportUploadPct(pct)
        // Once bytes are on the wire, the server is verifying the archive
        // (central-directory parse + manifest decode). Surface a status
        // immediately so the UI doesn't look frozen during the gap between
        // upload-complete and the first job-side WS event.
        if (pct >= 100) {
          setImportProgress({ jobId: '', phase: 'verifying' })
        }
      })
      setImportJobId(jobId)
      // The start event can arrive before the upload response or be missed
      // during a WebSocket reconnect. Leave the upload label immediately.
      setImportProgress((previous) => previous?.phase === 'verifying' || !previous
        ? { jobId, phase: 'start' }
        : previous)
      if (userId) trackImportJob(userId, jobId)
      setImportUploadPct(null)
    } catch (err: any) {
      setImporting(false)
      setImportUploadPct(null)
      setImportError(err?.message || t('dataPortability.uploadFailed'))
    }
  }

  const handleResumeImport = async () => {
    if (!interruptedJobId) return
    importRequestStarted.current = true
    setImporting(true)
    setImportError(null)
    try {
      await flushSettingsNow()
      const { jobId } = await userDataApi.resumeImport(interruptedJobId)
      const userId = useStore.getState().user?.id
      if (userId) trackImportJob(userId, jobId)
      setImportJobId(jobId)
      setInterruptedJobId(null)
      setImportProgress({ jobId, phase: 'start' })
    } catch (error: any) {
      setImporting(false)
      setImportError(error?.body?.error || error?.message || t('dataPortability.importFailed'))
    }
  }

  // ── Ticket handlers ───────────────────────────────────────────────────
  const handleTicketUpload = async (ticketFile: File) => {
    if (!awaitingTicket) return
    setTicketSubmitting(true)
    setTicketReuseWarning(null)
    try {
      const text = await ticketFile.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(t('dataPortability.ticketInvalidJson'))
      }
      const result = await userDataApi.submitTicket(
        awaitingTicket.jobId,
        parsed as DecryptionTicket,
      )
      if (result.wasReused) {
        setTicketReuseWarning(result)
      }
      // Server resolves the gate and emits ticket_accepted via WS, which
      // clears `awaitingTicket` from our progress handler above.
    } catch (err: any) {
      setImportError(err?.body?.error || err?.message || t('dataPortability.ticketSubmitFailed'))
    } finally {
      setTicketSubmitting(false)
    }
  }

  const handleSkipTicket = async () => {
    if (!awaitingTicket) return
    setTicketSubmitting(true)
    try {
      await userDataApi.skipTicket(awaitingTicket.jobId)
    } catch (err: any) {
      setImportError(err?.body?.error || err?.message || t('dataPortability.skipFailed'))
    } finally {
      setTicketSubmitting(false)
    }
  }

  const handleCancelImport = async () => {
    if (!importJobId) return
    try {
      await userDataApi.cancelImport(importJobId)
    } catch (err: any) {
      setImportError(err?.message || t('dataPortability.cancelFailed'))
    }
  }

  const exportLabel = useMemo(() => {
    if (!exporting || !exportProgress) return ''
    const phase = exportProgress.phase
    if ((phase === 'table' || phase === 'table_start' || phase === 'table_done') && exportProgress.table) {
      const suffix = typeof exportProgress.processed === 'number'
        ? t('dataPortability.exportTableSuffix', { processed: exportProgress.processed })
        : ''
      return t('dataPortability.exportTable', { table: exportProgress.table, suffix })
    }
    if (phase === 'files' || phase === 'files_done') {
      return exportProgress.total
        ? t('dataPortability.exportFilesCount', { done: exportProgress.processed ?? 0, total: exportProgress.total })
        : t('dataPortability.exportFiles')
    }
    if (phase === 'lancedb_start' || phase === 'lancedb' || phase === 'lancedb_done') {
      return exportProgress.table
        ? t('dataPortability.exportVectors', { table: exportProgress.table })
        : t('dataPortability.exportVectorsGeneric')
    }
    if (phase === 'complete') return t('dataPortability.exportDone')
    return t('dataPortability.exportPreparing')
  }, [exporting, exportProgress, t])

  const importLabel = useMemo(() => {
    if (importUploadPct !== null && importUploadPct < 100) return t('dataPortability.uploading', { pct: importUploadPct })
    if (!importing || !importProgress) {
      return importUploadPct === 100 ? t('dataPortability.verifying') : ''
    }
    const phase = importProgress.phase
    if (phase === 'verifying') return t('dataPortability.verifying')
    if (phase === 'start') return t('dataPortability.importQueued')
    if (phase === 'extracting') {
      return t('dataPortability.extracting', {
        done: ((importProgress.bytesProcessed ?? 0) / (1024 ** 3)).toFixed(2),
        total: ((importProgress.bytesTotal ?? 0) / (1024 ** 3)).toFixed(2),
      })
    }
    if (phase === 'awaiting_ticket') return t('dataPortability.awaitingTicket')
    if (phase === 'ticket_accepted') return t('dataPortability.ticketAccepted')
    if (phase === 'ticket_skipped') return t('dataPortability.ticketSkipped')
    if (phase === 'secrets_apply_start') return t('dataPortability.secretsStart')
    if (phase === 'secrets_apply_done') return t('dataPortability.secretsDone')
    if (phase === 'extracted') return t('dataPortability.extracted')
    if (phase === 'table' && importProgress.table) {
      return t('dataPortability.applyingTable', { table: importProgress.table })
    }
    if (phase === 'table_done' && importProgress.table) {
      return t('dataPortability.appliedTable', { table: importProgress.table })
    }
    if (phase === 'files') {
      return importProgress.total
        ? t('dataPortability.restoringFilesCount', { done: importProgress.processed ?? 0, total: importProgress.total })
        : t('dataPortability.restoringFiles')
    }
    if (phase === 'files_done') return t('dataPortability.filesRestored')
    if (phase === 'lancedb_table_done' && importProgress.table) {
      return t('dataPortability.vectorsRestored', { table: importProgress.table })
    }
    if (phase === 'lancedb_skipped') return t('dataPortability.vectorsSkipped')
    return t('dataPortability.importGeneric')
  }, [importing, importProgress, importUploadPct, t])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={styles.container}>
      <a ref={downloadAnchorRef} style={{ display: 'none' }} aria-hidden />

      {/* ── Export ──────────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.title}>{t('dataPortability.exportTitle')}</h3>
        <p className={styles.description}>
          {t('dataPortability.exportDesc')}
        </p>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={includeVectors}
            onChange={(e) => setIncludeVectors(e.target.checked)}
            disabled={exporting}
          />
          <span>{t('dataPortability.includeVectors')}</span>
        </label>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={includeExtensionData}
            onChange={(e) => setIncludeExtensionData(e.target.checked)}
            disabled={exporting}
          />
          <span>{t('dataPortability.includeExtensionData')}</span>
        </label>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
            disabled={exporting}
          />
          <span>
            <KeyRound size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {t('dataPortability.includeSecrets')}
          </span>
        </label>
        {includeSecrets && (
          <div className={styles.warning}>
            {t('dataPortability.secretsWarning')}
          </div>
        )}
        <div className={styles.actions}>
          <Button
            variant="primary"
            icon={<Download size={14} />}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? t('dataPortability.preparing') : t('dataPortability.downloadArchive')}
          </Button>
        </div>
        {exporting && (
          <div className={styles.progress}>
            <div className={styles.progressLabel}>
              <span>{exportLabel}</span>
            </div>
            <div className={styles.progressBar}>
              <div className={styles.progressFillIndeterminate} />
            </div>
          </div>
        )}
        {exportError && <div className={styles.error}>{exportError}</div>}
        {exportWarnings.length > 0 && (
          <div className={styles.warning}>
            {t('dataPortability.exportSecretsWarn', { count: exportWarnings.length, keys: exportWarnings.join(', ') })}
          </div>
        )}
      </section>

      {/* ── Import ──────────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.title}>{t('dataPortability.importTitle')}</h3>
        <p className={styles.description}>
          {t('dataPortability.importDesc')}
        </p>
        <div className={styles.warning}>
          {t('dataPortability.importWarn')}
        </div>
        <div className={styles.actions}>
          <input
            className={styles.fileInput}
            type="file"
            accept=".lvbak,.zip,application/zip,application/octet-stream"
            disabled={importing}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setImportSuccess(null)
              setImportError(null)
              setImportSummary(null)
              setImportFileSummary(null)
            }}
          />
          <Button
            variant="primary"
            icon={<Upload size={14} />}
            onClick={handleImport}
            disabled={!file || importing}
          >
            {importing ? t('dataPortability.importing') : t('dataPortability.uploadImport')}
          </Button>
          {importing && importJobId && (
            <Button
              variant="ghost"
              icon={<X size={14} />}
              onClick={handleCancelImport}
            >
              {tc('actions.cancel')}
            </Button>
          )}
        </div>
        {interruptedJobId && !importing && (
          <div className={styles.warning}>
            <p>{t('dataPortability.resumeHint')}</p>
            <Button variant="primary" onClick={handleResumeImport}>{t('dataPortability.resumeImport')}</Button>
          </div>
        )}
        {awaitingTicket && (
          <div className={styles.progress}>
            <div className={styles.progressLabel}>
              <span>
                <ShieldAlert size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {t('dataPortability.ticketPrompt', { count: awaitingTicket.secretsCount })}
              </span>
            </div>
            <div className={styles.actions} style={{ marginTop: 8 }}>
              <input
                className={styles.fileInput}
                type="file"
                accept=".json,application/json"
                disabled={ticketSubmitting}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleTicketUpload(f)
                }}
              />
              <Button
                variant="ghost"
                onClick={handleSkipTicket}
                disabled={ticketSubmitting}
              >
                {t('dataPortability.skipApiKeys')}
              </Button>
            </div>
            {ticketReuseWarning?.wasReused && (
              <div className={styles.warning} style={{ marginTop: 8 }}>
                {t('dataPortability.ticketReuse', {
                  count: ticketReuseWarning.uses,
                  lastUsed: ticketReuseWarning.previouslyConsumedAt
                    ? t('dataPortability.ticketLastUsed', {
                        date: new Date(ticketReuseWarning.previouslyConsumedAt * 1000).toLocaleString(),
                      })
                    : '',
                })}
              </div>
            )}
          </div>
        )}
        {importing && (
          <div className={styles.progress}>
            <div className={styles.progressLabel}>
              <span>{importLabel}</span>
              {importProgress?.total ? (
                <span>{importProgress.processed ?? 0}/{importProgress.total}</span>
              ) : null}
            </div>
            <div className={styles.progressBar}>
              {importProgress?.phase === 'extracting' && (importProgress.bytesTotal ?? 0) > 0 ? (
                <div className={styles.progressFill} style={{ width: `${Math.min(100, 100 * (importProgress.bytesProcessed ?? 0) / importProgress.bytesTotal!)}%` }} />
              ) : importUploadPct !== null ? (
                <div className={styles.progressFill} style={{ width: `${importUploadPct}%` }} />
              ) : (
                <div className={styles.progressFillIndeterminate} />
              )}
            </div>
          </div>
        )}
        {importError && <div className={styles.error}>{importError}</div>}
        {importSuccess && <div className={styles.success}>{importSuccess}</div>}
        {importSummary && (
          <div className={styles.summaryTable}>
            <div className={styles.summaryHead}>{t('dataPortability.summaryTable')}</div>
            <div className={styles.summaryHead}>{t('dataPortability.summaryImported')}</div>
            <div className={styles.summaryHead}>{t('dataPortability.summarySkipped')}</div>
            {Object.entries(importSummary)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([table, counts]) => (
                <FragmentRow key={table} table={table} imported={counts.imported} skipped={counts.skipped} />
              ))}
            {importFileSummary && Object.keys(importFileSummary).length > 0 && (
              <>
                <div className={styles.summaryHead} style={{ gridColumn: 'span 3', marginTop: 6 }}>{t('dataPortability.summaryFiles')}</div>
                {Object.entries(importFileSummary).map(([bucket, count]) => (
                  <FragmentRow key={`file-${bucket}`} table={bucket} imported={count} skipped={0} />
                ))}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function FragmentRow({ table, imported, skipped }: { table: string; imported: number; skipped: number }) {
  return (
    <>
      <div className={styles.summaryTableName}>{table}</div>
      <div className={styles.summaryCell}>{imported}</div>
      <div className={styles.summaryCell}>{skipped}</div>
    </>
  )
}
