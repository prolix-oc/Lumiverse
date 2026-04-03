import { useState, useCallback, useEffect, useMemo } from 'react'
import { ExternalLink, RefreshCw, LogIn, Zap, Settings2, ChevronRight } from 'lucide-react'
import { FormField, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { openrouterApi, type OpenRouterCreditsInfo, type OpenRouterConnectionSettings, type OpenRouterProviderEntry } from '@/api/openrouter'
import { Spinner } from '@/components/shared/Spinner'
import type { ConnectionProfile } from '@/types/api'
import MultiChipSelect from './MultiChipSelect'
import styles from './OpenRouterSettings.module.css'

interface OpenRouterSettingsProps {
  connectionId?: string
  /** Name to use when auto-creating the connection during OAuth (creation flow). */
  connectionName?: string
  hasApiKey: boolean
  settings: OpenRouterConnectionSettings
  onChange: (settings: OpenRouterConnectionSettings) => void
  onApiKeySet?: () => void
  /** Called when the connection was auto-created during OAuth (creation flow). */
  onConnectionCreated?: (profile: ConnectionProfile) => void
}

const SORT_OPTIONS = [
  { value: '', label: 'Default (balanced)' },
  { value: 'price', label: 'Cheapest first' },
  { value: 'throughput', label: 'Fastest throughput' },
  { value: 'latency', label: 'Lowest latency' },
]

const DATA_COLLECTION_OPTIONS = [
  { value: '', label: 'Default (allow)' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny (privacy-first)' },
]

const QUANTIZATION_OPTIONS = [
  'int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32', 'unknown',
]

export default function OpenRouterSettings({ connectionId, connectionName, hasApiKey, settings, onChange, onApiKeySet, onConnectionCreated }: OpenRouterSettingsProps) {
  const [credits, setCredits] = useState<OpenRouterCreditsInfo | null>(null)
  const [creditsLoading, setCreditsLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [routingOpen, setRoutingOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [upstreamProviders, setUpstreamProviders] = useState<OpenRouterProviderEntry[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)

  const routing = settings.provider_routing || {}
  const plugins = settings.plugins || []

  const providerOptions = useMemo(() =>
    upstreamProviders.map((p) => ({ value: p.slug, label: p.name })),
    [upstreamProviders]
  )

  const quantizationOptions = useMemo(() =>
    QUANTIZATION_OPTIONS.map((q) => ({ value: q, label: q })),
    []
  )

  const fetchCredits = useCallback(async () => {
    if (!connectionId || !hasApiKey) return
    setCreditsLoading(true)
    try {
      const data = await openrouterApi.credits(connectionId)
      setCredits(data)
    } catch {
      setCredits(null)
    } finally {
      setCreditsLoading(false)
    }
  }, [connectionId, hasApiKey])

  useEffect(() => {
    if (connectionId && hasApiKey) fetchCredits()
  }, [connectionId, hasApiKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch upstream provider list when routing section opens
  useEffect(() => {
    if (!routingOpen || !connectionId || !hasApiKey || upstreamProviders.length > 0) return
    setProvidersLoading(true)
    openrouterApi.providers(connectionId)
      .then((res) => setUpstreamProviders(res.providers))
      .catch(() => {})
      .finally(() => setProvidersLoading(false))
  }, [routingOpen, connectionId, hasApiKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateRouting = useCallback((patch: Partial<OpenRouterConnectionSettings['provider_routing']>) => {
    onChange({
      ...settings,
      provider_routing: { ...routing, ...patch },
    })
  }, [settings, routing, onChange])

  const togglePlugin = useCallback((pluginId: string, enabled: boolean) => {
    const existing = plugins.find((p) => p.id === pluginId)
    let next: typeof plugins
    if (existing) {
      next = plugins.map((p) => p.id === pluginId ? { ...p, enabled } : p)
    } else {
      next = [...plugins, { id: pluginId, enabled }]
    }
    next = next.filter((p) => p.enabled || Object.keys(p).length > 2)
    onChange({ ...settings, plugins: next })
  }, [settings, plugins, onChange])

  const isPluginEnabled = (id: string) => plugins.find((p) => p.id === id)?.enabled ?? false

  const handleOAuthLogin = useCallback(async () => {
    if (!connectionId && !connectionName?.trim()) return
    setOauthLoading(true)
    try {
      const baseUrl = import.meta.env.VITE_API_BASE || '/api/v1'
      const apiOrigin = baseUrl.startsWith('http') ? new URL(baseUrl).origin : window.location.origin
      const callbackUrl = `${apiOrigin}/api/v1/openrouter/oauth-landing`
      const { auth_url, session_token } = await openrouterApi.initiateAuth(callbackUrl, connectionId
        ? { connectionId }
        : { connectionName: connectionName!.trim() }
      )

      const popup = window.open(auth_url, 'openrouter_auth', 'width=600,height=700,scrollbars=yes')

      let handled = false
      const cleanup = () => {
        if (handled) return
        handled = true
        window.removeEventListener('message', onMessage)
        clearInterval(checkClosed)
        setOauthLoading(false)
      }

      const onMessage = async (event: MessageEvent) => {
        if (event.data?.type !== 'openrouter_oauth_code' || !event.data.code) return
        window.removeEventListener('message', onMessage)
        clearInterval(checkClosed)

        try {
          const result = await openrouterApi.completeAuth(session_token, event.data.code)
          if (result.created && result.profile) {
            onConnectionCreated?.(result.profile)
          } else {
            onApiKeySet?.()
            fetchCredits()
          }
        } catch (err) {
          console.error('[OpenRouter] OAuth exchange failed:', err)
        }
        handled = true
        setOauthLoading(false)
      }
      window.addEventListener('message', onMessage)

      const checkClosed = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(checkClosed)
          setTimeout(cleanup, 1500)
        }
      }, 500)

      setTimeout(cleanup, 5 * 60 * 1000)
    } catch (err) {
      console.error('[OpenRouter] OAuth init failed:', err)
      setOauthLoading(false)
    }
  }, [connectionId, connectionName, onApiKeySet, onConnectionCreated, fetchCredits])

  return (
    <div className={styles.container}>
      <div className={styles.brandHeader}>
        <span className={styles.brandDot} />
        <span className={styles.brandLabel}>OpenRouter</span>
      </div>

      {/* OAuth Login */}
      {(connectionId || connectionName?.trim()) && !hasApiKey && (
        <div className={styles.oauthSection}>
          <Button
            variant="primary"
            size="sm"
            onClick={handleOAuthLogin}
            disabled={oauthLoading}
            icon={oauthLoading ? <Spinner size={13} /> : <LogIn size={13} />}
          >
            Sign in with OpenRouter
          </Button>
          <span className={styles.oauthHint}>
            {connectionId ? 'Authorize to get an API key automatically' : 'Sign in to create this connection with your OpenRouter account'}
          </span>
        </div>
      )}

      {/* Credits */}
      {connectionId && hasApiKey && (
        credits ? (
          <div className={styles.creditsRow}>
            <div className={styles.creditCell}>
              <span className={styles.creditLabel}>Remaining</span>
              <span className={styles.creditValue}>
                {credits.limit_remaining !== null && credits.limit !== null
                  ? `$${credits.limit_remaining.toFixed(2)} / $${credits.limit.toFixed(2)}`
                  : credits.limit_remaining !== null
                    ? `$${credits.limit_remaining.toFixed(2)}`
                    : 'Unlimited'}
                {credits.is_free_tier && <span className={styles.freeTierBadge}>Free</span>}
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
            <div className={styles.creditsActions}>
              <button type="button" className={styles.refreshBtn} onClick={fetchCredits} disabled={creditsLoading}>
                {creditsLoading ? <Spinner size={11} /> : <RefreshCw size={11} />}
              </button>
            </div>
          </div>
        ) : (
          !creditsLoading && <span className={styles.creditsUnavailable}>Unable to fetch credit info</span>
        )
      )}

      {/* Provider Routing */}
      <button type="button" className={styles.sectionToggle} onClick={() => setRoutingOpen(!routingOpen)}>
        <ChevronRight size={12} className={`${styles.sectionChevron} ${routingOpen ? styles.sectionChevronOpen : ''}`} />
        <Settings2 size={13} className={styles.sectionToggleIcon} />
        <span>Provider Routing</span>
      </button>
      {routingOpen && (
        <div className={styles.sectionContent}>
          <FormField label="Sort By" hint="How to prioritize providers for this model">
            <Select
              value={routing.sort || ''}
              onChange={(v) => updateRouting({ sort: v || undefined })}
              options={SORT_OPTIONS}
            />
          </FormField>
          <FormField label="Data Collection" hint="Filter by provider data retention policy">
            <Select
              value={routing.data_collection || ''}
              onChange={(v) => updateRouting({ data_collection: (v as any) || undefined })}
              options={DATA_COLLECTION_OPTIONS}
            />
          </FormField>
          <FormField label="">
            <Toggle.Checkbox
              checked={routing.allow_fallbacks !== false}
              onChange={(v) => updateRouting({ allow_fallbacks: v })}
              label="Allow fallback providers"
              hint="Use backup providers when primary is unavailable"
            />
          </FormField>
          <FormField label="">
            <Toggle.Checkbox
              checked={routing.require_parameters ?? false}
              onChange={(v) => updateRouting({ require_parameters: v })}
              label="Require parameter support"
              hint="Only route to providers that support all request parameters"
            />
          </FormField>
          <FormField label="Preferred Providers" hint="Providers to try first, in order of preference">
            <MultiChipSelect
              options={providerOptions}
              selected={routing.order || []}
              onChange={(v) => updateRouting({ order: v.length ? v : undefined })}
              placeholder="Select providers to prefer..."
              loading={providersLoading}
            />
          </FormField>
          <FormField label="Ignore Providers" hint="Providers to exclude from routing entirely">
            <MultiChipSelect
              options={providerOptions}
              selected={routing.ignore || []}
              onChange={(v) => updateRouting({ ignore: v.length ? v : undefined })}
              placeholder="Select providers to exclude..."
              loading={providersLoading}
            />
          </FormField>
          <FormField label="Quantizations" hint="Only use endpoints with these quantization levels">
            <MultiChipSelect
              options={quantizationOptions}
              selected={routing.quantizations || []}
              onChange={(v) => updateRouting({ quantizations: v.length ? v : undefined })}
              placeholder="Select quantizations..."
            />
          </FormField>
        </div>
      )}

      {/* Plugins */}
      <button type="button" className={styles.sectionToggle} onClick={() => setPluginsOpen(!pluginsOpen)}>
        <ChevronRight size={12} className={`${styles.sectionChevron} ${pluginsOpen ? styles.sectionChevronOpen : ''}`} />
        <Zap size={13} className={styles.sectionToggleIcon} />
        <span>Plugins</span>
      </button>
      {pluginsOpen && (
        <div className={styles.sectionContent}>
          <FormField label="">
            <Toggle.Checkbox
              checked={isPluginEnabled('web')}
              onChange={(v) => togglePlugin('web', v)}
              label="Web Search"
              hint="Augment responses with web search results"
            />
          </FormField>
          <FormField label="">
            <Toggle.Checkbox
              checked={isPluginEnabled('response-healing')}
              onChange={(v) => togglePlugin('response-healing', v)}
              label="Response Healing"
              hint="Auto-fix malformed JSON in responses (non-streaming)"
            />
          </FormField>
          <FormField label="">
            <Toggle.Checkbox
              checked={isPluginEnabled('context-compression')}
              onChange={(v) => togglePlugin('context-compression', v)}
              label="Context Compression"
              hint="Middle-out compression when context exceeds limit"
            />
          </FormField>
        </div>
      )}

      {/* Attribution */}
      <div className={styles.attribution}>
        <span>Lumiverse on</span>
        <a href="https://openrouter.ai/apps" target="_blank" rel="noopener noreferrer">
          OpenRouter Apps <ExternalLink size={9} />
        </a>
      </div>
    </div>
  )
}
