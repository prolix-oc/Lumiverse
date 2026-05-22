import { BookOpen } from 'lucide-react'
import type { PropDoc } from '@/lib/componentTemplates'
import styles from './PropsReference.module.css'
import clsx from 'clsx'

interface PropsReferenceProps {
  props: PropDoc[]
  componentName: string
}

export default function PropsReference({ props, componentName }: PropsReferenceProps) {
  if (props.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <BookOpen size={13} />
            Props Reference
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            No configurable props for {componentName}.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          <BookOpen size={13} />
          Props Reference — {props.length}
        </span>
      </div>
      <div className={styles.list}>
        {props.map((prop) => (
          <div key={prop.name} className={styles.group}>
            <div className={styles.propRow}>
              <div className={styles.propHeader}>
                <span className={styles.propName}>{prop.name}</span>
                <span className={styles.propType}>{prop.type}</span>
              </div>
              {prop.description && prop.description !== 'No description' && (
                <span className={styles.propDesc}>{prop.description}</span>
              )}
            </div>
            {prop.children?.map((child) => (
              <div key={child.name} className={clsx(styles.propRow, styles.childRow)}>
                <div className={styles.propHeader}>
                  <span className={styles.propName}>{child.name}</span>
                  <span className={styles.propType}>{child.type}</span>
                </div>
                {child.description && child.description !== 'No description' && (
                  <span className={styles.propDesc}>{child.description}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
