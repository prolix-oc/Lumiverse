import { FileCode2 } from 'lucide-react'
import styles from './PropsReference.module.css'

interface ComponentCssReferenceProps {
  componentName: string
  cssContent: string
}

export default function ComponentCssReference({ componentName, cssContent }: ComponentCssReferenceProps) {
  const componentSelector = `[data-component="${componentName}"]`

  // Extract CSS class names (e.g. .card, .user, .avatarBg)
  const classMatches = Array.from(cssContent.matchAll(/\.([a-zA-Z0-9_-]+)/g))
  const uniqueClasses = Array.from(new Set(classMatches.map(m => m[1])))

  // Extract variables consumed by this component. Scoped variable overrides are
  // stable even when CSS module class names are hashed in the rendered DOM.
  const varMatches = Array.from(cssContent.matchAll(/(--[a-zA-Z0-9_-]+)/g))
  const uniqueVars = Array.from(new Set(varMatches.map(m => m[1])))

  if (uniqueClasses.length === 0 && uniqueVars.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <FileCode2 size={13} />
            CSS Selectors
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            No classes or variables found for {componentName}.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          <FileCode2 size={13} />
          CSS Context — {uniqueClasses.length + uniqueVars.length}
        </span>
      </div>
      <div className={styles.list}>
        <div className={styles.group}>
          <span className={styles.categoryTitle}>Component Root</span>
          <div className={styles.propRow}>
            <div className={styles.propHeader}>
              <span className={styles.propName}>{componentSelector}</span>
            </div>
            <div className={styles.propDesc}>
              Per-component CSS is applied globally. Scope selectors or variables to this root to target only {componentName}.
            </div>
          </div>
        </div>

        {uniqueVars.length > 0 && (
          <div className={styles.group} style={{ marginTop: 12 }}>
            <span className={styles.categoryTitle}>Variables To Override</span>
            <div className={styles.classesContainer}>
              {uniqueVars.map(v => (
                <div key={v} className={styles.propRow}>
                  <div className={styles.propHeader}>
                    <span className={styles.propName} style={{ paddingLeft: '8px' }}>{v}</span>
                  </div>
                  <div className={styles.propDesc} style={{ paddingLeft: '8px' }}>
                    {componentSelector} {'{'} {v}: ...; {'}'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {uniqueClasses.length > 0 && (
          <div className={styles.group} style={{ marginTop: 12 }}>
            <span className={styles.categoryTitle}>Source CSS Module Classes</span>
            <div className={styles.propDesc}>
              These names describe the source stylesheet, but rendered class names may be hashed. Prefer component-root variables when available.
            </div>
            <div className={styles.classesContainer}>
              {uniqueClasses.map(cls => (
                <div key={cls} className={styles.propRow}>
                  <div className={styles.propHeader}>
                    <span className={styles.propName} style={{ paddingLeft: '8px' }}>.{cls}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
