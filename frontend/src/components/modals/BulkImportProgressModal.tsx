import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, SkipForward } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { charactersApi } from '@/api/characters'
import { ApiError } from '@/api/client'
import type { Character, BulkImportResultItem, CharacterImportJob } from '@/types/api'
import styles from './BulkImportProgressModal.module.css'

const JOB_POLL_INTERVAL_MS = 250
const JOB_RETRY_INTERVAL_MS = 1000
const JOB_MAX_RETRY_INTERVAL_MS = 5000
type ImportOutcome = 'complete' | 'cancelled' | 'error'

interface BulkImportProgressModalProps {
  isOpen: boolean
  files: File[]
  onComplete: (imported: Character[], lorebookCharacters: LorebookInfo[]) => void
  onClose: () => void
}

export interface LorebookInfo {
  characterId: string
  characterName: string
  lorebookName: string
  entryCount: number
}

export default function BulkImportProgressModal({
  isOpen,
  files,
  onComplete,
  onClose,
}: BulkImportProgressModalProps) {
  const { t } = useTranslation('modals')
  const { t: tc } = useTranslation('common')
  const [processed, setProcessed] = useState(0)
  const [results, setResults] = useState<BulkImportResultItem[]>([])
  const [currentFile, setCurrentFile] = useState('')
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [importError, setImportError] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const done = outcome !== null
  const [skipDuplicates, setSkipDuplicates] = useState(false)
  const [started, setStarted] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>('idle')
  const cancelledRef = useRef(false)
  const activeJobIdRef = useRef<string | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const resultsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen && files.length > 0) {
      setProcessed(0)
      setResults([])
      setCurrentFile('')
      setOutcome(null)
      setImportError('')
      setReconnecting(false)
      setStarted(false)
      setPhase('idle')
      cancelledRef.current = false
      activeJobIdRef.current = null
      uploadAbortRef.current = null
    }
  }, [isOpen, files])

  useEffect(() => {
    resultsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [results.length])

  const startImport = useCallback(async () => {
    setStarted(true)
    setPhase('uploading')
    setProcessed(0)
    let allResults: BulkImportResultItem[] = []
    let finalOutcome: ImportOutcome = 'error'
    let startRequested = false

    try {
      const created = await charactersApi.createImportJob(files.length, skipDuplicates)
      activeJobIdRef.current = created.jobId

      // One raw file per request keeps both the browser and Bun working sets
      // bounded. The server streams each body to disk before parsing begins.
      for (let i = 0; i < files.length; i++) {
        if (cancelledRef.current) throw new DOMException('Import cancelled', 'AbortError')
        setCurrentFile(files[i].name)
        const controller = new AbortController()
        uploadAbortRef.current = controller
        await charactersApi.uploadImportJobFile(created.jobId, i, files[i], controller.signal)
        uploadAbortRef.current = null
        setProcessed(i + 1)
      }

      if (cancelledRef.current) throw new DOMException('Import cancelled', 'AbortError')
      setPhase('processing')
      setProcessed(0)
      setCurrentFile(files[0]?.name || '')
      startRequested = true
      await charactersApi.startImportJob(created.jobId)

      let retryDelay = JOB_RETRY_INTERVAL_MS
      while (true) {
        let snapshot: CharacterImportJob
        try {
          snapshot = await charactersApi.getImportJob(created.jobId)
        } catch (err) {
          if (cancelledRef.current) {
            finalOutcome = 'cancelled'
            break
          }
          // A failed status request says nothing about the running import.
          // Retry network failures, timeouts, rate limits and server errors;
          // permanent client errors (such as a missing job) need user attention.
          if (err instanceof ApiError && err.status >= 400 && err.status < 500
            && err.status !== 408 && err.status !== 429) throw err
          setReconnecting(true)
          await new Promise((resolve) => setTimeout(resolve, retryDelay))
          retryDelay = Math.min(retryDelay * 2, JOB_MAX_RETRY_INTERVAL_MS)
          if (cancelledRef.current) {
            finalOutcome = 'cancelled'
            break
          }
          continue
        }
        retryDelay = JOB_RETRY_INTERVAL_MS
        setReconnecting(false)
        allResults = snapshot.results
        setResults(snapshot.results)
        setProcessed(snapshot.processed)
        setCurrentFile(snapshot.processed < files.length ? files[snapshot.processed].name : '')

        if (snapshot.status === 'complete' || snapshot.status === 'cancelled' || snapshot.status === 'error') {
          if (snapshot.status === 'error') {
            throw new Error(snapshot.error || t('bulkImport.requestFailed'))
          }
          if (snapshot.status === 'complete' && snapshot.processed !== files.length) {
            throw new Error(t('bulkImport.incomplete'))
          }
          finalOutcome = snapshot.status
          break
        }
        await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS))
      }
    } catch (err: any) {
      if (cancelledRef.current) {
        finalOutcome = 'cancelled'
      } else {
        setImportError(err?.body?.error || err?.body?.message || err?.message || t('bulkImport.requestFailed'))
      }
      // Clean up failed uploads, but never cancel a processing job merely
      // because its response could not be received.
      const jobId = activeJobIdRef.current
      if (jobId && !startRequested) void charactersApi.cancelImportJob(jobId).catch(() => {})
    } finally {
      uploadAbortRef.current = null
      activeJobIdRef.current = null
      setOutcome(finalOutcome)
      setReconnecting(false)
      setCurrentFile('')
    }

    // Successful files still belong in the browser after an interruption.
    const imported = allResults
      .filter((r) => r.success && !r.skipped && r.character)
      .map((r) => r.character!)

    const lorebookChars: LorebookInfo[] = allResults
      .filter((r) => r.success && !r.skipped && r.character && r.lorebook)
      .map((r) => ({
        characterId: r.character!.id,
        characterName: r.character!.name,
        lorebookName: r.lorebook!.name,
        entryCount: r.lorebook!.entryCount,
      }))

    onComplete(imported, lorebookChars)
  }, [files, skipDuplicates, onComplete, t])

  const handleCancel = useCallback(() => {
    if (done) {
      onClose()
    } else {
      cancelledRef.current = true
      uploadAbortRef.current?.abort()
      const jobId = activeJobIdRef.current
      if (jobId) void charactersApi.cancelImportJob(jobId).catch(() => {})
    }
  }, [done, onClose])

  const total = files.length
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const successCount = results.filter((r) => r.success && !r.skipped).length
  const skippedCount = results.filter((r) => r.skipped).length
  const errorCount = results.filter((r) => !r.success).length
  const outcomeLabel = outcome === 'complete'
    ? t('bulkImport.complete')
    : outcome === 'cancelled'
      ? t('bulkImport.cancelled')
      : t('bulkImport.interrupted')

  // Detail line for a successful import: combine the embedded lorebook entry
  // count and the portable LoRA reference, whichever are present.
  const successDetail = (r: BulkImportResultItem): string =>
    [
      r.lorebook ? t('bulkImport.wiEntries', { count: r.lorebook.entryCount }) : null,
      r.lumiverse_lora
        ? t('bulkImport.loraReference', { name: r.lumiverse_lora.lora_filename, weight: r.lumiverse_lora.weight })
        : null,
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={520} closeOnBackdrop={done} closeOnEscape={done}>
      <div className={styles.header}>
        <span className={styles.title}>
          {done ? outcomeLabel : started ? t('bulkImport.importing') : t('bulkImport.title')}
        </span>
        {done && (
          <CloseButton onClick={onClose} />
        )}
      </div>

      <div className={styles.body}>
        {!started && (
          <div className={styles.dedupToggle}>
            <Toggle.Checkbox
              checked={skipDuplicates}
              onChange={setSkipDuplicates}
              label={t('bulkImport.skipDuplicates')}
            />
          </div>
        )}

        <div className={styles.progressSection}>
          <div className={styles.progressLabel}>
            <span>
              {started
                ? done
                  ? outcome === 'complete' ? t('bulkImport.done') : outcomeLabel
                  : reconnecting
                    ? t('bulkImport.reconnecting')
                    : phase === 'uploading'
                      ? t('bulkImport.uploading')
                      : t('bulkImport.processing')
                : t('bulkImport.filesSelected', { count: total })}
            </span>
            <span className={styles.progressCount}>
              {processed}/{total}
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          {currentFile && <div className={styles.currentFile}>{currentFile}</div>}
        </div>

        {importError && <div role="alert" className={styles.importError}>{importError}</div>}

        {results.length > 0 && (
          <>
            <div className={styles.resultsList}>
              {results.map((r, i) => (
                <div key={i} className={styles.resultItem}>
                  <span className={styles.resultIcon}>
                    {r.skipped ? (
                      <SkipForward size={14} className={styles.resultSkipped} />
                    ) : r.success ? (
                      <CheckCircle2 size={14} className={styles.resultSuccess} />
                    ) : (
                      <XCircle size={14} className={styles.resultError} />
                    )}
                  </span>
                  <span className={styles.resultName}>
                    {r.skipped
                      ? r.filename
                      : r.success
                        ? r.character?.name || r.filename
                        : r.filename}
                  </span>
                  <span className={styles.resultDetail}>
                    {r.skipped
                      ? t('bulkImport.duplicate')
                      : r.success
                        ? successDetail(r)
                        : r.error || t('bulkImport.failed')}
                  </span>
                </div>
              ))}
              <div ref={resultsEndRef} />
            </div>

            {done && (
              <div className={styles.summary}>
                <span className={styles.summaryItem}>
                  <span
                    className={styles.summaryDot}
                    style={{ background: 'var(--lumiverse-success, #22c55e)' }}
                  />
                  {t('bulkImport.imported', { count: successCount })}
                </span>
                {skippedCount > 0 && (
                  <span className={styles.summaryItem}>
                    <span
                      className={styles.summaryDot}
                      style={{ background: 'var(--lumiverse-warning, #f59e0b)' }}
                    />
                    {t('bulkImport.skipped', { count: skippedCount })}
                  </span>
                )}
                {errorCount > 0 && (
                  <span className={styles.summaryItem}>
                    <span
                      className={styles.summaryDot}
                      style={{ background: 'var(--lumiverse-danger, #ef4444)' }}
                    />
                    {t('bulkImport.failedCount', { count: errorCount })}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.footer}>
        {!started ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tc('actions.cancel')}
            </Button>
            <Button variant="primary" onClick={startImport}>
              {t('bulkImport.startImport')}
            </Button>
          </>
        ) : done ? (
          <Button variant="primary" onClick={onClose}>
            {tc('actions.close')}
          </Button>
        ) : (
          <Button variant="ghost" onClick={handleCancel}>
            {tc('actions.cancel')}
          </Button>
        )}
      </div>
    </ModalShell>
  )
}
