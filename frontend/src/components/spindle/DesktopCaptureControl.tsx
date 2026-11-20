import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import styles from './SystemAudioConsentControl.module.css'

/** Setup only opens trusted desktop UI; approval and media stay native. */
export default function DesktopCaptureControl() {
  const { t } = useTranslation('shared')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  if (!hasTauriDesktopBridge()) return null
  return <div className={styles.control}>
    <div className={styles.description}>
      <span className={styles.title}>{t('spindle.desktopCapture.title', { defaultValue: 'Desktop screen capture' })}</span>
      <span>{error
        ? t('spindle.desktopCapture.failed', { defaultValue: 'Open the desktop tray to set up screen capture.' })
        : t('spindle.desktopCapture.description', { defaultValue: 'Enable screen capture in the desktop app. Your source stays available until you turn capture off.' })}</span>
    </div>
    <div className={styles.actions}><button type="button" disabled={busy} onClick={async () => {
      setBusy(true)
      setError(false)
      try { await invoke('desktop_capture_request_setup') }
      catch { setError(true) }
      finally { setBusy(false) }
    }}>{t('spindle.desktopCapture.setup', { defaultValue: 'Set Up Screen Capture' })}</button></div>
  </div>
}
