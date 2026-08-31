import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Download, Upload, X, KeyRound, ShieldAlert, RefreshCw } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { userDataApi } from '@/api/user-data'
import {
  isUserDataJobActive,
  isUserDataJobCancellable,
  normalizeUserDataApiFailure,
  normalizeUserDataProgress,
  ARCHIVE_SCHEMA_VERSION,
  USER_DATA_LIMITS,
  type UserDataJob,
  type UserDataJobStatus,
  type UserDataProgress,
} from '@/types/user-data'
import styles from './DataPortability.module.css'

interface ExportProgress {
  phase: string
  table?: string
  processed?: number
  total?: number
}
function parseWsProgress(value: unknown): UserDataProgress | null {
  try {
    return normalizeUserDataProgress(value)
  } catch {
    return null
  }
}

function statusForProgress(phase: string, current: UserDataJobStatus): UserDataJobStatus {
  if (current === 'cancelling' || current === 'cleanup_pending' || current === 'complete' || current === 'failed' || current === 'cancelled') return current
  if (phase === 'cancelling') return 'cancelling'
  if (phase === 'cleanup_pending') return 'cleanup_pending'
  if (phase === 'awaiting_ticket') return 'awaiting_ticket'
  if (phase === 'committing') return 'committing'
  if (current === 'queued' || current === 'validating') return current
  return 'running'
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  window.setTimeout(resolve, ms)
  return promise
}

