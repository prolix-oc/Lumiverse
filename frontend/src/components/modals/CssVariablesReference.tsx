import { Palette } from 'lucide-react'
import GENERATED_VARS from '@/lib/generatedCssVariables'
import styles from './PropsReference.module.css'

export default function CssVariablesReference() {
  const vars = Object.entries(GENERATED_VARS)
  
  if (vars.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <Palette size={13} />
            CSS Variables
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            No variables found.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          <Palette size={13} />
          CSS Variables — {vars.length}
        </span>
      </div>
      <div className={styles.list}>
        {vars.map(([name, value]) => (
          <div key={name} className={styles.group}>
            <div className={styles.propRow}>
              <div className={styles.propHeader}>
                <span className={styles.propName}>{name}</span>
              </div>
              <span className={styles.propDesc} style={{ fontFamily: 'var(--lumiverse-font-mono)', opacity: 0.8 }}>{value}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
