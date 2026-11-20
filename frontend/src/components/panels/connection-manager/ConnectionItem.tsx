import type { ConnectionPlacement } from '@/lib/connectionPlacement'
import type { ConnectionAccount } from '@/hooks/useConnectionAccount'
import { useConnectionRow } from '@/components/panels/connection-manager/useConnectionRow'
import { saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Trash2, Edit3, Zap, Check, Star, BrainCircuit, Copy, LogIn, RefreshCw, MoreVertical, Shuffle, GripVertical } from 'lucide-react'
import { connectionsApi } from '@/api/connections'
import { buildOpenRouterOAuthCallbackUrl, openrouterApi } from '@/api/openrouter'
import { buildNanoGptOAuthCallbackUrl, nanoGptApi } from '@/api/nanogpt'
import { startProviderOAuthPopup } from '@/lib/providerOAuthPopup'
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
import ProviderIcon from '@/components/shared/ProviderIcon'
import styles from './ConnectionItem.module.css'
import clsx from 'clsx'

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const MODEL_ROULETTE_PROVIDER = 'model_roulette'

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

function isNanoGptSubscriptionInactive(usage: NanoGptSubscriptionUsage) {
  const state = usage.state?.toLowerCase()
  return !usage.active || state === 'disabled' || state === 'inactive' || state === 'canceled' || state === 'cancelled'
}

function getRouletteConnectionCount(profile: ConnectionProfile) {
  const raw = profile.metadata?.connection_roulette?.connection_ids
  if (!Array.isArray(raw)) return 0
  return new Set(raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)).size
}

