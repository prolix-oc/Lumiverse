import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Upload, X, KeyRound, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import {
  userDataApi,
  type DecryptionTicket,
  type ImportJobStatus,
  type TicketSubmissionResponse,
} from '@/api/user-data'
import styles from './DataPortability.module.css'

interface ExportProgress {
  phase: string
  table?: string
  processed?: number
  total?: number
}

interface ImportProgress {
  jobId: string
  phase: string
  table?: string
  processed?: number
  total?: number
}

type ImportSummary = ImportJobStatus['summary']
type FileSummary = ImportJobStatus['fileSummary']

export default function DataPortability() {
  // ── Export state ──────────────────────────────────────────────────────
  const [includeVectors, setIncludeVectors] = useState(true)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportWarnings, setExportWarnings] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const downloadAnchorRef = useRef<HTMLAnchorElement | null>(null)

  // ── Import state ──────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [importUploadPct, setImportUploadPct] = useState<number | null>(null)
  const [importJobId, setImportJobId] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [importFileSummary, setImportFileSummary] = useState<FileSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  // Secret-ticket UX state
  const [awaitingTicket, setAwaitingTicket] = useState<{
    jobId: string
    secretsCount: number
  } | null>(null)
  const [ticketSubmitting, setTicketSubmitting] = useState(false)
  const [ticketReuseWarning, setTicketReuseWarning] = useState<TicketSubmissionResponse | null>(null)

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
          setImportSuccess('Import complete')
        },
      ),
    )
    unsubs.push(
      wsClient.on(
        EventType.USER_IMPORT_FAILED,
        (payload: { error?: string; cancelled?: boolean }) => {
          setImporting(false)
          setImportProgress(null)
          if (payload.cancelled) {
            setImportError('Import cancelled')
          } else {
            setImportError(payload.error || 'Import failed')
          }
        },
      ),
    )
    return () => {
      for (const u of unsubs) u()
    }
  }, [])

  // ── Export action ─────────────────────────────────────────────────────
  const handleExport = async () => {
    setExportError(null)
    setExportWarnings([])
    setExporting(true)
    setExportProgress({ phase: 'start' })
    const a = downloadAnchorRef.current
    if (!a) {
      setExportError('Internal: download anchor missing')
      setExporting(false)
      return
    }

    if (!includeSecrets) {
      // Single-step path: browser handles a streaming GET as a native download.
      a.href = userDataApi.exportUrl(includeVectors)
      a.click()
      return
    }

    // Two-step path: prepare → fetch ticket + URL → trigger ticket save → kick the archive download.
    try {
      const resp = await userDataApi.prepareSecretsExport(includeVectors)
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
      setExportError(err?.body?.error || err?.message || 'Export prepare failed')
      setExporting(false)
    }
  }

  // ── Import action ─────────────────────────────────────────────────────
  const handleImport = async () => {
    if (!file) return
    setImportError(null)
    setImportSuccess(null)
    setImportSummary(null)
    setImportFileSummary(null)
    setImportProgress(null)
    setImportUploadPct(0)
    setImporting(true)
    try {
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
      setImportUploadPct(null)
      // From here, progress is delivered over the WebSocket. As a fallback,
      // poll once after a short delay in case the WS subscription is slow.
      setTimeout(() => {
        userDataApi
          .getImportStatus(jobId)
          .then((status) => {
            if (status.status === 'complete' && !importSummary) {
              setImportSummary(status.summary)
              setImportFileSummary(status.fileSummary)
              setImporting(false)
              setImportSuccess('Import complete')
            }
          })
          .catch(() => {/* ignore */})
      }, 1500)
    } catch (err: any) {
      setImporting(false)
      setImportUploadPct(null)
      setImportError(err?.message || 'Upload failed')
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
        throw new Error('Ticket file is not valid JSON')
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
      setImportError(err?.body?.error || err?.message || 'Ticket submission failed')
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
      setImportError(err?.body?.error || err?.message || 'Skip failed')
    } finally {
      setTicketSubmitting(false)
    }
  }

  const handleCancelImport = async () => {
    if (!importJobId) return
    try {
      await userDataApi.cancelImport(importJobId)
    } catch (err: any) {
      setImportError(err?.message || 'Cancel failed')
    }
  }

  const exportLabel = useMemo(() => {
    if (!exporting || !exportProgress) return ''
    const phase = exportProgress.phase
    if ((phase === 'table' || phase === 'table_start' || phase === 'table_done') && exportProgress.table) {
      const suffix = typeof exportProgress.processed === 'number' ? ` (${exportProgress.processed})` : ''
      return `Exporting ${exportProgress.table}${suffix}…`
    }
    if (phase === 'files' || phase === 'files_done') {
      return exportProgress.total
        ? `Bundling files… ${exportProgress.processed ?? 0}/${exportProgress.total}`
        : 'Bundling files…'
    }
    if (phase === 'lancedb_start' || phase === 'lancedb' || phase === 'lancedb_done') {
      return exportProgress.table
        ? `Bundling vectors (${exportProgress.table})…`
        : 'Bundling vectors…'
    }
    if (phase === 'complete') return 'Done'
    return 'Preparing archive…'
  }, [exporting, exportProgress])

  const importLabel = useMemo(() => {
    if (importUploadPct !== null && importUploadPct < 100) return `Uploading… ${importUploadPct}%`
    if (!importing || !importProgress) {
      // Upload-complete but no progress event has landed yet — verify is in flight.
      return importUploadPct === 100 ? 'Verifying archive…' : ''
    }
    const phase = importProgress.phase
    if (phase === 'verifying') return 'Verifying archive…'
    if (phase === 'start') return 'Queued — starting import…'
    if (phase === 'awaiting_ticket') return 'Waiting for decryption ticket…'
    if (phase === 'ticket_accepted') return 'Ticket accepted — applying secrets…'
    if (phase === 'ticket_skipped') return 'Skipping API keys — applying rest of archive…'
    if (phase === 'secrets_apply_start') return 'Restoring API keys…'
    if (phase === 'secrets_apply_done') return 'API keys restored'
    if (phase === 'extracted') return 'Archive extracted, applying rows…'
    if (phase === 'table' && importProgress.table) {
      return `Applying ${importProgress.table}…`
    }
    if (phase === 'table_done' && importProgress.table) {
      return `Applied ${importProgress.table}`
    }
    if (phase === 'files') {
      return importProgress.total
        ? `Restoring files… ${importProgress.processed ?? 0}/${importProgress.total}`
        : 'Restoring files…'
    }
    if (phase === 'files_done') return 'Files restored'
    if (phase === 'lancedb_table_done' && importProgress.table) {
      return `Vectors restored for ${importProgress.table}`
    }
    if (phase === 'lancedb_skipped') return 'Skipping vectors (config mismatch)'
    return 'Importing…'
  }, [importing, importProgress, importUploadPct])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={styles.container}>
      <a ref={downloadAnchorRef} style={{ display: 'none' }} aria-hidden />

      {/* ── Export ──────────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.title}>Export your data</h3>
        <p className={styles.description}>
          Bundle everything you own — characters, chats, world books, personas, presets, memory cortex,
          databanks, themes, settings, and extension preferences — into a single portable archive (.lvbak).
          API keys and other secrets are <strong>never</strong> included.
        </p>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={includeVectors}
            onChange={(e) => setIncludeVectors(e.target.checked)}
            disabled={exporting}
          />
          <span>
            Include vector embeddings (faster import on a matching embedding provider; larger file)
          </span>
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
            Include API keys & secrets (downloads a separate decryption ticket)
          </span>
        </label>
        {includeSecrets && (
          <div className={styles.warning}>
            Two files will download: the archive (<code>.lvbak</code>) and a small ticket
            (<code>.ticket.json</code>). <strong>Keep the ticket separate from the archive</strong>
             — a password manager is ideal. Without the ticket, the keys cannot be restored. With
            both files together, anyone who obtains them can read your API keys.
          </div>
        )}
        <div className={styles.actions}>
          <Button
            variant="primary"
            icon={<Download size={14} />}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Preparing…' : 'Download archive'}
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
            {exportWarnings.length} secret{exportWarnings.length === 1 ? '' : 's'} could not be
            decrypted on this server and were excluded from the archive. This usually means the
            row was written by an older identity key or was inserted manually. Affected key
            {exportWarnings.length === 1 ? '' : 's'}:{' '}
            <code>{exportWarnings.join(', ')}</code>
          </div>
        )}
      </section>

      {/* ── Import ──────────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.title}>Import an archive</h3>
        <p className={styles.description}>
          Restore a .lvbak archive into this account. Imports merge by ID — your existing data is preserved.
          You'll need to re-enter API keys after the import, since secrets are never carried in archives.
        </p>
        <div className={styles.warning}>
          The archive is processed in the background after upload. Don't close this tab until you see the
          completion summary — but it's safe to keep using Lumiverse while it runs.
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
            {importing ? 'Importing…' : 'Upload & import'}
          </Button>
          {importing && importJobId && (
            <Button
              variant="ghost"
              icon={<X size={14} />}
              onClick={handleCancelImport}
            >
              Cancel
            </Button>
          )}
        </div>
        {awaitingTicket && (
          <div className={styles.progress}>
            <div className={styles.progressLabel}>
              <span>
                <ShieldAlert size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                This archive carries {awaitingTicket.secretsCount} encrypted secret
                {awaitingTicket.secretsCount === 1 ? '' : 's'}. Upload your ticket file to restore them.
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
                Skip API keys
              </Button>
            </div>
            {ticketReuseWarning?.wasReused && (
              <div className={styles.warning} style={{ marginTop: 8 }}>
                Heads up: this ticket has been used {ticketReuseWarning.uses} time
                {ticketReuseWarning.uses === 1 ? '' : 's'}
                {ticketReuseWarning.previouslyConsumedAt
                  ? ` (last used ${new Date(ticketReuseWarning.previouslyConsumedAt * 1000).toLocaleString()})`
                  : ''}
                . Proceeding will overwrite any matching API keys on this account.
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
              {importUploadPct !== null ? (
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
            <div className={styles.summaryHead}>Table</div>
            <div className={styles.summaryHead}>Imported</div>
            <div className={styles.summaryHead}>Skipped</div>
            {Object.entries(importSummary)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([table, counts]) => (
                <FragmentRow key={table} table={table} imported={counts.imported} skipped={counts.skipped} />
              ))}
            {importFileSummary && Object.keys(importFileSummary).length > 0 && (
              <>
                <div className={styles.summaryHead} style={{ gridColumn: 'span 3', marginTop: 6 }}>Files</div>
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