export default function DataPortability() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const userId = useStore((state) => state.user?.id ?? null)
  const downloadAnchorRef = useRef<HTMLAnchorElement | null>(null)

  const job = useStore((state) => state.userDataJob)
  const jobLoading = useStore((state) => state.userDataJobLoading)
  const jobAction = useStore((state) => state.userDataJobAction)
  const jobFailure = useStore((state) => state.userDataJobError)
  const setUserDataJob = useStore((state) => state.setUserDataJob)
  const clearUserDataJob = useStore((state) => state.clearUserDataJob)
  const startUserDataImport = useStore((state) => state.startUserDataImport)
  const refreshUserDataJob = useStore((state) => state.refreshUserDataJob)
  const reconnectUserDataJob = useStore((state) => state.reconnectUserDataJob)
  const submitUserDataTicket = useStore((state) => state.submitUserDataTicket)
  const skipUserDataTicket = useStore((state) => state.skipUserDataTicket)
  const cancelUserDataImport = useStore((state) => state.cancelUserDataImport)
  const [includeVectors, setIncludeVectors] = useState(true)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [importUploadPct, setImportUploadPct] = useState<number | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)

  // Status is durable in SQLite. Polling is deliberately bounded and is the
  // reconnect path after a tab/browser/server restart; WebSocket progress is
  // only an acceleration and never the source of truth.
  useEffect(() => {
    void reconnectUserDataJob()
    const timer = window.setInterval(() => {
      const current = useStore.getState().userDataJob
      if (current && isUserDataJobActive(current.status)) void refreshUserDataJob(current.jobId)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [reconnectUserDataJob, refreshUserDataJob, userId])

  useEffect(() => {
    const unsubs: Array<() => void> = []
    unsubs.push(wsClient.on(EventType.USER_EXPORT_PROGRESS, (payload: ExportProgress) => {
      const progress = parseWsProgress(payload)
      if (!progress) return
      setExportProgress({
        phase: progress.phase,
        table: progress.table ?? undefined,
        processed: progress.processed ?? undefined,
        total: progress.total ?? undefined,
      })
      if (progress.phase === 'complete') {
        window.setTimeout(() => setExportProgress(null), 1_200)
        setExporting(false)
      }
    }))
    unsubs.push(wsClient.on(EventType.USER_IMPORT_PROGRESS, (payload: { jobId?: unknown; phase?: unknown; table?: unknown; processed?: unknown; total?: unknown }) => {
      const current = useStore.getState().userDataJob
      if (!current || typeof payload.jobId !== 'string' || payload.jobId !== current.jobId) return
      const progress = parseWsProgress(payload)
      if (!progress) return
      setUserDataJob({ ...current, status: statusForProgress(progress.phase, current.status), progress, failure: null })
      void refreshUserDataJob(current.jobId)
    }))
    unsubs.push(wsClient.on(EventType.USER_IMPORT_COMPLETE, (payload: { jobId?: unknown }) => {
      if (typeof payload.jobId === 'string') void reconnectUserDataJob(payload.jobId)
    }))
    unsubs.push(wsClient.on(EventType.USER_IMPORT_FAILED, (payload: { jobId?: unknown }) => {
      const current = useStore.getState().userDataJob
      const jobId = typeof payload.jobId === 'string' ? payload.jobId : current?.jobId
      if (jobId) void reconnectUserDataJob(jobId)
    }))
    return () => { for (const unsubscribe of unsubs) unsubscribe() }
  }, [reconnectUserDataJob, refreshUserDataJob, setUserDataJob])
  useEffect(() => {
    if (job?.status === 'complete') setFile(null)
  }, [job?.status])


  const handleExport = async () => {
    setExportError(null)
    setExporting(true)
    setExportProgress({ phase: 'start' })
    const anchor = downloadAnchorRef.current
    if (!anchor) {
      setExportError(t('dataPortability.exportAnchorMissing'))
      setExporting(false)
      setExportProgress(null)
      return
    }
    if (!includeSecrets) {
      anchor.removeAttribute('download')
      anchor.href = userDataApi.exportUrl(includeVectors)
      anchor.click()
      // A native download is detached from the page; do not leave a stale
      // busy state waiting for a websocket event that may be missed.
      setExporting(false)
      setExportProgress(null)
      return
    }
    try {
      const response = await userDataApi.prepareSecretsExport(includeVectors)
      if (response.ticket && response.ticketFilename) {
        const ticketBlob = new Blob([JSON.stringify(response.ticket, null, 2)], { type: 'application/json' })
        const ticketUrl = URL.createObjectURL(ticketBlob)
        anchor.href = ticketUrl
        anchor.download = response.ticketFilename
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(ticketUrl), 5_000)
      }
      await delay(600)
      anchor.removeAttribute('download')
      anchor.href = response.archiveUrl
      anchor.click()
      setExporting(false)
      setExportProgress(null)
    } catch {
      setExportError(t('dataPortability.exportPrepareFailed'))
      setExporting(false)
      setExportProgress(null)
    }
  }

  const handleImport = async () => {
    if (!file) return
    setImportError(null)
    setImportSuccess(null)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > USER_DATA_LIMITS.maxArchiveUploadBytes) {
      setImportError(t('dataPortability.failureReasons.size'))
      return
    }
    // A new upload supersedes the old tab attachment. Clear it before the
    // request so a failed/restarted upload cannot leave Cancel targeting the
    // previous receipt while the new archive is being staged.
    clearUserDataJob()
    setUploading(true)
    setImportUploadPct(0)
    try {
      await startUserDataImport(file, (percent) => setImportUploadPct(percent))
      // Keep the selected file while the job runs. If validation or import
      // fails, the user can retry the same archive without selecting it again.
      setImportUploadPct(null)
    } catch (error) {
      setImportUploadPct(null)
      const failure = normalizeUserDataApiFailure(error, 'upload_failed')
      setImportError(t(`dataPortability.failureReasons.${failure.code}`, {
        defaultValue: t('dataPortability.failureReasons.upload_failed'),
      }))
    } finally {
      setUploading(false)
    }
  }

  const handleTicketUpload = async (ticketFile: File) => {
    if (!job || job.status !== 'awaiting_ticket' || jobAction !== null) return
    setImportError(null)
    setImportSuccess(null)
    if (!Number.isSafeInteger(ticketFile.size) || ticketFile.size < 0 || ticketFile.size > USER_DATA_LIMITS.maxTicketBytes) {
      setImportError(t('dataPortability.failureReasons.ticket_invalid'))
      return
    }
    try {
      const accepted = await submitUserDataTicket(job.jobId, await ticketFile.text())
      if (accepted) setImportSuccess(t('dataPortability.ticketAccepted'))
    } catch (error) {
      const failure = normalizeUserDataApiFailure(error, 'ticket_submission_failed')
      setImportError(t(`dataPortability.failureReasons.${failure.code}`, {
        defaultValue: t('dataPortability.failureReasons.ticket_submission_failed'),
      }))
    }
  }

  const handleSkipTicket = async () => {
    if (!job || job.status !== 'awaiting_ticket' || jobAction !== null) return
    setImportError(null)
    setImportSuccess(null)
    const skipped = await skipUserDataTicket(job.jobId)
    if (skipped) setImportSuccess(t('dataPortability.ticketSkipped'))
  }

  const handleCancelImport = async () => {
    if (!job || !isUserDataJobCancellable(job.status)) return
    const status = await cancelUserDataImport(job.jobId)
    if (status === 'too_late') setImportError(t('dataPortability.cancelTooLate'))
    if (status === 'cancelling') setImportSuccess(t('dataPortability.cancelling'))
    if (status === 'cleanup_pending') setImportSuccess(t('dataPortability.cleanupPending'))
    if (status === 'cancelled') setImportSuccess(t('dataPortability.importCancelled'))
  }

  const importLabel = useMemo(() => {
    if (importUploadPct !== null && importUploadPct < 100) return t('dataPortability.uploading', { pct: importUploadPct })
    if (!job) return importUploadPct === 100 ? t('dataPortability.verifying') : ''
    const phase = job.progress?.phase
    if (job.status === 'awaiting_ticket' || phase === 'awaiting_ticket') return t('dataPortability.awaitingTicket')
    if (phase === 'verifying' || job.status === 'validating') return t('dataPortability.verifying')
    if (phase === 'secrets_apply_start') return t('dataPortability.secretsStart')
    if (phase === 'secrets_apply_done') return t('dataPortability.secretsDone')
    if (phase === 'extracted') return t('dataPortability.extracted')
    if (phase === 'table' && job.progress?.table) return t('dataPortability.applyingTable', { table: job.progress.table })
    if (phase === 'table_done' && job.progress?.table) return t('dataPortability.appliedTable', { table: job.progress.table })
    if (phase === 'files') return job.progress?.total !== null && job.progress?.total !== undefined ? t('dataPortability.restoringFilesCount', { done: job.progress.processed ?? 0, total: job.progress.total }) : t('dataPortability.restoringFiles')
    if (phase === 'lancedb_skipped') return t('dataPortability.vectorsSkipped')
    if (phase === 'cancelling' || job.status === 'cancelling') return t('dataPortability.cancelling')
    if (phase === 'cleanup_pending' || job.status === 'cleanup_pending') return t('dataPortability.cleanupPending')
    if (job.status === 'complete') return t('dataPortability.importComplete')
    if (job.status === 'cancelled') return t('dataPortability.importCancelled')
    if (job.status === 'failed') return t('dataPortability.importFailed')
    return t('dataPortability.importGeneric')
  }, [importUploadPct, job, t])

  const failureLabel = jobFailure?.code ?? job?.failure?.code
  const failureText = failureLabel
    ? t(`dataPortability.failureReasons.${failureLabel}`, { defaultValue: t('dataPortability.failureReasons.unknown') })
    : null
  const isBusy = uploading || (job !== null && isUserDataJobActive(job.status))

  return (
    <div className={styles.container}>
      <a ref={downloadAnchorRef} style={{ display: 'none' }} aria-hidden="true" />

      <section className={styles.section}>
        <h3 className={styles.title}>{t('dataPortability.exportTitle')}</h3>
        <p className={styles.description}>{t('dataPortability.exportDesc')}</p>
        <p className={styles.schemaVersion}>{t('dataPortability.exportSchemaVersion', { version: ARCHIVE_SCHEMA_VERSION })}</p>
        <label className={styles.checkboxRow}>
          <input type="checkbox" checked={includeVectors} onChange={(event) => setIncludeVectors(event.target.checked)} disabled={exporting} />
          <span>{t('dataPortability.includeVectors')}</span>
        </label>
        <label className={styles.checkboxRow}>
          <input type="checkbox" checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} disabled={exporting} />
          <span><KeyRound size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />{t('dataPortability.includeSecrets')}</span>
        </label>
        {includeSecrets && <div className={styles.warning}>{t('dataPortability.secretsWarning')}</div>}
        <div className={styles.actions}>
          <Button variant="primary" icon={<Download size={14} />} onClick={handleExport} disabled={exporting}>
            {exporting ? t('dataPortability.preparing') : t('dataPortability.downloadArchive')}
          </Button>
        </div>
        {(exporting || exportProgress) && (
          <div className={styles.progress}>
            <div className={styles.progressLabel}><span>{exportProgress?.phase === 'complete' ? t('dataPortability.exportDone') : t('dataPortability.exportPreparing')}</span></div>
            <div className={styles.progressBar}><div className={styles.progressFillIndeterminate} /></div>
          </div>
        )}
        {exportError && <div className={styles.error}>{exportError}</div>}
      </section>

      <section className={styles.section}>
        <h3 className={styles.title}>{t('dataPortability.importTitle')}</h3>
        <p className={styles.description}>{t('dataPortability.importDesc')}</p>
        <div className={styles.warning}>{t('dataPortability.importWarn')}</div>
        <div className={styles.actions}>
          <input
            className={styles.fileInput}
            type="file"
            accept=".lvbak,.zip,application/zip,application/octet-stream"
            disabled={isBusy}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              setFile(selected)
              setImportError(null)
              setImportSuccess(null)
            }}
          />
          <Button variant="primary" icon={<Upload size={14} />} onClick={handleImport} disabled={!file || isBusy}>
            {uploading ? t('dataPortability.importing') : job?.status === 'failed' || job?.status === 'cancelled' ? t('dataPortability.reuploadImport') : t('dataPortability.uploadImport')}
          </Button>
          {job && isUserDataJobCancellable(job.status) && (
            <Button variant="ghost" icon={<X size={14} />} onClick={handleCancelImport} disabled={jobAction === 'cancel'}>
              {jobAction === 'cancel' ? t('dataPortability.cancelling') : tc('actions.cancel')}
            </Button>
          )}
          {job && (
            <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void reconnectUserDataJob(job.jobId)} disabled={jobLoading || jobAction !== null}>
              {t('dataPortability.reconnect')}
            </Button>
          )}
        </div>

        {job && (
          <div className={styles.jobCard}>
            <div className={styles.jobHeader}>
              <span>{t('dataPortability.jobStatus', { status: t(`dataPortability.statuses.${job.status}`) })}</span>
              <span className={styles.jobId}>{job.jobId}</span>
            </div>
            {job.archiveId && <div className={styles.jobMeta}>{t('dataPortability.archiveId', { id: job.archiveId })}</div>}
            {(isBusy || job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') && (
              <div className={styles.progress}>
                <div className={styles.progressLabel}><span>{importLabel}</span>{job.progress?.total !== null && job.progress?.total !== undefined ? <span>{job.progress.processed ?? 0}/{job.progress.total}</span> : null}</div>
                <div className={styles.progressBar}>
                  {importUploadPct !== null ? <div className={styles.progressFill} style={{ width: `${importUploadPct}%` }} /> : <div className={styles.progressFillIndeterminate} />}
                </div>
              </div>
            )}
            {failureText && <div className={styles.error}>{failureText}</div>}
            {job.status === 'awaiting_ticket' && (
              <div className={styles.progress}>
                <div className={styles.progressLabel}><span><ShieldAlert size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />{t('dataPortability.ticketPrompt', { count: job.ticket.secretsCount })}</span></div>
                <div className={styles.actions} style={{ marginTop: 8 }}>
                  <input className={styles.fileInput} type="file" accept=".json,application/json" disabled={jobAction === 'ticket'} onChange={(event) => { const ticket = event.target.files?.[0]; if (ticket) void handleTicketUpload(ticket) }} />
                  <Button variant="ghost" onClick={handleSkipTicket} disabled={jobAction === 'skip-ticket'}>{jobAction === 'skip-ticket' ? t('dataPortability.skippingTicket') : t('dataPortability.skipApiKeys')}</Button>
                </div>
              </div>
            )}
            {importSuccess && <div className={styles.success}>{importSuccess}</div>}
            {job.status === 'complete' && <ReceiptSummary job={job} t={t} />}
          </div>
        )}
        {!job && !uploading && <div className={styles.description}>{t('dataPortability.noActiveJob')}</div>}
        {importError && <div className={styles.error}>{importError}</div>}
        {jobFailure && !failureText && <div className={styles.error}>{t('dataPortability.failureReasons.unknown')}</div>}
      </section>
    </div>
  )
}