interface ConnectionItemProps {
  placement?: ConnectionPlacement
  account: ConnectionAccount
  profile: ConnectionProfile
  isActive: boolean
  providers: ProviderInfo[]
  onSelect: () => void
  onUpdate: (profile: ConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function ConnectionItem({
  placement = 'list', account, profile, isActive, providers, onSelect, onUpdate, onDuplicate, onDelete,
}: ConnectionItemProps) {

  const { t } = useTranslation('panels')
  const oauthCleanupRef = useRef<(() => void) | null>(null)
  const { editing, setEditing, isRecent, ...sortable } = useConnectionRow(profile.id, placement)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const { credits, nanoGptAccount, loading: accountLoading, error: accountError, refresh: refreshAccount } = account
  const nanoGptUsage = nanoGptAccount?.subscription
  const nanoGptError = accountError === null ? null : accountError || t('connectionItem.nanoGptUsageUnavailable')
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)

  const isOpenRouter = profile.provider === 'openrouter'
  const isNanoGpt = profile.provider === 'nanogpt'
  const isRoulette = profile.provider === MODEL_ROULETTE_PROVIDER
  const rouletteCount = isRoulette ? getRouletteConnectionCount(profile) : 0
  const showCredits = isOpenRouter && isActive && profile.has_api_key && !editing
  const showNanoGptUsage = isNanoGpt && isActive && profile.has_api_key && !editing
  const unknownReset = t('connectionItem.unknown')

  const creditsLoading = accountLoading && isOpenRouter
  const nanoGptUsageLoading = accountLoading && isNanoGpt
  const refreshCredits = refreshAccount
  const refreshNanoGptUsage = refreshAccount

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
  }, [profile.id, t])

  const handleSaveEdit = useCallback(async (input: CreateConnectionProfileInput, folderId = '') => {
    try {
      const updated = await connectionsApi.update(profile.id, input)
      saveConnectionFolder('llm', profile.id, folderId)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[ConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate, setEditing])

  const handleOAuthLogin = useCallback(async () => {
    const isNanoGptOAuth = profile.provider === 'nanogpt'
    setOauthLoading(true)
    try {
      const callbackUrl = isNanoGptOAuth ? buildNanoGptOAuthCallbackUrl() : buildOpenRouterOAuthCallbackUrl()
      const api = isNanoGptOAuth ? nanoGptApi : openrouterApi
      const flow = startProviderOAuthPopup({
        provider: isNanoGptOAuth ? 'nanogpt' : 'openrouter',
        callbackUrl,
        initiate: () => api.initiateAuth(callbackUrl, { connectionId: profile.id }),
      })
      oauthCleanupRef.current = flow.cancel
      const authorization = await flow.result
      if (!authorization) return
      try {
        await api.completeAuth(authorization.sessionToken, authorization.code)
        const updated = await connectionsApi.get(profile.id)
        onUpdate(updated)
      } catch (err) {
        console.error('[ConnectionItem] OAuth exchange failed:', err)
      }
    } catch (err) {
      console.error('[ConnectionItem] OAuth init failed:', err)
    } finally {
      oauthCleanupRef.current = null
      setOauthLoading(false)
    }
  }, [profile.id, profile.provider, onUpdate])

  useEffect(() => () => {
    oauthCleanupRef.current?.()
  }, [])

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
  const nanoGptSubscriptionInactive = nanoGptUsage ? isNanoGptSubscriptionInactive(nanoGptUsage) : false
  const nanoGptUsageRows = nanoGptUsage
    ? [
        { key: 'daily', label: t('connectionItem.dailyTokens'), window: nanoGptUsage.dailyInputTokens },
        { key: 'weekly', label: t('connectionItem.weeklyTokens'), window: nanoGptUsage.weeklyInputTokens },
      ].filter((entry): entry is typeof entry & { window: NonNullable<typeof entry.window> } => entry.window != null)
    : []

  const nanoGptShown = showNanoGptUsage && (nanoGptAccount || nanoGptError || nanoGptUsageLoading)

  const { attributes, listeners, setNodeRef, style, isDragging, handleRef } = sortable

  return (
    <div ref={setNodeRef} style={style} data-dragging={isDragging || undefined} className={clsx(styles.item, isDragging && styles.itemDragging, isActive && styles.itemActive)} data-component="ConnectionItem">
      {editing ? (
        <div data-component="ConnectionItem">
          <ConnectionForm
            providers={providers}
            profile={profile}
            onSave={handleSaveEdit}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <div className={styles.itemRow}>
            {!isRecent && <button
              ref={handleRef}
              type="button"
              className={styles.dragHandle}
              aria-label={t('connectionItem.dragToReorder')}
              title={t('connectionItem.dragToReorder')}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={16} />
            </button>}
            <button type="button" className={styles.itemBtn} onMouseDown={event => listeners?.onMouseDown?.(event)} onTouchStart={event => listeners?.onTouchStart?.(event)} onClick={onSelect}>
              {isRoulette ? (
                <span className={clsx(styles.itemIcon, styles.rouletteIcon)}>
                  <Shuffle size={16} />
                </span>
              ) : (
                <ProviderIcon kind="llm" provider={profile.provider} size={32} iconSize={16} className={styles.itemIcon} />
              )}
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>
                  {profile.name}
                  {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
                  {boundReasoning && <span title={boundReasoningTitle}><BrainCircuit size={11} className={styles.reasoningBound} /></span>}
                </span>
                <span className={styles.itemMeta}>
                  {isRoulette
                    ? t('connectionItem.modelRouletteMeta', { count: rouletteCount })
                    : `${profile.provider}${profile.model ? ` / ${profile.model}` : ''}`}
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
              {(isOpenRouter || isNanoGpt) && (
                <Button
                  size="icon-sm" variant="ghost"
                  onClick={handleOAuthLogin}
                  title={profile.has_api_key
                    ? (isNanoGpt ? t('connectionItem.reauthorizeNanoGpt') : t('connectionItem.reauthorizeOpenRouter'))
                    : (isNanoGpt ? t('connectionItem.signInNanoGpt') : t('connectionItem.signInOpenRouter'))}
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
          {isNanoGpt && !profile.has_api_key && !editing && (
            <button type="button" className={styles.oauthBanner} onClick={handleOAuthLogin} disabled={oauthLoading}>
              {oauthLoading ? <Spinner size={12} /> : <LogIn size={12} />}
              <span>{t('connectionItem.signInNanoGptHint')}</span>
            </button>
          )}
          {testResult && (
            <div className={clsx(styles.testMessage, testResult.success ? styles.testMessageSuccess : styles.testMessageFail)}>
              {testResult.message}
            </div>
          )}
          {isOpenRouter && profile.has_api_key && credits && (
            <div key="credits" className={clsx(styles.creditsBar, showCredits && styles.creditsBarAnimateIn, !(showCredits && credits) && styles.creditsHidden)}>
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
          {isNanoGpt && profile.has_api_key && (
            <div className={clsx(!nanoGptShown && styles.creditsHidden)}>
              <div className={clsx(styles.creditsBar, styles.nanoGptUsageBar)} title={t('connectionItem.nanoGptPaygoScope')}>
                <div className={styles.creditCell}>
                  <span className={styles.creditLabel}>{t('connectionItem.nanoGptPaygoBalance')}</span>
                  <span className={styles.creditValue} title={nanoGptAccount?.errors.balance}>
                    {nanoGptAccount?.balance?.usd_balance != null
                      ? `$${nanoGptAccount.balance.usd_balance.toFixed(2)}`
                      : nanoGptAccount?.balance?.nano_balance != null
                        ? `${nanoGptAccount.balance.nano_balance.toFixed(4)} Nano`
                        : unknownReset}
                  </span>
                </div>
                <div className={styles.creditCell}>
                  <span className={styles.creditLabel}>{t('connectionItem.today')}</span>
                  <span className={styles.creditValue} title={nanoGptAccount?.errors.paygo}>{nanoGptAccount?.paygo ? `$${nanoGptAccount.paygo.usage_daily.toFixed(4)}` : unknownReset}</span>
                </div>
                <div className={styles.creditCell}>
                  <span className={styles.creditLabel}>{t('connectionItem.thisMonth')}</span>
                  <span className={styles.creditValue} title={nanoGptAccount?.errors.paygo}>{nanoGptAccount?.paygo ? `$${nanoGptAccount.paygo.usage_monthly.toFixed(4)}` : unknownReset}</span>
                </div>
                <button type="button" className={styles.creditsRefresh} onClick={refreshNanoGptUsage} disabled={nanoGptUsageLoading} aria-label={t('connectionItem.refreshNanoGptUsage')}>
                  {nanoGptUsageLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
                </button>
              </div>
              {nanoGptError && <div className={clsx(styles.testMessage, styles.testMessageFail)} role="alert">{nanoGptError}</div>}
              {nanoGptUsageRows.length > 0
              ? nanoGptUsageRows.map(({ key, label, window: win }, idx) => (
                <div key={key} className={clsx(styles.creditsBar, styles.nanoGptUsageBar, idx === 0 && nanoGptShown && styles.creditsBarAnimateIn)}>
                  <div className={styles.creditCell}>
                    <span className={styles.creditLabel}>{label}</span>
                    <span className={styles.creditValue}>
                      {win.limit !== null
                        ? `${formatCompactCount(win.remaining)} / ${formatCompactCount(win.limit)}`
                        : formatCompactCount(win.remaining)}
                    </span>
                  </div>
                  <div className={styles.creditCell}>
                    <span className={styles.creditLabel}>{t('connectionItem.used')}</span>
                    <span className={styles.creditValue}>{formatCompactCount(win.used)}</span>
                  </div>
                  <div className={styles.creditCell}>
                    <span className={styles.creditLabel}>{nanoGptSubscriptionInactive ? t('connectionItem.status') : t('connectionItem.resetsIn')}</span>
                    <span className={styles.creditValue}>{nanoGptSubscriptionInactive ? t('connectionItem.inactive') : (formatTimeUntil(win.resetAt) || unknownReset)}</span>
                  </div>
                </div>
              ))
              : nanoGptSubscriptionInactive && profile.metadata?.use_subscription_api ? (
                <div key="nanoGpt-inactive" className={clsx(styles.creditsBar, styles.nanoGptUsageBar, nanoGptShown && styles.creditsBarAnimateIn)}>
                  <div className={styles.creditCell}>
                    <span className={styles.creditLabel}>{t('connectionItem.status')}</span>
                    <span className={styles.creditValue}>{t('connectionItem.inactive')}</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  )
}
