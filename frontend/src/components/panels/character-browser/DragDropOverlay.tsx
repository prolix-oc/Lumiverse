import { FileUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styles from './DragDropOverlay.module.css'

interface DragDropOverlayProps {
  visible: boolean
}

export default function DragDropOverlay({ visible }: DragDropOverlayProps) {
  const { t } = useTranslation('panels')
  if (!visible) return null

  return (
    <div className={styles.overlay}>
      <div className={styles.content}>
        <FileUp size={32} />
        <span className={styles.text}>{t('characterBrowser.dropToImport')}</span>
        <span className={styles.hint}>{t('characterBrowser.dropFileTypes')}</span>
      </div>
    </div>
  )
}