function ReceiptSummary({ job, t }: { job: UserDataJob; t: TFunction<'settings'> }) {
  const tableRows = Object.entries(job.summary.tables).sort(([left], [right]) => left.localeCompare(right))
  const fileRows = Object.entries(job.summary.files).sort(([left], [right]) => left.localeCompare(right))
  const vector = job.summary.vectors
  const vectorStatus = vector ? t(`dataPortability.vectorStatuses.${vector.status}`) : null
  return (
    <div className={styles.summaryTable}>
      <div className={styles.summaryHead}>{t('dataPortability.summaryTable')}</div>
      <div className={styles.summaryHead}>{t('dataPortability.summaryImported')}</div>
      <div className={styles.summaryHead}>{t('dataPortability.summarySkipped')}</div>
      {tableRows.map(([table, counts]) => <FragmentRow key={table} table={table} imported={counts.imported} skipped={counts.skipped} />)}
      <div className={styles.summaryHead} style={{ gridColumn: 'span 3', marginTop: 6 }}>{t('dataPortability.summaryFiles')}</div>
      {fileRows.length === 0 ? <div className={styles.summaryTableName} style={{ gridColumn: 'span 3' }}>{t('dataPortability.summaryFilesNone')}</div> : fileRows.map(([name, count]) => <FragmentRow key={`file-${name}`} table={name} imported={count} skipped={0} />)}
      {vector && (
        <>
          <div className={styles.summaryHead} style={{ gridColumn: 'span 3', marginTop: 6 }}>{t('dataPortability.summaryVectors')}</div>
          <FragmentRow
            table={`${t('dataPortability.summaryVectors')} — ${vectorStatus}`}
            imported={vector.imported}
            skipped={vector.skipped}
          />
        </>
      )}
      <div className={styles.summaryHead} style={{ gridColumn: 'span 3', marginTop: 6 }}>{t('dataPortability.summarySecrets')}</div>
      <FragmentRow table={t('dataPortability.summarySecrets')} imported={job.summary.secrets.imported} skipped={job.summary.secrets.skipped} />
    </div>
  )
}

function FragmentRow({ table, imported, skipped }: { table: string; imported: number; skipped: number }) {
  return <><div className={styles.summaryTableName}>{table}</div><div className={styles.summaryCell}>{imported}</div><div className={styles.summaryCell}>{skipped}</div></>
}
