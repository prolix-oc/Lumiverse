import type { VisualAssetHintItem } from '../../lib/visual-studio-model'
import styles from './VisualAssetHintRow.module.css'

interface VisualAssetHintRowProps {
  items: VisualAssetHintItem[]
}

export function VisualAssetHintRow({ items }: VisualAssetHintRowProps) {
  return (
    <div className={styles.row} aria-label="Visual asset types">
      {items.map((item) => (
        <div key={item.id} className={styles.item} data-state={item.state}>
          <span className={styles.label}>{item.label}</span>
          {item.state === 'muted' && <span className={styles.hint}>Later</span>}
        </div>
      ))}
    </div>
  )
}
