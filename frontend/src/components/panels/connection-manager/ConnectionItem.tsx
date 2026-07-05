import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'

import { Trash2, Edit3, Zap, Check, Star, BrainCircuit, Copy, LogIn, RefreshCw, MoreVertical, Shuffle, GripVertical } from 'lucide-react'
import { connectionsApi } from '@/api/connections'
import { buildOpenRouterOAuthCallbackUrl, openrouterApi, type OpenRouterCreditsInfo } from '@/api/openrouter'
import { buildNanoGptOAuthCallbackUrl, nanoGptApi } from '@/api/nanogpt'
import {
  getReasoningBindingSummary,
  getReasoningBindingTitle,
  normalizeReasoningSettingsForProvider,
} from '@/lib/reasoning-binding'
import { formatAnthropicPromptCachingSummary } from '@/lib/anthropic-prompt-caching'
import { formatNanoGptCachingSummary } from '@/lib/nanogpt-prompt-caching'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
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
  profile: ConnectionProfile
  isActive: boolean
  providers: ProviderInfo[]
  onSelect: () => void
  onUpdate: (profile: ConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function ConnectionItem({
  profile, isActive, providers, onSelect, onUpdate, onDuplicate, onDelete,
}: ConnectionItemProps) {

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
  const isRoulette = profile.provider === MODEL_ROULETTE_PROVIDER
  const rouletteCount = isRoulette ? getRouletteConnectionCount(profile) : 0
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
    const isNanoGptOAuth = profile.provider === 'nanogpt'
    setOauthLoading(true)
    try {
      const callbackUrl = isNanoGptOAuth ? buildNanoGptOAuthCallbackUrl() : buildOpenRouterOAuthCallbackUrl()
      const { auth_url, session_token } = isNanoGptOAuth
        ? await nanoGptApi.initiateAuth(callbackUrl, { connectionId: profile.id })
        : await openrouterApi.initiateAuth(callbackUrl, { connectionId: profile.id })

      const popup = window.open(auth_url, isNanoGptOAuth ? 'nanogpt_auth' : 'openrouter_auth', 'width=600,height=700,scrollbars=yes')

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
        const expectedType = isNanoGptOAuth ? 'nanogpt_oauth_code' : 'openrouter_oauth_code'
        if (event.data?.type !== expectedType || !event.data.code) return
        if (isNanoGptOAuth && event.data.state !== session_token) return
        window.removeEventListener('message', onMessage)
        clearInterval(checkClosed)

        try {
          if (isNanoGptOAuth) {
            await nanoGptApi.completeAuth(session_token, event.data.code)
          } else {
            await openrouterApi.completeAuth(session_token, event.data.code)
          }
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
  }, [profile.id, profile.provider, onUpdate])

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

  // Track whether the credits/usage bars have already animated in.
  // The ref survives re-renders so the fadeIn class only plays once
  // per activation cycle (profile toggled on → bar appears with animation,
  // profile toggled off → ref resets, next activation animates again).
  const creditsAnimatedRef = useRef(false)
  if (showCredits && credits && !creditsAnimatedRef.current) {
    creditsAnimatedRef.current = true
  } else if (!showCredits && creditsAnimatedRef.current) {
    creditsAnimatedRef.current = false
  }

  const nanoGptShown = showNanoGptUsage && nanoGptUsage && (nanoGptUsageRows.length > 0 || nanoGptSubscriptionInactive)
  const nanoGptAnimatedRef = useRef(false)
  if (nanoGptShown && !nanoGptAnimatedRef.current) {
    nanoGptAnimatedRef.current = true
  } else if (!nanoGptShown && nanoGptAnimatedRef.current) {
    nanoGptAnimatedRef.current = false
  }


  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: profile.id })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })

  return (
    <div ref={setNodeRef} style={style} className={clsx(styles.item, isDragging && styles.itemDragging, isActive && styles.itemActive)}>
      {editing ? (
        <ConnectionForm
          providers={providers}
          profile={profile}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className={styles.itemRow}>
            <button
              type="button"
              className={styles.dragHandle}
              aria-label={t('connectionItem.dragToReorder')}
              title={t('connectionItem.dragToReorder')}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={16} />
            </button>
            <button type="button" className={styles.itemBtn} onClick={onSelect}>
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
          {showCredits && credits && (
            <div key="credits" className={clsx(styles.creditsBar, !creditsAnimatedRef.current && styles.creditsBarAnimateIn)}>
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
          {showNanoGptUsage && nanoGptUsage && (nanoGptUsageRows.length > 0 || nanoGptSubscriptionInactive) && (
            nanoGptUsageRows.length > 0
              ? nanoGptUsageRows.map(({ key, label, window: win }, idx) => (
                <div key={key} className={clsx(styles.creditsBar, styles.nanoGptUsageBar, idx === 0 && !nanoGptAnimatedRef.current && styles.creditsBarAnimateIn)}>
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
                  {idx === 0 && (
                    <button type="button" className={styles.creditsRefresh} onClick={refreshNanoGptUsage} disabled={nanoGptUsageLoading}>
                      {nanoGptUsageLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
                    </button>
                  )}
                </div>
              ))
              : (
                <div key="nanoGpt-inactive" className={clsx(styles.creditsBar, styles.nanoGptUsageBar, !nanoGptAnimatedRef.current && styles.creditsBarAnimateIn)}>
                  <div className={styles.creditCell}>
                    <span className={styles.creditLabel}>{t('connectionItem.status')}</span>
                    <span className={styles.creditValue}>{t('connectionItem.inactive')}</span>
                  </div>
                  <button type="button" className={styles.creditsRefresh} onClick={refreshNanoGptUsage} disabled={nanoGptUsageLoading}>
                    {nanoGptUsageLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
                  </button>
                </div>
              )
          )}
        </>
      )}
    </div>
  )
}
