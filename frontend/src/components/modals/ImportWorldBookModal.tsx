import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { worldBooksApi } from '@/api/world-books'
import { worldBookPayloadFromFile } from '@/lib/world-book-file-import'
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
  const { t } = useTranslation('modals', { keyPrefix: 'importWorldBook' })
  const { t: tc } = useTranslation('common')

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
      const result = await worldBooksApi.importJson(await worldBookPayloadFromFile(file))
      onImport(result)
    } catch (e: any) {
      setFileError(e.message || t('importFailed'))
      setFileLoading(false)
    }
  }, [onImport, t])

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
      setUrlError(e.message || t('urlImportFailed'))
      setUrlLoading(false)
    }
  }, [url, onImport, t])

  return (
    <ModalShell isOpen={true} onClose={onClose} maxWidth={620}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('title')}</h2>
        <CloseButton onClick={onClose} />
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
            {tab === 'file' ? t('fileUpload') : t('fromUrl')}
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
            <div className={styles.dropZoneText}>{t('dropZone')}</div>
            <div className={styles.dropZoneSub}>{t('dropZoneSub')}</div>
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
          {fileLoading && <div className={styles.status}>{t('importing')}</div>}
        </div>
      )}

      {/* From URL */}
      {activeTab === 'url' && (
        <div className={styles.body}>
          {urlError && <div className={styles.error}>{urlError}</div>}
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('urlLabel')}</label>
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
          <Button
            variant="primary"
            disabled={!url.trim() || urlLoading}
            onClick={handleUrlImport}
          >
            {urlLoading ? t('importing') : tc('actions.import')}
          </Button>
        </div>
      )}

      <div className={styles.footer}>
        <Button variant="ghost" onClick={onClose}>
          {tc('actions.close')}
        </Button>
      </div>
    </ModalShell>
  )
}
