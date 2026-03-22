import { FileUp } from 'lucide-react'
import styles from './DragDropOverlay.module.css'

interface DragDropOverlayProps {
  visible: boolean
}

export default function DragDropOverlay({ visible }: DragDropOverlayProps) {
  if (!visible) return null

  return (
    <div className={styles.overlay}>
      <div className={styles.content}>
        <FileUp size={32} />
        <span className={styles.text}>Drop character files to import</span>
        <span className={styles.hint}>.json, .png, .charx</span>
      </div>
    </div>
  )
}
