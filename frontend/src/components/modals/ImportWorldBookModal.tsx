import { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X, Upload } from 'lucide-react'
import { worldBooksApi } from '@/api/world-books'
import type { WorldBook } from '@/types/api'
import styles from './ImportWorldBookModal.module.css'
import clsx from 'clsx'

type ImportTab = 'file' | 'url'

export interface WorldBookImportResult {
  world_book: WorldBook
  entry_count: number
}

interface Props {
  onImport: (result: WorldBookImportResult) => void
  onClose: () => void
}

export default function ImportWorldBookModal({ onImport, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<ImportTab>('file')

  // File state
  const [isDragging, setIsDragging] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // URL state
  const [url, setUrl] = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)

  // File import
  const handleFile = useCallback(async (file: File) => {
    setFileError(null)
    setFileLoading(true)
    try {
      const text = await file.text()
      const payload = JSON.parse(text)
      if (!payload.name) {
        payload.originalName = file.name.replace(/\.[^.]+$/, '')
      }
      if (!payload.description) {
        payload.description = `Uploaded at ${new Date().toLocaleString()}`
      }
      const result = await worldBooksApi.importJson(payload)
      onImport(result)
    } catch (e: any) {
      setFileError(e.message || 'Failed to import file')
      setFileLoading(false)
    }
  }, [onImport])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  // URL import
  const handleUrlImport = useCallback(async () => {
    if (!url.trim()) return
    setUrlError(null)
    setUrlLoading(true)
    try {
      const result = await worldBooksApi.importUrl(url.trim())
      onImport(result)
    } catch (e: any) {
      setUrlError(e.message || 'Failed to import from URL')
      setUrlLoading(false)
    }
  }, [url, onImport])

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <motion.div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Import World Book</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className={styles.tabs}>
          {(['file', 'url'] as ImportTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={clsx(styles.tab, activeTab === tab && styles.tabActive)}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'file' ? 'File Upload' : 'From URL'}
            </button>
          ))}
        </div>

        {/* File Upload */}
        {activeTab === 'file' && (
          <div className={styles.body}>
            {fileError && <div className={styles.error}>{fileError}</div>}
            <div
              className={clsx(styles.dropZone, isDragging && styles.dropZoneActive)}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={24} style={{ margin: '0 auto 8px', opacity: 0.5, display: 'block' }} />
              <div className={styles.dropZoneText}>Drop a JSON file here or click to browse</div>
              <div className={styles.dropZoneSub}>Supports standard world book / lorebook format</div>
            </div>
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
            {fileLoading && <div className={styles.status}>Importing...</div>}
          </div>
        )}

        {/* From URL */}
        {activeTab === 'url' && (
          <div className={styles.body}>
            {urlError && <div className={styles.error}>{urlError}</div>}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>World Book URL</label>
              <input
                type="text"
                className={styles.fieldInput}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/worldbook.json"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleUrlImport()}
              />
            </div>
            <button
              type="button"
              className={styles.importBtn}
              disabled={!url.trim() || urlLoading}
              onClick={handleUrlImport}
            >
              {urlLoading ? 'Importing...' : 'Import'}
            </button>
          </div>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            Close
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  )
}
