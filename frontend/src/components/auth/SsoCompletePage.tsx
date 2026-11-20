import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { publishSsoCompletion } from '@/lib/ssoPopup'
import styles from './LoginPage.module.css'

function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/')) return '/'
  try {
    const url = new URL(value, window.location.origin)
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/'
  } catch {
    return '/'
  }
}

function closeCompletionWindow() {
  if (hasTauriDesktopBridge()) {
    // A Tauri window.open target is a native WebviewWindow, which browser
    // window.close() does not consistently destroy on every platform. The
    // native command is deliberately restricted to the invoking SSO popup.
    void invoke('close_current_sso_popup').catch(() => window.close())
    return
  }
  window.close()
}

export default function SsoCompletePage() {
  const [canClose, setCanClose] = useState(false)
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const flow = params.get('flow') === 'link' ? 'link' : 'login'
  const providerId = params.get('provider') || ''
  const flowId = params.get('flowId') || ''
  const returnTo = sanitizeReturnTo(params.get('returnTo'))
  const error = params.get('error') || params.get('error_description') || ''
  const redirect = params.get('mode') === 'redirect'

  useEffect(() => {
    if (!providerId || !flowId) return
    if (redirect) {
      // Same-window authorization has no opener to notify or window to close.
      // Keep provider errors visible so a rejected login does not disappear.
      if (!error) window.location.replace(returnTo)
      return
    }
    publishSsoCompletion({ flow, providerId, flowId, ok: !error, error: error || undefined })
    const timer = window.setTimeout(() => {
      setCanClose(true)
      closeCompletionWindow()
      if (!window.opener) window.location.replace(returnTo)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [error, flow, flowId, providerId, returnTo, redirect])

  return (
    <div className={styles.checking} role="status" aria-live="polite">
      <div className={styles.ssoCompleteCard}>
        <div className={styles.checkingSpinner} />
        <h1 className={styles.ssoCompleteTitle}>{error ? 'SSO needs attention' : 'SSO complete'}</h1>
        <p className={styles.ssoCompleteText}>
          {error || (canClose ? 'You can close this window and return to Lumiverse.' : 'Returning you to Lumiverse...')}
        </p>
        {canClose && <button className={styles.ssoBtn} onClick={closeCompletionWindow}>Close window</button>}
        {redirect && error && <button className={styles.ssoBtn} onClick={() => window.location.replace(returnTo)}>Return to Lumiverse</button>}
      </div>
    </div>
  )
}
