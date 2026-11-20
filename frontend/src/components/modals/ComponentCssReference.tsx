import { useTranslation } from 'react-i18next'
import { FileCode2 } from 'lucide-react'
import styles from './PropsReference.module.css'

interface ComponentCssReferenceProps {
  componentName: string
  cssContent: string
}

export default function ComponentCssReference({ componentName, cssContent }: ComponentCssReferenceProps) {
  const { t } = useTranslation('modals', { keyPrefix: 'componentCssReference' })

  const componentSelector = `[data-component="${componentName}"]`

  const classMatches = Array.from(cssContent.matchAll(/\.([a-zA-Z0-9_-]+)/g))
  const uniqueClasses = Array.from(new Set(classMatches.map(m => m[1])))

  const varMatches = Array.from(cssContent.matchAll(/(--[a-zA-Z0-9_-]+)/g))
  const uniqueVars = Array.from(new Set(varMatches.map(m => m[1])))

  if (uniqueClasses.length === 0 && uniqueVars.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <FileCode2 size={13} />
            {t('title')}
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            {t('empty', { name: componentName })}
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
          {t('titleWithCount', { count: uniqueClasses.length + uniqueVars.length })}
        </span>
      </div>
      <div className={styles.list}>
        <div className={styles.group}>
          <span className={styles.categoryTitle}>{t('componentRoot')}</span>
          <div className={styles.propRow}>
            <div className={styles.propHeader}>
              <span className={styles.propName}>{componentSelector}</span>
            </div>
            <div className={styles.propDesc}>
              {t('scopeHint', { name: componentName })}
            </div>
          </div>
        </div>

        {uniqueVars.length > 0 && (
          <div className={styles.group}>
            <span className={styles.categoryTitle}>{t('variablesToOverride')}</span>
            {uniqueVars.map((varName) => (
              <div key={varName} className={styles.propRow}>
                <div className={styles.propHeader}>
                  <span className={styles.propName}>{varName}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {uniqueClasses.length > 0 && (
          <div className={styles.group}>
            <span className={styles.categoryTitle}>{t('sourceClasses')}</span>
            <div className={styles.propDesc} style={{ marginBottom: 8 }}>
              {t('hashedHint')}
            </div>
            {uniqueClasses.map((className) => (
              <div key={className} className={styles.propRow}>
                <div className={styles.propHeader}>
                  <span className={styles.propName}>.{className}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
