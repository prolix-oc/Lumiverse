import { useState } from 'react'
import { authClient } from '@/api/auth'
import styles from './LoginPage.module.css'

export default function OAuthConsentPage() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const params = new URLSearchParams(window.location.search)
  const clientName = params.get('client_name') || 'Lumiverse Desktop'
  const scopes = (params.get('scope') || '')
    .split(/\s+/)
    .filter((scope) => scope && !['openid', 'profile', 'offline_access'].includes(scope))

  const decide = async (accept: boolean) => {
    setBusy(true)
    setError(null)
    const { error: authError } = await authClient.oauth2.consent({ accept })
    if (authError) {
      setError(authError.message || 'Could not complete authorization.')
      setBusy(false)
    }
  }

  return (
    <div className={styles.checking}>
      <div className={styles.ssoCompleteCard}>
        <h1 className={styles.ssoCompleteTitle}>Connect {clientName}</h1>
        <p className={styles.ssoCompleteText}>
          This application is requesting read-only access to this Lumiverse instance.
        </p>
        {scopes.length > 0 && (
          <ul>
            {scopes.map((scope) => <li key={scope}>{scope}</li>)}
          </ul>
        )}
        {error && <p role="alert">{error}</p>}
        <div>
          <button className={styles.ssoBtn} disabled={busy} onClick={() => void decide(false)}>Deny</button>
          <button className={styles.ssoBtn} disabled={busy} onClick={() => void decide(true)}>Allow</button>
        </div>
      </div>
    </div>
  )
}
