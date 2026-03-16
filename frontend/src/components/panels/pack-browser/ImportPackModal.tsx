import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import {
  X, Upload, Box, User, Wrench, Settings, Palette, Zap,
  Check, Download, Loader2, RefreshCw,
} from 'lucide-react'
import { packsApi } from '@/api/packs'
import { transformLucidPack, normalizePackJson } from '@/utils/pack-transform'
import LazyImage from '@/components/shared/LazyImage'
import type { PackWithItems } from '@/types/api'
import styles from './PackBrowser.module.css'
import clsx from 'clsx'

type ImportTab = 'file' | 'url' | 'lucid'

// Lucid Cards category tabs — mirrors extension's TABS config
const LUCID_TABS = [
  { id: 'Lumia DLCs', label: 'Lumia DLCs', Icon: User },
  { id: 'Loom Utilities', label: 'Utilities', Icon: Wrench },
  { id: 'Loom Retrofits', label: 'Retrofits', Icon: Settings },
  { id: 'Loom Narratives', label: 'Narratives', Icon: Palette },
  { id: 'Council Tools', label: 'Tools', Icon: Zap },
] as const

// Maps tab IDs to their API count field — mirrors extension's TAB_TO_COUNT_FIELD
const TAB_TO_COUNT_FIELD: Record<string, string> = {
  'Loom Utilities': 'loomUtilityCount',
  'Loom Retrofits': 'loomRetrofitCount',
  'Loom Narratives': 'narrativeStyleCount',
  'Council Tools': 'loomToolCount',
}

interface Props {
  onImport: (pack: PackWithItems) => void
  onClose: () => void
}

