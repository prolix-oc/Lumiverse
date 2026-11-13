import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ModalShell } from '@/components/shared/ModalShell'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'
import {
  clearWindowFileImports,
  detectWindowFileImportKind,
  queueWindowFileImport,
  supportedWindowImportFiles,
  type WindowFileImportKind,
} from '@/lib/window-file-import'
import styles from './WindowFileDropHost.module.css'

const IMPORT_TABS: Record<WindowFileImportKind, string> = {
  character: 'characters',
  preset: 'loom',
  worldbook: 'lorebook',
}

export default function WindowFileDropHost() {
  const { t } = useTranslation('common')
  const [dragging, setDragging] = useState(false)
  const [unclassifiedFiles, setUnclassifiedFiles] = useState<File[] | null>(null)

  const importFiles = useCallback((kind: WindowFileImportKind, files: File[]) => {
    useStore.getState().openDrawer(IMPORT_TABS[kind])
    queueWindowFileImport(kind, files)
    setUnclassifiedFiles(null)
  }, [])

  useEffect(() => {
    if (!hasTauriDesktopBridge()) return
    let dragDepth = 0
    let disposed = false

    const isFileDrag = (event: DragEvent) => {
      const types = event.dataTransfer?.types
      return types && (types.length === 0 || Array.from(types).includes('Files'))
    }
    const handleEnter = (event: DragEvent) => {
      if (event.defaultPrevented || !isFileDrag(event)) return
      dragDepth++
      setDragging(true)
    }
    const handleOver = (event: DragEvent) => {
      if (event.defaultPrevented || !isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const handleLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setDragging(false)
    }
    const handleDrop = (event: DragEvent) => {
      dragDepth = 0
      setDragging(false)
      if (event.defaultPrevented || !event.dataTransfer?.files.length) return
      event.preventDefault()
      const files = supportedWindowImportFiles(event.dataTransfer.files)
      if (files.length === 0) {
        toast.error(t('windowFileDrop.unsupported'))
        return
      }
      void detectWindowFileImportKind(files).then((kind) => {
        if (disposed) return
        if (kind) importFiles(kind, files)
        else setUnclassifiedFiles(files)
      })
    }

    window.addEventListener('dragenter', handleEnter)
    window.addEventListener('dragover', handleOver)
    window.addEventListener('dragleave', handleLeave)
    window.addEventListener('dragend', handleLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      disposed = true
      window.removeEventListener('dragenter', handleEnter)
      window.removeEventListener('dragover', handleOver)
      window.removeEventListener('dragleave', handleLeave)
      window.removeEventListener('dragend', handleLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [importFiles, t])

  useEffect(() => () => clearWindowFileImports(), [])

  return (
    <>
      {dragging && createPortal(
        <div className={styles.overlay} role="status">
          <FileUp size={36} />
          <span>{t('windowFileDrop.dropToImport')}</span>
        </div>,
        document.body,
      )}
      {unclassifiedFiles && (
        <ModalShell isOpen={true} onClose={() => setUnclassifiedFiles(null)} maxWidth={440}>
          <div className={styles.chooser}>
            <h2>{t('windowFileDrop.chooseDestination')}</h2>
            <p>{unclassifiedFiles.map((file) => file.name).join(', ')}</p>
            <div className={styles.actions}>
              <button type="button" onClick={() => importFiles('character', unclassifiedFiles)}>
                {t('windowFileDrop.characters')}
              </button>
              {unclassifiedFiles.every((file) => /\.json$/i.test(file.name)) && (
                <>
                  <button type="button" onClick={() => importFiles('preset', unclassifiedFiles)}>
                    {t('windowFileDrop.presets')}
                  </button>
                  <button type="button" onClick={() => importFiles('worldbook', unclassifiedFiles)}>
                    {t('windowFileDrop.worldBooks')}
                  </button>
                </>
              )}
            </div>
            <button type="button" className={styles.cancel} onClick={() => setUnclassifiedFiles(null)}>
              {t('actions.cancel')}
            </button>
          </div>
        </ModalShell>
      )}
    </>
  )
}
