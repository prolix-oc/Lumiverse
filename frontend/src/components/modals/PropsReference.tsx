import { useState } from 'react'
import { ChevronRight, BookOpen } from 'lucide-react'
import type { PropDoc } from '@/lib/componentTemplates'
import styles from './PropsReference.module.css'
import clsx from 'clsx'

interface PropsReferenceProps {
  props: PropDoc[]
  componentName: string
}

export default function PropsReference({ props, componentName }: PropsReferenceProps) {
  const [isOpen, setIsOpen] = useState(true)

  if (props.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header} onClick={() => setIsOpen(!isOpen)}>
          <span className={styles.headerLabel}>
            <BookOpen size={12} />
            Props Reference
            <ChevronRight size={11} className={clsx(styles.chevron, isOpen && styles.chevronOpen)} />
          </span>
        </div>
        {isOpen && (
          <div className={styles.list}>
            <div className={styles.emptyNote}>
              No curated props reference for {componentName}. Use console.log(props) to inspect.
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header} onClick={() => setIsOpen(!isOpen)}>
        <span className={styles.headerLabel}>
          <BookOpen size={12} />
          Props Reference — {props.length} top-level
          <ChevronRight size={11} className={clsx(styles.chevron, isOpen && styles.chevronOpen)} />
        </span>
      </div>
      {isOpen && (
        <div className={styles.list}>
          {props.map((prop) => (
            <div key={prop.name} className={styles.group}>
              <div className={styles.propRow}>
                <span className={styles.propName}>{prop.name}</span>
                <span className={styles.propType}>{prop.type}</span>
                <span className={styles.propDesc}>{prop.description}</span>
              </div>
              {prop.children?.map((child) => (
                <div key={child.name} className={clsx(styles.propRow, styles.childRow)}>
                  <span className={styles.propName}>.{child.name}</span>
                  <span className={styles.propType}>{child.type}</span>
                  <span className={styles.propDesc}>{child.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
