import { useState, useEffect, useCallback } from 'react'
import { Link2, Trash2, Edit3, Zap, Check, Star, BrainCircuit, Copy, LogIn, RefreshCw } from 'lucide-react'
import { connectionsApi } from '@/api/connections'
import { openrouterApi, type OpenRouterCreditsInfo } from '@/api/openrouter'
import type { ConnectionProfile, ProviderInfo, CreateConnectionProfileInput } from '@/types/api'
import ConnectionForm from './ConnectionForm'
import { Spinner } from '@/components/shared/Spinner'
import { Button } from '@/components/shared/FormComponents'
import styles from './ConnectionItem.module.css'
import clsx from 'clsx'

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  google_vertex: '#34a853',
  openrouter: '#6366f1',
  custom: 'var(--lumiverse-text-dim)',
}

interface ConnectionItemProps {
  profile: ConnectionProfile
  isActive: boolean
  providers: ProviderInfo[]
  onSelect: () => void
  onUpdate: (profile: ConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function ConnectionItem({ profile, isActive, providers, onSelect, onUpdate, onDuplicate, onDelete }: ConnectionItemProps) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [credits, setCredits] = useState<OpenRouterCreditsInfo | null>(null)
  const [creditsLoading, setCreditsLoading] = useState(false)

  const isOpenRouter = profile.provider === 'openrouter'
  const showCredits = isOpenRouter && isActive && profile.has_api_key && !editing

  // Fetch credits when this is the active OpenRouter connection
  useEffect(() => {
    if (!showCredits) { setCredits(null); return }
    setCreditsLoading(true)
    openrouterApi.credits(profile.id)
      .then(setCredits)
      .catch(() => setCredits(null))
      .finally(() => setCreditsLoading(false))
  }, [showCredits, profile.id])

  const refreshCredits = useCallback(() => {
    if (!showCredits) return
    setCreditsLoading(true)
    openrouterApi.credits(profile.id)
      .then(setCredits)
      .catch(() => setCredits(null))
      .finally(() => setCreditsLoading(false))
  }, [showCredits, profile.id])

  // Auto-dismiss test result after 5s
  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await connectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }, [profile.id])

  const handleSaveEdit = useCallback(async (input: CreateConnectionProfileInput) => {
    try {
      const updated = await connectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[ConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

  const handleOAuthLogin = useCallback(async () => {
    setOauthLoading(true)
    try {
      const baseUrl = import.meta.env.VITE_API_BASE || '/api/v1'
      const apiOrigin = baseUrl.startsWith('http') ? new URL(baseUrl).origin : window.location.origin
      const callbackUrl = `${apiOrigin}/api/v1/openrouter/oauth-landing`
      const { auth_url, session_token } = await openrouterApi.initiateAuth(profile.id, callbackUrl)

      const popup = window.open(auth_url, 'openrouter_auth', 'width=600,height=700,scrollbars=yes')

      let handled = false
      const cleanup = () => {
        if (handled) return
        handled = true
        window.removeEventListener('message', onMessage)
        clearInterval(checkClosed)
        setOauthLoading(false)
      }

      // Landing page sends us the code via postMessage
      const onMessage = async (event: MessageEvent) => {
        if (event.data?.type !== 'openrouter_oauth_code' || !event.data.code) return
        window.removeEventListener('message', onMessage)
        clearInterval(checkClosed)

        try {
          await openrouterApi.completeAuth(session_token, event.data.code)
          const updated = await connectionsApi.get(profile.id)
          onUpdate(updated)
        } catch (err) {
          console.error('[ConnectionItem] OAuth exchange failed:', err)
        }
        handled = true
        setOauthLoading(false)
      }
      window.addEventListener('message', onMessage)

      // If user closes popup without authorizing, stop the spinner
      const checkClosed = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(checkClosed)
          setTimeout(cleanup, 1500)
        }
      }, 500)

      setTimeout(cleanup, 5 * 60 * 1000)
    } catch (err) {
      console.error('[ConnectionItem] OAuth init failed:', err)
      setOauthLoading(false)
    }
  }, [profile.id, onUpdate])

  const providerColor = PROVIDER_COLORS[profile.provider] || PROVIDER_COLORS.custom

  if (editing) {
    return (
      <div className={styles.item}>
        <ConnectionForm
          providers={providers}
          profile={profile}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <div className={clsx(styles.item, isActive && styles.itemActive)}>
      <div className={styles.itemRow}>
        <button type="button" className={styles.itemBtn} onClick={onSelect}>
          <div
            className={styles.itemIcon}
            style={{
              background: `color-mix(in srgb, ${providerColor} 10%, transparent)`,
              color: providerColor,
            }}
          >
            <Link2 size={16} />
          </div>
          <div className={styles.itemInfo}>
            <span className={styles.itemName}>
              {profile.name}
              {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
              {profile.metadata?.reasoningBindings && <span title="Reasoning settings bound"><BrainCircuit size={11} className={styles.reasoningBound} /></span>}
            </span>
            <span className={styles.itemMeta}>
              {profile.provider}{profile.model ? ` / ${profile.model}` : ''}
            </span>
          </div>
          {isActive && <Check size={14} className={styles.activeCheck} />}
        </button>
        <div className={styles.itemActions}>
          {isOpenRouter && (
            <Button
              size="icon-sm" variant="ghost"
              onClick={handleOAuthLogin}
              title={profile.has_api_key ? 'Re-authorize with OpenRouter' : 'Sign in with OpenRouter'}
              disabled={oauthLoading}
              icon={oauthLoading ? <Spinner size={13} /> : <LogIn size={13} />}
            />
          )}
          <Button
            size="icon-sm" variant="ghost"
            className={clsx(testResult && (testResult.success ? styles.testSuccess : styles.testFail))}
            onClick={handleTest}
            title="Test connection"
            disabled={testing}
            icon={testing ? <Spinner size={13} /> : <Zap size={13} />}
          />
          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title="Edit" icon={<Edit3 size={13} />} />
          <Button size="icon-sm" variant="ghost" onClick={onDuplicate} title="Duplicate" icon={<Copy size={13} />} />
          <Button size="icon-sm" variant="danger-ghost" onClick={onDelete} title="Delete" icon={<Trash2 size={13} />} />
        </div>
      </div>
      {isOpenRouter && !profile.has_api_key && !editing && (
        <button type="button" className={styles.oauthBanner} onClick={handleOAuthLogin} disabled={oauthLoading}>
          {oauthLoading ? <Spinner size={12} /> : <LogIn size={12} />}
          <span>Sign in with OpenRouter to get an API key</span>
        </button>
      )}
      {testResult && (
        <div className={clsx(styles.testMessage, testResult.success ? styles.testMessageSuccess : styles.testMessageFail)}>
          {testResult.message}
        </div>
      )}
      {showCredits && credits && (
        <div className={styles.creditsBar}>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>Remaining</span>
            <span className={styles.creditValue}>
              {credits.limit_remaining !== null && credits.limit !== null
                ? `$${credits.limit_remaining.toFixed(2)} / $${credits.limit.toFixed(2)}`
                : credits.limit_remaining !== null
                  ? `$${credits.limit_remaining.toFixed(2)}`
                  : 'Unlimited'}
            </span>
          </div>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>Today</span>
            <span className={styles.creditValue}>${credits.usage_daily.toFixed(4)}</span>
          </div>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>This month</span>
            <span className={styles.creditValue}>${credits.usage_monthly.toFixed(4)}</span>
          </div>
          <button type="button" className={styles.creditsRefresh} onClick={refreshCredits} disabled={creditsLoading}>
            {creditsLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
          </button>
        </div>
      )}
    </div>
  )
}
