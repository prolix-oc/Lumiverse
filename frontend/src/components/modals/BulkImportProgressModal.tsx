import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, CheckCircle2, XCircle, SkipForward } from 'lucide-react'
import { charactersApi } from '@/api/characters'
import type { Character, BulkImportResultItem } from '@/types/api'
import styles from './BulkImportProgressModal.module.css'

const CHUNK_SIZE = 20

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
  const [processed, setProcessed] = useState(0)
  const [results, setResults] = useState<BulkImportResultItem[]>([])
  const [currentFile, setCurrentFile] = useState('')
  const [done, setDone] = useState(false)
  const [skipDuplicates, setSkipDuplicates] = useState(false)
  const [started, setStarted] = useState(false)
  const cancelledRef = useRef(false)
  const resultsEndRef = useRef<HTMLDivElement>(null)

  // Reset on new open
  useEffect(() => {
    if (isOpen && files.length > 0) {
      setProcessed(0)
      setResults([])
      setCurrentFile('')
      setDone(false)
      setStarted(false)
      cancelledRef.current = false
    }
  }, [isOpen, files])

  // Auto-scroll results list
  useEffect(() => {
    resultsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [results.length])

  const startImport = useCallback(async () => {
    setStarted(true)
    const allResults: BulkImportResultItem[] = []

    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      if (cancelledRef.current) break

      const chunk = files.slice(i, i + CHUNK_SIZE)
      setCurrentFile(
        chunk.length === 1
          ? chunk[0].name
          : `${chunk[0].name} ... (${chunk.length} files)`
      )

      try {
        const response = await charactersApi.importBulk(chunk, skipDuplicates)
        allResults.push(...response.results)
        setResults([...allResults])
        setProcessed(Math.min(i + chunk.length, files.length))
      } catch {
        // If the bulk endpoint itself fails, record errors for this chunk
        for (const file of chunk) {
          allResults.push({ filename: file.name, success: false, error: 'Request failed' })
        }
        setResults([...allResults])
        setProcessed(Math.min(i + chunk.length, files.length))
      }
    }

    setDone(true)
    setCurrentFile('')

    // Collect results for parent
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
  }, [files, skipDuplicates, onComplete])

  const handleCancel = useCallback(() => {
    if (done) {
      onClose()
    } else {
      cancelledRef.current = true
    }
  }, [done, onClose])

  const total = files.length
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const successCount = results.filter((r) => r.success && !r.skipped).length
  const skippedCount = results.filter((r) => r.skipped).length
  const errorCount = results.filter((r) => !r.success).length

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className={styles.header}>
              <span className={styles.title}>
                {done ? 'Import Complete' : started ? 'Importing Characters...' : 'Bulk Import'}
              </span>
              {done && (
                <button type="button" className={styles.closeBtn} onClick={onClose}>
                  <X size={16} />
                </button>
              )}
            </div>

            <div className={styles.body}>
              {!started && (
                <label className={styles.dedupToggle}>
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                  />
                  Skip characters that already exist (by name)
                </label>
              )}

              <div className={styles.progressSection}>
                <div className={styles.progressLabel}>
                  <span>{started ? (done ? 'Done' : 'Processing...') : `${total} files selected`}</span>
                  <span className={styles.progressCount}>
                    {processed}/{total}
                  </span>
                </div>
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ transform: `scaleX(${pct / 100})` }} />
                </div>
                {currentFile && <div className={styles.currentFile}>{currentFile}</div>}
              </div>

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
                            ? 'duplicate'
                            : r.success
                              ? r.lorebook
                                ? `${r.lorebook.entryCount} WI entries`
                                : ''
                              : r.error || 'failed'}
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
                        {successCount} imported
                      </span>
                      {skippedCount > 0 && (
                        <span className={styles.summaryItem}>
                          <span
                            className={styles.summaryDot}
                            style={{ background: 'var(--lumiverse-warning, #f59e0b)' }}
                          />
                          {skippedCount} skipped
                        </span>
                      )}
                      {errorCount > 0 && (
                        <span className={styles.summaryItem}>
                          <span
                            className={styles.summaryDot}
                            style={{ background: 'var(--lumiverse-danger, #ef4444)' }}
                          />
                          {errorCount} failed
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
                  <button type="button" className={styles.cancelBtn} onClick={onClose}>
                    Cancel
                  </button>
                  <button type="button" className={styles.doneBtn} onClick={startImport}>
                    Start Import
                  </button>
                </>
              ) : done ? (
                <button type="button" className={styles.doneBtn} onClick={onClose}>
                  Close
                </button>
              ) : (
                <button type="button" className={styles.cancelBtn} onClick={handleCancel}>
                  Cancel
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
