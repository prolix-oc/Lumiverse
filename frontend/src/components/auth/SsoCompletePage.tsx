import { useEffect, useMemo, useState } from 'react'
import { publishSsoCompletion } from '@/lib/ssoPopup'
import styles from './LoginPage.module.css'

function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  return value
}

export default function SsoCompletePage() {
  const [canClose, setCanClose] = useState(false)
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const flow = params.get('flow') === 'link' ? 'link' : 'login'
  const providerId = params.get('provider') || ''
  const flowId = params.get('flowId') || ''
  const returnTo = sanitizeReturnTo(params.get('returnTo'))
  const error = params.get('error') || params.get('error_description') || ''

  useEffect(() => {
    if (!providerId || !flowId) return
    publishSsoCompletion({ flow, providerId, flowId, ok: !error, error: error || undefined })
    const timer = window.setTimeout(() => {
      setCanClose(true)
      window.close()
      if (!window.opener) window.location.replace(returnTo)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [error, flow, flowId, providerId, returnTo])

  return (
    <div className={styles.checking} role="status" aria-live="polite">
      <div className={styles.ssoCompleteCard}>
        <div className={styles.checkingSpinner} />
        <h1 className={styles.ssoCompleteTitle}>{error ? 'SSO needs attention' : 'SSO complete'}</h1>
        <p className={styles.ssoCompleteText}>
          {error || (canClose ? 'You can close this window and return to Lumiverse.' : 'Returning you to Lumiverse...')}
        </p>
        {canClose && <button className={styles.ssoBtn} onClick={() => window.close()}>Close window</button>}
      </div>
    </div>
  )
}
