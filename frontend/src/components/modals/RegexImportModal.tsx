import { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import styles from './RegexImportModal.module.css'
import clsx from 'clsx'

export default function RegexImportModal() {
  const closeModal = useStore((s) => s.closeModal)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)

  const [tab, setTab] = useState<'file' | 'paste'>('file')
  const [pasteContent, setPasteContent] = useState('')
  const [dragging, setDragging] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const doImport = useCallback(async (data: any) => {
    setImporting(true)
    try {
      const res = await regexApi.importScripts(data)
      setResult(res)
      if (res.imported > 0) {
        await loadRegexScripts()
        toast.success(`Imported ${res.imported} script${res.imported !== 1 ? 's' : ''}`)
      }
      if (res.errors.length > 0) {
        toast.error(`${res.errors.length} error${res.errors.length !== 1 ? 's' : ''} during import`)
      }
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    } finally {
      setImporting(false)
    }
  }, [loadRegexScripts])

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    try {
      const parsed = JSON.parse(text)
      await doImport(parsed)
    } catch {
      toast.error('Invalid JSON file')
    }
  }, [doImport])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handlePasteImport = useCallback(async () => {
    if (!pasteContent.trim()) return
    try {
      const parsed = JSON.parse(pasteContent)
      await doImport(parsed)
    } catch {
      toast.error('Invalid JSON content')
    }
  }, [pasteContent, doImport])

  return createPortal(
    <motion.div
      className={styles.overlay}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={closeModal}
    >
      <motion.div
        className={styles.modal}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Import Regex Scripts</h2>
          <button className={styles.closeBtn} onClick={closeModal}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          <div className={styles.tabs}>
            <button className={clsx(styles.tab, tab === 'file' && styles.tabActive)} onClick={() => setTab('file')}>
              File Upload
            </button>
            <button className={clsx(styles.tab, tab === 'paste' && styles.tabActive)} onClick={() => setTab('paste')}>
              Paste JSON
            </button>
          </div>

          {tab === 'file' && (
            <div
              className={clsx(styles.dropZone, dragging && styles.dropZoneActive)}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <p>Drop a JSON file here or click to browse</p>
              <p>Supports Lumiverse and SillyTavern formats</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
            </div>
          )}

          {tab === 'paste' && (
            <>
              <textarea
                className={styles.pasteArea}
                value={pasteContent}
                onChange={(e) => setPasteContent(e.target.value)}
                placeholder='Paste JSON here...'
                rows={8}
              />
              <button
                className={styles.btnPrimary}
                onClick={handlePasteImport}
                disabled={importing || !pasteContent.trim()}
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </>
          )}

          {result && (
            <div className={styles.result}>
              <p>Imported: {result.imported} | Skipped: {result.skipped}</p>
              {result.errors.length > 0 && (
                <div className={styles.resultError}>
                  {result.errors.map((e, i) => <p key={i}>{e}</p>)}
                </div>
              )}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.btn} onClick={closeModal}>Close</button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}
