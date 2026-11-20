import { useCallback, useMemo } from 'react'
import { Download, Upload } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { validateCSS, sanitizeCSS } from '@/lib/cssValidator'
import CSSEditor from './CSSEditor'
import ModuleBrowser from './ModuleBrowser'
import styles from './CustomCSSPanel.module.css'
import clsx from 'clsx'

export default function CustomCSSPanel() {
  const { t } = useTranslation('panels', { keyPrefix: 'customCssPanel' })
  const customCSS = useStore((s) => s.customCSS)
  const setCustomCSS = useStore((s) => s.setCustomCSS)
  const toggleCustomCSS = useStore((s) => s.toggleCustomCSS)

  const handleToggle = useCallback(() => {
    toggleCustomCSS(!customCSS.enabled)
  }, [toggleCustomCSS, customCSS.enabled])

  const handleChange = useCallback((css: string) => {
    setCustomCSS(css)
  }, [setCustomCSS])

  const handleInsertSelector = useCallback((selector: string) => {
    const newCSS = customCSS.css
      ? `${customCSS.css}\n${selector}`
      : selector
    setCustomCSS(newCSS)
  }, [customCSS.css, setCustomCSS])

  const validation = useMemo(() => {
    const css = customCSS.css.trim()
    if (!css) return { status: 'empty' as const }
    const sanitized = sanitizeCSS(css)
    const result = validateCSS(sanitized)
    if (result.valid) return { status: 'valid' as const }
    return { status: 'error' as const, error: result.error }
  }, [customCSS.css])

  const byteCount = useMemo(() => {
    return new Blob([customCSS.css]).size
  }, [customCSS.css])

  const handleExport = useCallback(() => {
    const blob = new Blob([customCSS.css], { type: 'text/css' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'lumiverse-custom.css'
    a.click()
    URL.revokeObjectURL(url)
  }, [customCSS.css])

  const handleImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.css'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const text = await file.text()
      setCustomCSS(text)
    }
    input.click()
  }, [setCustomCSS])

  return (
    <div className={styles.panel}>
      <div className={styles.toggleRow}>
        <span className={styles.toggleLabel}>{t('toggleLabel')}</span>
        <button
          type="button"
          className={clsx(styles.toggleSwitch, customCSS.enabled && styles.toggleSwitchOn)}
          onClick={handleToggle}
          aria-label={customCSS.enabled ? t('disableAria') : t('enableAria')}
        />
      </div>

      <ModuleBrowser onInsertSelector={handleInsertSelector} />

      <div className={styles.editorSection}>
        <div className={styles.sectionLabel}>{t('editor')}</div>
        <CSSEditor value={customCSS.css} onChange={handleChange} />
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.actionBtn} onClick={handleExport} title={t('exportTitle')}>
          <Download size={12} /> {t('export')}
        </button>
        <button type="button" className={styles.actionBtn} onClick={handleImport} title={t('importTitle')}>
          <Upload size={12} /> {t('import')}
        </button>
      </div>

      <div className={styles.statusBar}>
        <span>
          {validation.status === 'valid' && <span className={styles.statusValid}>{t('valid')}</span>}
          {validation.status === 'error' && (
            <span className={styles.statusError} title={validation.error}>
              {t('errorPrefix')} {validation.error}
            </span>
          )}
          {validation.status === 'empty' && <span className={styles.statusEmpty}>{t('empty')}</span>}
        </span>
        <span>{byteCount > 0 ? t('bytes', { count: byteCount }) : ''}</span>
      </div>

      <div className={styles.hint}>
        <Trans
          ns="panels"
          i18nKey="customCssPanel.hint"
          components={{
            code: <code />,
            shortcut: <span className={styles.shortcut} />,
          }}
        />
      </div>
    </div>
  )
}