export default function ImportPackModal({ onImport, onClose }: Props) {
  const [activeImportTab, setActiveImportTab] = useState<ImportTab>('file')

  // File / URL state
  const [url, setUrl] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [urlLoading, setUrlLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Lucid Cards state
  const [lucidTab, setLucidTab] = useState('Lumia DLCs')
  const [lucidLoading, setLucidLoading] = useState(false)
  const [lucidError, setLucidError] = useState<string | null>(null)
  const [allPacks, setAllPacks] = useState<any[]>([])
  const [selectedPacks, setSelectedPacks] = useState<any[]>([])
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 })
  const [importResult, setImportResult] = useState<{ imported: number; failed: number } | null>(null)

  // Filter packs by current Lucid tab — mirrors extension logic exactly
  const filteredLucidPacks = allPacks.filter((pack) => {
    if (lucidTab === 'Lumia DLCs') {
      return pack.packType === 'lumia' || (pack.lumiaCount && pack.lumiaCount > 0)
    }
    const countField = TAB_TO_COUNT_FIELD[lucidTab]
    if (countField) {
      return pack[countField] && pack[countField] > 0
    }
    return pack.packType === 'loom' || (pack.loomCount && pack.loomCount > 0)
  })

  const fetchLucidCards = useCallback(async () => {
    setLucidLoading(true)
    setLucidError(null)
    setSelectedPacks([])
    setImportResult(null)
    try {
      const res = await fetch('https://lucid.cards/api/lumia-dlc')
      if (!res.ok) throw new Error(`HTTP error: ${res.status}`)
      const data = await res.json()
      setAllPacks(data.packs || [])
    } catch (err: any) {
      setLucidError(err.message || 'Failed to load Lucid Cards catalog')
    } finally {
      setLucidLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeImportTab === 'lucid' && allPacks.length === 0 && !lucidLoading && !lucidError) {
      fetchLucidCards()
    }
  }, [activeImportTab, allPacks.length, lucidLoading, lucidError, fetchLucidCards])

  // Multi-select helpers
  const toggleSelection = useCallback((pack: any) => {
    setSelectedPacks((prev) => {
      const exists = prev.find((p) => p.slug === pack.slug)
      return exists ? prev.filter((p) => p.slug !== pack.slug) : [...prev, pack]
    })
  }, [])

  const isSelected = useCallback(
    (pack: any) => selectedPacks.some((p) => p.slug === pack.slug),
    [selectedPacks]
  )

  const selectAll = useCallback(() => setSelectedPacks(filteredLucidPacks), [filteredLucidPacks])
  const clearSelection = useCallback(() => setSelectedPacks([]), [])

  // Batch import — fetches each pack directly from lucid.cards, transforms, sends to backend
  const handleLucidImport = useCallback(async () => {
    if (selectedPacks.length === 0 || importing) return
    setImporting(true)
    setImportResult(null)
    const total = selectedPacks.length
    let imported = 0
    let failed = 0
    let lastImportedPack: PackWithItems | null = null

    for (let i = 0; i < selectedPacks.length; i++) {
      const catalogEntry = selectedPacks[i]
      setImportProgress({ current: i + 1, total })
      try {
        const res = await fetch(`https://lucid.cards/api/lumia-dlc/${catalogEntry.slug}`)
        if (!res.ok) throw new Error(`HTTP error: ${res.status}`)
        const data = await res.json()
        if (data.success === false) throw new Error(data.error || 'Pack not found')

        const packData = data.pack || data
        const payload = transformLucidPack(packData, catalogEntry)
        const pack = await packsApi.importJson(payload)
        imported++
        lastImportedPack = pack
      } catch {
        failed++
      }
    }

    setImporting(false)
    setSelectedPacks([])
    setImportProgress({ current: 0, total: 0 })
    setImportResult({ imported, failed })

    // Call after loop completes so modal stays open during the full batch
    if (lastImportedPack) onImport(lastImportedPack)
  }, [selectedPacks, importing, onImport])

  // File import — unwrap { pack: {...} } wrapper if present (extension export format)
  const handleFile = useCallback(async (file: File) => {
    setFileError(null)
    setFileLoading(true)
    try {
      const text = await file.text()
      const raw = JSON.parse(text)
      const payload = normalizePackJson(raw)
      const pack = await packsApi.importJson(payload)
      onImport(pack)
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
      const pack = await packsApi.importUrl(url.trim())
      onImport(pack)
    } catch (e: any) {
      setUrlError(e.message || 'Failed to import from URL')
      setUrlLoading(false)
    }
  }, [url, onImport])

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <motion.div
        className={clsx(styles.modal, styles.modalLarge)}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
      >
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Import Pack</h2>
          <button type="button" className={styles.modalCloseBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Import method tabs */}
        <div className={styles.tabs}>
          {(['file', 'url', 'lucid'] as ImportTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={clsx(styles.tab, activeImportTab === tab && styles.tabActive)}
              onClick={() => setActiveImportTab(tab)}
            >
              {tab === 'file' ? 'File Upload' : tab === 'url' ? 'From URL' : 'Lucid Cards'}
            </button>
          ))}
        </div>

        {/* File Upload */}
        {activeImportTab === 'file' && (
          <div className={styles.modalBody}>
            {fileError && <div className={styles.importError}>{fileError}</div>}
            <div
              className={clsx(styles.dropZone, isDragging && styles.dropZoneActive)}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={24} style={{ margin: '0 auto 8px', opacity: 0.5, display: 'block' }} />
              <div className={styles.dropZoneText}>Drop a JSON file here or click to browse</div>
              <div className={styles.dropZoneSub}>Supports native pack format and extension format</div>
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
            {fileLoading && <div className={styles.importStatus}>Importing...</div>}
          </div>
        )}

        {/* From URL */}
        {activeImportTab === 'url' && (
          <div className={styles.modalBody}>
            {urlError && <div className={styles.importError}>{urlError}</div>}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Pack URL</label>
              <input
                type="text"
                className={styles.fieldInput}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/pack.json"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleUrlImport()}
              />
            </div>
            <button
              type="button"
              className={styles.btnSave}
              disabled={!url.trim() || urlLoading}
              onClick={handleUrlImport}
            >
              {urlLoading ? 'Importing...' : 'Import'}
            </button>
          </div>
        )}

        {/* Lucid Cards browser */}
        {activeImportTab === 'lucid' && (
          <>
            {/* Category tabs */}
            <div className={styles.lucidCategoryTabs}>
              {LUCID_TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={clsx(styles.lucidCategoryTab, lucidTab === id && styles.lucidCategoryTabActive)}
                  onClick={() => { setLucidTab(id); setSelectedPacks([]) }}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* Pack grid */}
            <div className={styles.lucidScrollArea}>
              {lucidLoading ? (
                <div className={styles.lucidStateCenter}>
                  <Loader2 size={22} className={styles.lucidSpinner} />
                  <span>Loading content from Lucid.cards...</span>
                </div>
              ) : lucidError ? (
                <div className={styles.lucidStateCenter}>
                  <X size={28} style={{ color: '#f44336' }} />
                  <span className={styles.lucidErrorText}>{lucidError}</span>
                  <button type="button" className={styles.lucidRetryBtn} onClick={fetchLucidCards}>
                    <RefreshCw size={13} />
                    Retry
                  </button>
                </div>
              ) : filteredLucidPacks.length === 0 ? (
                <div className={styles.lucidStateCenter}>
                  No items available in this category.
                </div>
              ) : (
                <div className={styles.lucidCardGrid}>
                  {filteredLucidPacks.map((pack) => {
                    const selected = isSelected(pack)
                    const counts: string[] = []
                    if (pack.lumiaCount > 0) counts.push(`${pack.lumiaCount} Lumia`)
                    if (pack.loomCount > 0) counts.push(`${pack.loomCount} Loom`)
                    if (pack.extrasCount > 0) counts.push(`${pack.extrasCount} Extra`)

                    return (
                      <div
                        key={pack.slug}
                        className={clsx(styles.lucidCard, selected && styles.lucidCardSelected)}
                        onClick={() => toggleSelection(pack)}
                      >
                        <div className={styles.lucidCardImage}>
                          <LazyImage
                            src={pack.coverUrl}
                            alt=""
                            containerClassName={styles.lucidCardImg}
                            fallback={<Box size={28} style={{ color: 'var(--lumiverse-text-muted)' }} />}
                            spinnerSize={18}
                          />
                          <div className={clsx(styles.lucidCardCheck, selected && styles.lucidCardCheckVisible)}>
                            <Check size={13} />
                          </div>
                        </div>
                        <div className={styles.lucidCardInfo}>
                          <div className={styles.lucidCardTitle}>{pack.packName || 'Unknown'}</div>
                          <div className={styles.lucidCardAuthor}>{pack.packAuthor || 'Unknown Author'}</div>
                          {counts.length > 0 && (
                            <div className={styles.lucidCardCounts}>{counts.join(', ')}</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Import result */}
            {importResult && (
              <div className={clsx(styles.importStatus, importResult.failed > 0 && styles.importStatusWarn)}>
                Import complete: {importResult.imported} imported
                {importResult.failed > 0 && `, ${importResult.failed} failed`}
              </div>
            )}

            {/* Lucid Cards footer */}
            <div className={styles.lucidFooter}>
              <button
                type="button"
                className={styles.btnCancel}
                onClick={onClose}
              >
                Close
              </button>

              <div className={styles.lucidFooterRight}>
                {selectedPacks.length > 0 && (
                  <>
                    <button type="button" className={styles.lucidFooterLink} onClick={selectAll}>
                      Select All
                    </button>
                    <button type="button" className={styles.lucidFooterLink} onClick={clearSelection}>
                      Clear
                    </button>
                    <span className={styles.lucidSelectedCount}>
                      {selectedPacks.length} selected
                    </span>
                  </>
                )}
                {selectedPacks.length > 0 && (
                  <button
                    type="button"
                    className={clsx(styles.btnSave, styles.lucidImportBtn)}
                    disabled={importing}
                    onClick={handleLucidImport}
                  >
                    {importing ? (
                      <>
                        <Loader2 size={13} className={styles.lucidSpinner} />
                        Importing {importProgress.current}/{importProgress.total}...
                      </>
                    ) : (
                      <>
                        <Download size={13} />
                        Import {selectedPacks.length === 1 ? 'Pack' : `${selectedPacks.length} Packs`}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Footer for file/url tabs */}
        {activeImportTab !== 'lucid' && (
          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnCancel} onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {/* Spinner keyframe */}
        <style>{`@keyframes lv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </motion.div>
    </div>,
    document.body
  )
}
