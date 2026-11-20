import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import { Button } from '@/components/shared/FormComponents'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getSafeHttpsUrl } from '@/lib/navigationSafety'
import { sectionAnchorId } from '@/lib/settings-tab-registry'
import sectionStyles from './SettingsSection.module.css'
import styles from '@/components/modals/SettingsModal.module.css'

const sectionTitleClass = clsx(sectionStyles.title, styles.sectionTitle)

export default function IllarinSettings() {
  const { t } = useTranslation(['settings', 'common', 'modals'])
  const user = useStore((s) => s.user)
  const defaultInstanceName = user?.name ? `${user.name}'s Lumiverse` : t('illarin.defaultInstance')
  const [illarinUrl, setIllarinUrl] = useState('https://illarin.com')
  const [instanceName, setInstanceName] = useState(defaultInstanceName)
  const [status, setStatus] = useState<{
    linked: boolean
    illarin_url?: string
    instance_name?: string
    instance_id?: string
    scopes?: string[]
    permission_error?: string | null
    pickup?: {
      state: 'starting' | 'running' | 'retrying' | 'missing_permission' | 'stopped'
      lastCollectAt: string | null
      lastInstallAt: string | null
      lastError: string | null
      lastErrorAt: string | null
    } | null
    linked_at?: string | null
    declaration_version?: string | null
    pending_link?: { status: 'pending' | 'linked' | 'failed'; reason?: string | null } | null
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState(false)
  const statusRef = useRef(status)
  useEffect(() => { statusRef.current = status }, [status])
  const [unlinking, setUnlinking] = useState(false)
  const [refreshingPermissions, setRefreshingPermissions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deviceCode, setDeviceCode] = useState<{ user_code: string; verification_url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [browserCode, setBrowserCode] = useState<string | null>(null)
  const [browserAuthorizationUrl, setBrowserAuthorizationUrl] = useState<string | null>(null)

  // Loopback browser linking only reaches the backend when the BROWSER runs
  // on the same machine as the server; otherwise fall back to device codes.
  const isLocalOrigin = ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname)
  const pollRef = useRef<{ timer?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> }>({})

  const stopPolling = useCallback(() => {
    clearInterval(pollRef.current.timer)
    clearTimeout(pollRef.current.timeout)
  }, [])
  useEffect(() => stopPolling, [stopPolling])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/illarin/status', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
        if (data.illarin_url) setIllarinUrl(data.illarin_url)
        if (data.instance_name) setInstanceName((current) => current || data.instance_name)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 10_000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const finishLinking = () => {
    stopPolling()
    setLinking(false)
    setDeviceCode(null)
    setBrowserCode(null)
    setBrowserAuthorizationUrl(null)
    fetchStatus()
  }

  const startDeviceFlow = async () => {
    try {
      const res = await fetch('/api/v1/illarin/link/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ illarin_url: illarinUrl.trim(), instance_name: instanceName.trim() || defaultInstanceName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as any).error || t('illarin.errLinkFailed'))
        setLinking(false)
        return false
      }
      const data = await res.json() as { user_code: string; verification_url: string; expires_at: string }
      const verificationUrl = getSafeHttpsUrl(data.verification_url)
      if (!verificationUrl || !data.user_code) {
        setError(t('illarin.errLinkFailed'))
        setLinking(false)
        return false
      }
      setDeviceCode({ user_code: data.user_code, verification_url: verificationUrl })
      // Poll respecting the server-enforced interval; give up at expiry.
      pollRef.current.timer = setInterval(async () => {
        try {
          const check = await fetch('/api/v1/illarin/link/device/status', { credentials: 'include' })
          if (!check.ok) return
          const checkData = await check.json() as { status: string }
          if (checkData.status === 'linked') finishLinking()
          else if (checkData.status !== 'pending') {
            setError(t('illarin.errLinkFailed'))
            finishLinking()
          }
        } catch {
          // A transient status failure should not cancel the device session.
        }
      }, 3000)
      pollRef.current.timeout = setTimeout(finishLinking, 10 * 60 * 1000)
      return true
    } catch (err: any) {
      setError(err.message || t('illarin.errConnectFailed'))
      setLinking(false)
      return false
    }
  }

  const handleLink = async () => {
    if (!illarinUrl.trim()) {
      setError(t('illarin.errUrl'))
      return
    }

    // Show the code first. Opening the page is a separate user gesture so
    // native WebViews cannot cover the code before it can be copied.
    setCopied(false)
    setError(null)
    setLinking(true)
    setBrowserCode(null)
    setBrowserAuthorizationUrl(null)
    if (!isLocalOrigin) {
      await startDeviceFlow()
      return
    }
    try {
      const res = await fetch('/api/v1/illarin/link/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ illarin_url: illarinUrl.trim(), instance_name: instanceName.trim() || defaultInstanceName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as any).error || t('illarin.errLinkFailed'))
        setLinking(false)
        return
      }
      const data = await res.json() as { authorize_url?: string; user_code?: string }
      if (!data.user_code) {
        setError(t('illarin.errLinkFailed'))
        setLinking(false)
        return
      }
      setBrowserCode(data.user_code)
      const authorizationUrl = getSafeHttpsUrl(data.authorize_url)
      if (!authorizationUrl) {
        setError(t('illarin.errLinkFailed'))
        setLinking(false)
        setBrowserCode(null)
        return
      }

      setBrowserAuthorizationUrl(authorizationUrl)

      // Backend listens on loopback while the authorization page is open.
      pollRef.current.timer = setInterval(async () => {
        await fetchStatus()
        if (statusRef.current?.linked || statusRef.current?.pending_link?.status === 'failed') {
          if (statusRef.current?.pending_link?.status === 'failed' && !statusRef.current.linked) {
            setError(t('illarin.errLinkFailed'))
            stopPolling()
            setLinking(false)
            setBrowserCode(null)
            setBrowserAuthorizationUrl(null)
          } else {
            finishLinking()
          }
        }
      }, 2000)
      pollRef.current.timeout = setTimeout(finishLinking, 5 * 60 * 1000)
    } catch (err: any) {
      setError(err.message || t('illarin.errConnectFailed'))
      setLinking(false)
      setBrowserCode(null)
      setBrowserAuthorizationUrl(null)
    }
  }

  const handleDeviceLink = () => {
    if (!illarinUrl.trim()) {
      setError(t('illarin.errUrl'))
      return
    }
    setCopied(false)
    setError(null)
    setLinking(true)
    void startDeviceFlow()
  }

  const copyCode = async (code: string) => {
    try {
      await copyTextToClipboard(code)
      setCopied(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleUnlink = async () => {
    setUnlinking(true)
    try {
      await fetch('/api/v1/illarin/unlink', { method: 'POST', credentials: 'include' })
      setStatus((prev) => (prev ? { ...prev, linked: false } : { linked: false }))
    } catch {
      setError(t('illarin.errUnlinkFailed'))
    } finally {
      setUnlinking(false)
    }
  }

  const handleRefreshPermissions = async () => {
    setRefreshingPermissions(true)
    setError(null)
    try {
      const response = await fetch('/api/v1/illarin/permissions/refresh', { method: 'POST', credentials: 'include' })
      if (!response.ok) throw new Error(t('illarin.errRefreshPermissions'))
      await fetchStatus()
    } catch {
      setError(t('illarin.errRefreshPermissions'))
      await fetchStatus()
    } finally {
      setRefreshingPermissions(false)
    }
  }

  const pickupStateLabel = status?.pickup
    ? t(`illarin.pickupState.${status.pickup.state}`)
    : t('illarin.pickupState.stopped')

  if (loading) {
    return (
      <div className={styles.settingsSection}>
        <h3 id={sectionAnchorId('illarin', 'general')} className={sectionTitleClass}>{t('illarin.title')}</h3>
        <span className={styles.helperText}>{t('illarin.loading')}</span>
      </div>
    )
  }

  return (
    <div className={styles.settingsSection}>
      <h3 id={sectionAnchorId('illarin', 'general')} className={sectionTitleClass}>{t('illarin.title')}</h3>
      <span className={styles.helperText}>{t('illarin.helper')}</span>

      {status?.linked ? (
        <div className={styles.lumihubCard}>
          <div className={styles.lumihubStatusRow}>
            <span className={clsx(styles.lumihubDot, styles.lumihubDotOnline)} />
            <span className={styles.lumihubStatusText}>
              {t('illarin.linkedAs', { name: status.instance_name })}
            </span>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('illarin.url')}</span>
            <span className={styles.lumihubMeta}>{status.illarin_url}</span>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('illarin.instanceIdLabel')}</span>
            <span className={styles.lumihubMeta}>{status.instance_id}</span>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('illarin.scopesLabel')}</span>
            <span className={styles.lumihubMeta}>{(status.scopes ?? []).join(', ') || t('illarin.noPermissions')}</span>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('illarin.pickupLabel')}</span>
            <span className={styles.lumihubMeta}>{pickupStateLabel}</span>
          </div>

          {status.pickup?.lastCollectAt && (
            <span className={styles.lumihubMeta}>
              {t('illarin.lastCollect', { time: new Date(status.pickup.lastCollectAt).toLocaleString() })}
            </span>
          )}

          {status.pickup?.lastError && status.pickup.state !== 'missing_permission' && (
            <span className={styles.helperText}>
              {t('illarin.lastPickupError', { error: status.pickup.lastError })}
            </span>
          )}

          {status.permission_error && (
            <span className={styles.helperText}>{t('illarin.permissionOff', { permission: status.permission_error })}</span>
          )}

          <Button variant="ghost" size="sm" onClick={handleRefreshPermissions} disabled={refreshingPermissions} loading={refreshingPermissions}>
            {t('illarin.refreshPermissions')}
          </Button>

          {error && <span className={styles.helperText} style={{ color: 'var(--lumiverse-danger)' }}>{error}</span>}

          {status.declaration_version && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('illarin.versionLabel')}</span>
              <span className={styles.lumihubMeta}>v{status.declaration_version}</span>
            </div>
          )}

          <span className={styles.lumihubMeta}>{t('illarin.unlinkHint')}</span>

          <Button variant="danger-ghost" size="sm" onClick={handleUnlink} disabled={unlinking} loading={unlinking}>
            {unlinking ? t('illarin.unlinking') : t('illarin.unlink')}
          </Button>
        </div>
      ) : (
        <div className={styles.lumihubCard}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('illarin.url')}</span>
            <input
              className={styles.lumihubInput}
              type="text"
              placeholder={t('illarin.urlPlaceholder')}
              value={illarinUrl}
              onChange={(e) => setIllarinUrl(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('illarin.instanceName')}</span>
            <input
              className={styles.lumihubInput}
              type="text"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
            />
          </div>

          {(deviceCode || browserCode) && (
            <div className={styles.lumihubDisclosure}>
              <span className={styles.lumihubDisclosureTitle}>
                {t(deviceCode ? 'illarin.deviceTitle' : 'illarin.browserCodeTitle')}
              </span>
              <span className={styles.lumihubDisclosureText}>{t('illarin.browserCodeNote')}</span>
              <input
                className={styles.lumihubInput}
                style={{ fontSize: '1.4em', textAlign: 'center', letterSpacing: '0.2em' }}
                aria-label={t(deviceCode ? 'illarin.deviceTitle' : 'illarin.browserCodeTitle')}
                readOnly
                value={deviceCode?.user_code || browserCode || ''}
                onFocus={(event) => event.target.select()}
              />
              <Button variant="ghost" size="sm" onClick={() => void copyCode(deviceCode?.user_code || browserCode || '')}>
                {copied ? t('modals:shared.copied') : t('common:actions.copy')}
              </Button>
              <a
                className={styles.illarinVerificationLink}
                href={deviceCode?.verification_url || browserAuthorizationUrl || undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t(deviceCode ? 'illarin.openVerification' : 'illarin.openAuthorization')}
              </a>
              {deviceCode && <span className={styles.lumihubDisclosureText}>{t('illarin.deviceNote')}</span>}
            </div>
          )}

          {linking && (
            <span className={styles.helperText}>
              {deviceCode ? t('illarin.waitingDevice') : t('illarin.waitingBrowser')}
            </span>
          )}

          {error && <span className={styles.helperText} style={{ color: 'var(--lumiverse-danger)' }}>{error}</span>}

          <Button variant="primary" size="sm" onClick={handleLink} disabled={linking} loading={linking}>
            {linking ? t('illarin.linking') : t('illarin.link')}
          </Button>

          {isLocalOrigin && !deviceCode && (
            <Button variant="ghost" size="sm" onClick={handleDeviceLink} disabled={linking}>
              {t('illarin.deviceFallback')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
