import { useCallback, useMemo } from 'react'
import { Download, Upload } from 'lucide-react'
import { useStore } from '@/store'
import { validateCSS, sanitizeCSS } from '@/lib/cssValidator'
import CSSEditor from './CSSEditor'
import ModuleBrowser from './ModuleBrowser'
import styles from './CustomCSSPanel.module.css'
import clsx from 'clsx'

export default function CustomCSSPanel() {
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
      {/* Enable/disable toggle */}
      <div className={styles.toggleRow}>
        <span className={styles.toggleLabel}>Custom CSS</span>
        <button
          type="button"
          className={clsx(styles.toggleSwitch, customCSS.enabled && styles.toggleSwitchOn)}
          onClick={handleToggle}
          aria-label={customCSS.enabled ? 'Disable custom CSS' : 'Enable custom CSS'}
        />
      </div>

      {/* Module browser */}
      <ModuleBrowser onInsertSelector={handleInsertSelector} />

      {/* Editor */}
      <div className={styles.editorSection}>
        <div className={styles.sectionLabel}>Editor</div>
        <CSSEditor value={customCSS.css} onChange={handleChange} />
      </div>

      {/* Actions */}
      <div className={styles.actions}>
        <button type="button" className={styles.actionBtn} onClick={handleExport} title="Export CSS">
          <Download size={12} /> Export
        </button>
        <button type="button" className={styles.actionBtn} onClick={handleImport} title="Import CSS">
          <Upload size={12} /> Import
        </button>
      </div>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <span>
          {validation.status === 'valid' && <span className={styles.statusValid}>Valid</span>}
          {validation.status === 'error' && <span className={styles.statusError} title={validation.error}>Error: {validation.error}</span>}
          {validation.status === 'empty' && <span className={styles.statusEmpty}>Empty</span>}
        </span>
        <span>{byteCount > 0 ? `${byteCount.toLocaleString()} bytes` : ''}</span>
      </div>

      {/* Hint */}
      <div className={styles.hint}>
        Target components with <code>[data-component="Name"]</code> selectors.
        Emergency disable: <span className={styles.shortcut}>Ctrl+Shift+U</span>
      </div>
    </div>
  )
}
