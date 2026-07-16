import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import styles from './RegexImportModal.module.css'
import clsx from 'clsx'

export default function RegexImportModal() {
  const { t } = useTranslation('modals', { keyPrefix: 'regexImport' })
  const { t: tc } = useTranslation('common')

  const closeModal = useStore((s) => s.closeModal)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)

  const [tab, setTab] = useState<'file' | 'paste'>('file')
  const [pasteContent, setPasteContent] = useState('')
  const [dragging, setDragging] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const doImport = useCallback(async (data: any) => {
    setImporting(true)
    try {
      // Pass the active preset so overwriting a bound regex can update its
      // enabled state without losing or invalidating that binding.
      const res = await regexApi.importScripts(data, activeLoomPresetId)
      setResult(res)
      if (res.imported > 0) {
        await loadRegexScripts()
        toast.success(t('importedCount', { count: res.imported }))
      }
      if (res.errors.length > 0) {
        toast.error(t('errorsDuringImport', { count: res.errors.length }))
      }
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('invalidJsonContent'))
    } finally {
      setImporting(false)
    }
  }, [activeLoomPresetId, loadRegexScripts, t])

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    try {
      const parsed = JSON.parse(text)
      await doImport(parsed)
    } catch {
      toast.error(t('invalidJsonFile'))
    }
  }, [doImport, t])

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
      toast.error(t('invalidJsonContent'))
    }
  }, [pasteContent, doImport, t])

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={520} maxHeight="80vh">
      <div className={styles.header}>
        <h2 className={styles.title}>{t('title')}</h2>
        <CloseButton onClick={closeModal} />
      </div>

      <div className={styles.body}>
        <div className={styles.tabs}>
          <button className={clsx(styles.tab, tab === 'file' && styles.tabActive)} onClick={() => setTab('file')}>
            {t('fileUpload')}
          </button>
          <button className={clsx(styles.tab, tab === 'paste' && styles.tabActive)} onClick={() => setTab('paste')}>
            {t('pasteJson')}
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
            <p>{t('dropZone')}</p>
            <p>{t('formatsHint')}</p>
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
              placeholder={t('pastePlaceholder')}
              rows={8}
            />
            <Button
              variant="primary"
              onClick={handlePasteImport}
              disabled={importing || !pasteContent.trim()}
            >
              {importing ? t('importing') : tc('actions.import')}
            </Button>
          </>
        )}

        {result && (
          <div className={styles.result}>
            <p>{t('resultSummary', { imported: result.imported, skipped: result.skipped })}</p>
            {result.errors.length > 0 && (
              <div className={styles.resultError}>
                {result.errors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" onClick={closeModal}>{tc('actions.close')}</Button>
      </div>
    </ModalShell>
  )
}
