import { useTranslation } from 'react-i18next'
import { Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useContextualTitle } from '@/hooks/useContextualTitle'
import styles from './DesktopPwaTitlebar.module.css'

export default function DesktopPwaTitlebar() {
  const { t } = useTranslation('common')
  const context = useContextualTitle()
  const title = context || t('appName')
  const isTauriDesktop = '__TAURI_INTERNALS__' in window

  // These controls are deliberately first-party rather than theme-supplied.
  // A theme can style the buttons, but cannot gain native-window authority.
  const minimize = () => {
    if (!isTauriDesktop) return
    void getCurrentWindow().minimize().catch((error) => console.warn('[titlebar] minimize failed:', error))
  }

  const toggleMaximize = () => {
    if (!isTauriDesktop) return
    void getCurrentWindow().toggleMaximize().catch((error) => console.warn('[titlebar] toggle maximize failed:', error))
  }

  const close = () => {
    if (!isTauriDesktop) return
    // The desktop host intercepts CloseRequested and hides this window back
    // to the tray, so this does not terminate the companion application.
    void getCurrentWindow().close().catch((error) => console.warn('[titlebar] close failed:', error))
  }

  return (
    <div className={styles.titlebar} data-component="DesktopPwaTitlebar">
      <div
        className={styles.dragRegion}
        data-part="drag-region"
        data-tauri-drag-region={isTauriDesktop ? 'deep' : undefined}
        onDoubleClick={toggleMaximize}
      >
        <div className={styles.brandMark} />
        <span className={styles.title}>{title}</span>
      </div>
      {isTauriDesktop && (
        <div className={styles.windowControls} data-part="window-controls" aria-label="Window controls">
          <button type="button" className={styles.windowControl} data-part="minimize" onClick={minimize} aria-label="Minimize window" title="Minimize">
            <Minus size={15} strokeWidth={2} />
          </button>
          <button type="button" className={styles.windowControl} data-part="maximize" onClick={toggleMaximize} aria-label="Maximize or restore window" title="Maximize or restore">
            <Square size={12} strokeWidth={2} />
          </button>
          <button type="button" className={`${styles.windowControl} ${styles.closeControl}`} data-part="close" onClick={close} aria-label="Close window" title="Close to tray">
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  )
}
