import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Link2, Trash2, Edit3, Zap, Check, Star, BrainCircuit, Copy, LogIn, RefreshCw, MoreVertical } from 'lucide-react'
import { connectionsApi } from '@/api/connections'
import { buildOpenRouterOAuthCallbackUrl, openrouterApi, type OpenRouterCreditsInfo } from '@/api/openrouter'
import {
  getReasoningBindingSummary,
  getReasoningBindingTitle,
  normalizeReasoningSettingsForProvider,
} from '@/lib/reasoning-binding'
import { formatAnthropicPromptCachingSummary } from '@/lib/anthropic-prompt-caching'
import { formatNanoGptCachingSummary } from '@/lib/nanogpt-prompt-caching'
import type { ConnectionProfile, ProviderInfo, CreateConnectionProfileInput, NanoGptSubscriptionUsage } from '@/types/api'
import ConnectionForm from './ConnectionForm'
import { Spinner } from '@/components/shared/Spinner'
import { Button } from '@/components/shared/FormComponents'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import styles from './ConnectionItem.module.css'
import { PROVIDER_COLORS } from '@/components/shared/providerVisuals'
import clsx from 'clsx'

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatCompactCount(value: number) {
  return COMPACT_NUMBER_FORMATTER.format(value)
}

function formatTimeUntil(resetAt: number | null) {
  if (!resetAt) return ''

  const diffMs = Math.max(0, resetAt - Date.now())
  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}d, ${hours}h`
  if (hours > 0) return `${hours}h, ${minutes}m`
  return `${minutes}m`
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

export default function ConnectionItem({
profile, isActive, providers, onSelect, onUpdate, onDuplicate, onDelete }: ConnectionItemProps) {
  const { t } = useTranslation('panels')
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [credits, setCredits] = useState<OpenRouterCreditsInfo | null>(null)
  const [creditsLoading, setCreditsLoading] = useState(false)
  const [nanoGptUsage, setNanoGptUsage] = useState<NanoGptSubscriptionUsage | null>(null)
  const [nanoGptUsageLoading, setNanoGptUsageLoading] = useState(false)
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)

  const isOpenRouter = profile.provider === 'openrouter'
  const isNanoGpt = profile.provider === 'nanogpt'
  const showCredits = isOpenRouter && isActive && profile.has_api_key && !editing
  const showNanoGptUsage = isNanoGpt && isActive && profile.has_api_key && !editing
  const unknownReset = t('connectionItem.unknown')

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

  useEffect(() => {
    if (!showNanoGptUsage) { setNanoGptUsage(null); return }
    setNanoGptUsageLoading(true)
    connectionsApi.nanogptUsage(profile.id)
      .then(setNanoGptUsage)
      .catch(() => setNanoGptUsage(null))
      .finally(() => setNanoGptUsageLoading(false))
  }, [showNanoGptUsage, profile.id])

  const refreshNanoGptUsage = useCallback(() => {
    if (!showNanoGptUsage) return
    setNanoGptUsageLoading(true)
    connectionsApi.nanogptUsage(profile.id)
      .then(setNanoGptUsage)
      .catch(() => setNanoGptUsage(null))
      .finally(() => setNanoGptUsageLoading(false))
  }, [showNanoGptUsage, profile.id])

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
      setTestResult({ success: false, message: err.message || t('connectionItem.connectionFailed') })
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
      const callbackUrl = buildOpenRouterOAuthCallbackUrl()
      const { auth_url, session_token } = await openrouterApi.initiateAuth(callbackUrl, { connectionId: profile.id })

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
  const boundReasoning = profile.metadata?.reasoningBindings?.settings
  const boundPromptBias = profile.metadata?.reasoningBindings?.promptBias
  const normalizedBoundReasoning = boundReasoning
    ? normalizeReasoningSettingsForProvider(boundReasoning, profile.provider, profile.model)
    : null
  const boundReasoningSummary = normalizedBoundReasoning ? getReasoningBindingSummary(normalizedBoundReasoning, boundPromptBias) : null
  const boundReasoningTitle = normalizedBoundReasoning ? getReasoningBindingTitle(normalizedBoundReasoning, boundPromptBias) : undefined
  const anthropicCachingSummary = profile.provider === 'anthropic'
    ? formatAnthropicPromptCachingSummary(profile.metadata?.prompt_caching)
    : null
  const nanogptCachingSummary = profile.provider === 'nanogpt'
    ? formatNanoGptCachingSummary(profile.metadata?.nanogpt_caching)
    : null
  const cachingSummary = anthropicCachingSummary ?? nanogptCachingSummary

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
                {boundReasoning && <span title={boundReasoningTitle}><BrainCircuit size={11} className={styles.reasoningBound} /></span>}
              </span>
              <span className={styles.itemMeta}>
                {profile.provider}{profile.model ? ` / ${profile.model}` : ''}
              </span>
              {boundReasoningSummary && (
                <span className={styles.itemReasoningMeta} title={boundReasoningTitle}>
                  {boundReasoningSummary}
                </span>
              )}
              {cachingSummary && (
                <span className={styles.itemCachingMeta} title={cachingSummary}>
                  {cachingSummary}
                </span>
              )}
            </div>
          {isActive && <Check size={14} className={styles.activeCheck} />}
        </button>
        <div className={styles.itemActions}>
          {isOpenRouter && (
            <Button
              size="icon-sm" variant="ghost"
              onClick={handleOAuthLogin}
              title={profile.has_api_key ? t('connectionItem.reauthorizeOpenRouter') : t('connectionItem.signInOpenRouter')}
              disabled={oauthLoading}
              icon={oauthLoading ? <Spinner size={13} /> : <LogIn size={13} />}
            />
          )}
          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title={t('connectionItem.edit')} icon={<Edit3 size={13} />} />
          <Button
            size="icon-sm" variant="ghost"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setMenuPos({ x: rect.right, y: rect.bottom + 4 })
            }}
            title={t('connectionItem.moreActions')}
            icon={<MoreVertical size={13} />}
          />
          <ContextMenu
            position={menuPos}
            onClose={() => setMenuPos(null)}
            items={[
              { key: 'test', label: testing ? t('connectionItem.testing') : t('connectionItem.testConnection'), icon: <Zap size={14} />, onClick: () => { setMenuPos(null); handleTest() }, disabled: testing },
              { key: 'duplicate', label: t('connectionItem.duplicate'), icon: <Copy size={14} />, onClick: () => { setMenuPos(null); onDuplicate() } },
              { key: 'div', type: 'divider' as const },
              { key: 'delete', label: t('connectionItem.delete'), icon: <Trash2 size={14} />, onClick: () => { setMenuPos(null); onDelete() }, danger: true },
            ] satisfies ContextMenuEntry[]}
          />
        </div>
      </div>
      {isOpenRouter && !profile.has_api_key && !editing && (
        <button type="button" className={styles.oauthBanner} onClick={handleOAuthLogin} disabled={oauthLoading}>
          {oauthLoading ? <Spinner size={12} /> : <LogIn size={12} />}
          <span>{t('connectionItem.signInOpenRouterHint')}</span>
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
            <span className={styles.creditLabel}>{t('connectionItem.remaining')}</span>
            <span className={styles.creditValue}>
              {credits.limit_remaining !== null && credits.limit !== null
                ? `$${credits.limit_remaining.toFixed(2)} / $${credits.limit.toFixed(2)}`
                : credits.limit_remaining !== null
                  ? `$${credits.limit_remaining.toFixed(2)}`
                  : t('connectionItem.unlimited')}
            </span>
          </div>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>{t('connectionItem.today')}</span>
            <span className={styles.creditValue}>${credits.usage_daily.toFixed(4)}</span>
          </div>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>{t('connectionItem.thisMonth')}</span>
            <span className={styles.creditValue}>${credits.usage_monthly.toFixed(4)}</span>
          </div>
          <button type="button" className={styles.creditsRefresh} onClick={refreshCredits} disabled={creditsLoading}>
            {creditsLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
          </button>
        </div>
      )}
      {showNanoGptUsage && nanoGptUsage?.weeklyInputTokens && (
        <div className={clsx(styles.creditsBar, styles.nanoGptUsageBar)}>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>{t('connectionItem.remaining')}</span>
            <span className={styles.creditValue}>
              {nanoGptUsage.limits.weeklyInputTokens !== null
                ? `${formatCompactCount(nanoGptUsage.weeklyInputTokens.remaining)} / ${formatCompactCount(nanoGptUsage.limits.weeklyInputTokens)}`
                : formatCompactCount(nanoGptUsage.weeklyInputTokens.remaining)}
            </span>
          </div>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>{t('connectionItem.used')}</span>
            <span className={styles.creditValue}>{formatCompactCount(nanoGptUsage.weeklyInputTokens.used)}</span>
          </div>
          <div className={styles.creditCell}>
            <span className={styles.creditLabel}>{t('connectionItem.resetsIn')}</span>
            <span className={styles.creditValue}>{formatTimeUntil(nanoGptUsage.weeklyInputTokens.resetAt) || unknownReset}</span>
          </div>
          <button type="button" className={styles.creditsRefresh} onClick={refreshNanoGptUsage} disabled={nanoGptUsageLoading}>
            {nanoGptUsageLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
          </button>
        </div>
      )}
    </div>
  )
}
