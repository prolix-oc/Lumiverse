import { useState, useCallback, useEffect, useRef } from 'react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { useTranslation } from 'react-i18next'
import { connectionsApi } from '@/api/connections'
import { useStore } from '@/store'
import {
  areReasoningSettingsEqual,
  getReasoningBindingSummary,
  normalizeReasoningSettingsForProvider,
} from '@/lib/reasoning-binding'
import {
  buildAnthropicPromptCachingMetadata,
  DEFAULT_ANTHROPIC_PROMPT_CACHING,
  parseAnthropicPromptCachingSettings,
  type AnthropicPromptCachingSettings,
} from '@/lib/anthropic-prompt-caching'
import {
  buildNanoGptCachingMetadata,
  parseNanoGptCachingSettings,
  type NanoGptCachingSettings,
} from '@/lib/nanogpt-prompt-caching'
import ModelCombobox from './ModelCombobox'
import OpenRouterSettings from './OpenRouterSettings'
import type { ProviderInfo, ConnectionProfile, CreateConnectionProfileInput } from '@/types/api'
import type { OpenRouterConnectionSettings } from '@/api/openrouter'
import type { ReasoningSettings } from '@/types/store'
import styles from '../ConnectionManager.module.css'

interface ConnectionFormProps {
  providers: ProviderInfo[]
  profile?: ConnectionProfile
  onSave: (input: CreateConnectionProfileInput) => void
  onCancel: () => void
  /** Called when OAuth auto-creates the connection during creation flow. */
  onOAuthCreated?: (profile: ConnectionProfile) => void
}

const FALLBACK_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'infermatic', label: 'Infermatic' },
  { value: 'pollinations_text', label: 'Pollinations (Text)' },
  { value: 'pollinations', label: 'Pollinations (Gen)' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
]

const VERTEX_REGIONS = [
  'us-central1', 'us-east1', 'us-east4', 'us-west1', 'us-west4',
  'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4',
  'asia-south1', 'asia-southeast1', 'asia-east1', 'asia-northeast1',
  'northamerica-northeast1', 'australia-southeast1', 'global',
]

export default function ConnectionForm({ providers, profile, onSave, onCancel, onOAuthCreated }: ConnectionFormProps) {
  const { t } = useTranslation('panels')
  const anthropicCacheTtlOptions = [
    { value: '5m', label: t('connectionForm.fiveMinutes') },
    { value: '1h', label: t('connectionForm.oneHour') },
  ]
  const nanogptCacheTtlOptions = [
    { value: '5m', label: t('connectionForm.fiveMinutes') },
    { value: '1h', label: t('connectionForm.oneHour') },
  ]
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || 'openai')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)
  const [useResponsesApi, setUseResponsesApi] = useState(profile?.metadata?.use_responses_api || false)
  const [useSubscriptionApi, setUseSubscriptionApi] = useState(profile?.metadata?.use_subscription_api || false)
  const [useZaiCodingPlanEndpoint, setUseZaiCodingPlanEndpoint] = useState(profile?.metadata?.use_coding_plan_endpoint || false)
  const [anthropicPromptCachingSettings, setAnthropicPromptCachingSettings] = useState<AnthropicPromptCachingSettings>(
    () => parseAnthropicPromptCachingSettings(profile?.metadata?.prompt_caching)
  )
  const [nanogptCachingSettings, setNanogptCachingSettings] = useState<NanoGptCachingSettings>(
    () => parseNanoGptCachingSettings(profile?.metadata?.nanogpt_caching)
  )
  const [bindReasoning, setBindReasoning] = useState(!!profile?.metadata?.reasoningBindings)
  const reasoningSettings = useStore((s) => s.reasoningSettings)
  const promptBias = useStore((s) => s.promptBias)
  const [boundReasoningSettings, setBoundReasoningSettings] = useState<ReasoningSettings>(
    () => ({ ...(profile?.metadata?.reasoningBindings?.settings || reasoningSettings) })
  )
  const [boundPromptBias, setBoundPromptBias] = useState<string>(
    () => {
      const stored = profile?.metadata?.reasoningBindings?.promptBias
      return typeof stored === 'string' ? stored : promptBias
    }
  )
  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [byopLoading, setByopLoading] = useState(false)
  const [byopStatus, setByopStatus] = useState<string | null>(null)

  // Vertex AI specific state
  const [vertexRegion, setVertexRegion] = useState(profile?.metadata?.vertex_region || 'us-central1')
  const [saFileName, setSaFileName] = useState<string | null>(profile?.metadata?.sa_file_name || null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // OpenRouter specific state
  const [openrouterSettings, setOpenrouterSettings] = useState<OpenRouterConnectionSettings>(
    profile?.metadata?.openrouter || {}
  )

  const providerOptions = providers.length > 0
    ? providers.map((p) => ({ value: p.id, label: p.name }))
    : FALLBACK_PROVIDERS

  const selectedProvider = providers.find((p) => p.id === provider)
  const urlPlaceholder = selectedProvider?.default_url || 'https://api.openai.com/v1'
  const isVertexAI = provider === 'google_vertex'
  const isPollinations = provider === 'pollinations'

  const fetchModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const metadata: Record<string, any> = { ...profile?.metadata }
      if (provider === 'nanogpt') {
        metadata.use_subscription_api = useSubscriptionApi
      } else {
        delete metadata.use_subscription_api
      }
      if (provider === 'zai') {
        metadata.use_coding_plan_endpoint = useZaiCodingPlanEndpoint
      } else {
        delete metadata.use_coding_plan_endpoint
      }
      if (isVertexAI) {
        metadata.vertex_region = vertexRegion
      }

      const result = await connectionsApi.previewModels({
        connection_id: profile?.id,
        provider,
        api_url: isVertexAI ? undefined : (apiUrl.trim() || undefined),
        metadata,
        api_key: apiKey.trim() || undefined,
      })
      setModels(result.models)
      setModelLabels(result.model_labels || {})
    } catch {
      setModels([])
      setModelLabels({})
    } finally {
      setModelsLoading(false)
    }
  }, [apiKey, apiUrl, isVertexAI, profile?.id, profile?.metadata, provider, useSubscriptionApi, useZaiCodingPlanEndpoint, vertexRegion])

  useEffect(() => {
    if (profile?.id) fetchModels()
  }, [profile?.id, fetchModels])

  useEffect(() => {
    const pendingRaw = sessionStorage.getItem('pollinations_byop_pending')
    if (!pendingRaw) return

    const hash = window.location.hash
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
    const hasReturnedKey = !!hashParams.get('api_key') || !!sessionStorage.getItem('pollinations_byop_returned_api_key')
    if (!hasReturnedKey) return

    try {
      const pending = JSON.parse(pendingRaw) as { provider?: string }
      if (pending.provider === 'pollinations' && provider !== 'pollinations') {
        setProvider('pollinations')
      }
    } catch {
      // ignore malformed pending state
    }
  }, [provider])

  useEffect(() => {
    if (!isPollinations) return

    const pendingRaw = sessionStorage.getItem('pollinations_byop_pending')
    if (!pendingRaw) return

    const hash = window.location.hash
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
    const returnedApiKey = params.get('api_key') || sessionStorage.getItem('pollinations_byop_returned_api_key')
    if (!returnedApiKey) return

    let pendingConnectionId: string | null = null
    let pendingTarget: string | null = null
    if (pendingRaw) {
      try {
        const parsed = JSON.parse(pendingRaw) as { connectionId?: string | null; target?: string | null }
        pendingConnectionId = parsed.connectionId || null
        pendingTarget = parsed.target || null
      } catch {
        pendingConnectionId = null
        pendingTarget = null
      }
    }

    if (pendingTarget && pendingTarget !== 'connections') return

    const activeConnectionId = profile?.id || null
    if (pendingConnectionId && activeConnectionId && pendingConnectionId !== activeConnectionId) {
      return
    }

    const clearRedirectArtifacts = () => {
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`)
      sessionStorage.removeItem('pollinations_byop_pending')
      sessionStorage.removeItem('pollinations_byop_returned_api_key')
    }

    let cancelled = false
    const applyReturnedKey = async () => {
      setApiKey(returnedApiKey)

      if (activeConnectionId) {
        try {
          await connectionsApi.update(activeConnectionId, { api_key: returnedApiKey })
          if (!cancelled) {
            setByopStatus(t('connectionForm.pollinationsSaved'))
          }
        } catch {
          if (!cancelled) {
            setByopStatus(t('connectionForm.pollinationsAutoSaveFailed'))
          }
        }
      } else if (!cancelled) {
        setByopStatus(t('connectionForm.pollinationsCaptured'))
      }

      clearRedirectArtifacts()
    }

    void applyReturnedKey()
    return () => {
      cancelled = true
    }
  }, [isPollinations, profile?.id, t])

  const showResponsesApiToggle = provider === 'openai'
  const showSubscriptionApiToggle = provider === 'nanogpt'
  const showZaiCodingPlanToggle = provider === 'zai'
  const showAnthropicPromptCachingToggle = provider === 'anthropic'
  const showNanoGptCachingToggle = provider === 'nanogpt'
  const isOpenRouter = provider === 'openrouter'
  // Vertex AI derives its host from `metadata.vertex_region`, so the API URL
  // field has no purpose and we don't display it.
  const hideApiUrl = isOpenRouter || provider === 'nanogpt' || isVertexAI
  const normalizedBoundReasoningSettings = normalizeReasoningSettingsForProvider(boundReasoningSettings, provider, model)
  const normalizedCurrentReasoningSettings = normalizeReasoningSettingsForProvider(reasoningSettings, provider, model)
  const bindingMatchesCurrent = areReasoningSettingsEqual(normalizedBoundReasoningSettings, normalizedCurrentReasoningSettings)
    && boundPromptBias === promptBias

  useEffect(() => {
    setBindReasoning(!!profile?.metadata?.reasoningBindings)
    setBoundReasoningSettings({ ...(profile?.metadata?.reasoningBindings?.settings || reasoningSettings) })
    const storedPromptBias = profile?.metadata?.reasoningBindings?.promptBias
    setBoundPromptBias(typeof storedPromptBias === 'string' ? storedPromptBias : promptBias)
    setAnthropicPromptCachingSettings(parseAnthropicPromptCachingSettings(profile?.metadata?.prompt_caching))
    setNanogptCachingSettings(parseNanoGptCachingSettings(profile?.metadata?.nanogpt_caching))
  }, [profile?.id])

  const handlePollinationsSignIn = useCallback(async () => {
    setByopStatus(null)
    setByopLoading(true)
    try {
      const redirect_url = `${window.location.origin}${window.location.pathname}${window.location.search}`
      const result = await connectionsApi.pollinationsAuthUrl({
        redirect_url,
        models: model.trim() || undefined,
      })

      sessionStorage.setItem(
        'pollinations_byop_pending',
        JSON.stringify({ connectionId: profile?.id || null, provider: 'pollinations', target: 'connections' })
      )

      window.location.href = result.auth_url
    } catch (err: any) {
      const msg = String(err?.message || t('connectionForm.pollinationsStartFailed'))
      setByopStatus(msg)
      setByopLoading(false)
    }
  }, [model, profile?.id, t])

  // Handle service account JSON file upload
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = reader.result as string
        // Validate it's valid JSON with required fields
        const parsed = JSON.parse(text)
        if (!parsed.private_key || !parsed.client_email || !parsed.project_id) {
          alert(t('connectionForm.invalidServiceAccountMissingFields'))
          return
        }
        // Store the raw JSON as the "API key"
        setApiKey(text)
        setSaFileName(file.name)
      } catch {
        alert(t('connectionForm.invalidJsonFile'))
      }
    }
    reader.readAsText(file)
    // Reset file input so the same file can be re-selected
    e.target.value = ''
  }, [t])

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return
    const metadata: Record<string, any> = { ...profile?.metadata }
    if (showResponsesApiToggle) {
      metadata.use_responses_api = useResponsesApi
    } else {
      delete metadata.use_responses_api
    }
    if (showSubscriptionApiToggle) {
      metadata.use_subscription_api = useSubscriptionApi
    } else {
      delete metadata.use_subscription_api
    }
    if (showZaiCodingPlanToggle) {
      metadata.use_coding_plan_endpoint = useZaiCodingPlanEndpoint
    } else {
      delete metadata.use_coding_plan_endpoint
    }
    if (showAnthropicPromptCachingToggle) {
      metadata.prompt_caching = buildAnthropicPromptCachingMetadata(anthropicPromptCachingSettings)
    } else {
      delete metadata.prompt_caching
    }
    if (showNanoGptCachingToggle) {
      metadata.nanogpt_caching = buildNanoGptCachingMetadata(nanogptCachingSettings)
    } else {
      delete metadata.nanogpt_caching
    }
    if (bindReasoning) {
      metadata.reasoningBindings = {
        settings: normalizedBoundReasoningSettings,
        promptBias: boundPromptBias,
      }
    } else {
      delete metadata.reasoningBindings
    }
    if (isVertexAI) {
      metadata.vertex_region = vertexRegion
      if (saFileName) metadata.sa_file_name = saFileName
    }
    if (isOpenRouter) {
      // Only persist non-empty settings
      const hasRouting = openrouterSettings.provider_routing && Object.values(openrouterSettings.provider_routing).some((v) =>
        Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ''
      )
      const hasPlugins = openrouterSettings.plugins && openrouterSettings.plugins.some((p) => p.enabled)
      if (hasRouting || hasPlugins) {
        metadata.openrouter = openrouterSettings
      } else {
        delete metadata.openrouter
      }
    } else {
      delete metadata.openrouter
    }

    // For Vertex AI the backend ignores `api_url` entirely and builds the
    // host from `metadata.vertex_region`, so we don't persist a value here.
    const resolvedApiUrl = isVertexAI ? undefined : (apiUrl.trim() || undefined)

    onSave({
      name: name.trim(),
      provider,
      api_key: apiKey.trim() || undefined,
      api_url: resolvedApiUrl,
      model: model.trim() || undefined,
      is_default: isDefault,
      metadata,
    })
  }, [name, provider, apiKey, apiUrl, model, isDefault, useResponsesApi, showResponsesApiToggle, useSubscriptionApi, showSubscriptionApiToggle, useZaiCodingPlanEndpoint, showZaiCodingPlanToggle, showAnthropicPromptCachingToggle, anthropicPromptCachingSettings, showNanoGptCachingToggle, nanogptCachingSettings, bindReasoning, boundReasoningSettings, boundPromptBias, profile?.metadata, onSave, isVertexAI, vertexRegion, saFileName, isOpenRouter, openrouterSettings])

  return (
    <div className={styles.form}>
      <FormField label={t('connectionForm.name')} required>
        <TextInput value={name} onChange={setName} placeholder={t('connectionForm.connectionName')} autoFocus={!profile} />
      </FormField>
      <FormField label={t('connectionForm.provider')}>
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

      {isVertexAI ? (
        <>
          <FormField
            label={t('connectionForm.serviceAccountJson')}
            hint={
              profile?.has_api_key
                ? t('connectionForm.credentialsLoaded', { file: saFileName ? ` (${saFileName})` : '' })
                : t('connectionForm.uploadServiceAccount')
            }
          >
            <div className={styles.fileUploadRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                {apiKey ? t('connectionForm.fileLoaded') : t('connectionForm.chooseFile')}
              </Button>
              {(saFileName || apiKey) && (
                <span className={styles.fileUploadName}>
                  {saFileName || t('connectionForm.serviceAccountFilename')}
                </span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
            </div>
          </FormField>
          <FormField label={t('connectionForm.region')} hint={t('connectionForm.vertexRegionHint')}>
            <Select
              value={vertexRegion}
              onChange={setVertexRegion}
              options={VERTEX_REGIONS.map((r) => ({ value: r, label: r }))}
            />
          </FormField>
        </>
      ) : (
        <>
          {isPollinations && (
            <FormField label={t('connectionForm.pollinationsByop')} hint={t('connectionForm.pollinationsByopHint')}>
              <div className={styles.byopRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePollinationsSignIn}
                  disabled={byopLoading}
                >
                  {byopLoading ? t('connectionForm.redirecting') : t('connectionForm.signInWithPollinations')}
                </Button>
                {byopStatus && <span className={styles.byopStatus}>{byopStatus}</span>}
              </div>
            </FormField>
          )}
          <FormField label={t('connectionForm.apiKey')} hint={profile?.has_api_key ? t('connectionForm.keyAlreadySet') : undefined}>
            <TextInput value={apiKey} onChange={setApiKey} placeholder={profile?.has_api_key ? '••••••••' : t('connectionForm.enterApiKey')} type="password" />
          </FormField>
        </>
      )}

      {!hideApiUrl && (
        <FormField label={t('connectionForm.apiUrl')} hint={isVertexAI ? t('connectionForm.vertexApiUrlHint') : t('connectionForm.defaultApiUrlHint')}>
          <TextInput value={apiUrl} onChange={setApiUrl} placeholder={urlPlaceholder} />
        </FormField>
      )}
      <FormField label={t('connectionForm.model')} hint={t('connectionForm.modelHint')}>
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={models}
          modelLabels={modelLabels}
          loading={modelsLoading}
          onRefresh={fetchModels}
          appearance="standard"
          placeholder={isVertexAI ? 'gemini-2.5-flash' : 'gpt-4o'}
        />
      </FormField>
      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label={t('connectionForm.setAsDefault')} />
      </FormField>
      {showResponsesApiToggle && (
        <FormField label="">
          <Toggle.Checkbox
            checked={useResponsesApi}
            onChange={setUseResponsesApi}
            label={t('connectionForm.useResponsesApi')}
            hint={t('connectionForm.useResponsesApiHint')}
          />
        </FormField>
      )}
      {showSubscriptionApiToggle && (
        <FormField label="">
          <Toggle.Checkbox
            checked={useSubscriptionApi}
            onChange={setUseSubscriptionApi}
            label={t('connectionForm.useSubscriptionApi')}
            hint={t('connectionForm.useSubscriptionApiHint')}
          />
        </FormField>
      )}
      {showNanoGptCachingToggle && (
        <>
          <FormField label="">
            <Toggle.Checkbox
              checked={nanogptCachingSettings.enabled}
              onChange={(checked) => setNanogptCachingSettings((current) => ({ ...current, enabled: checked }))}
              label={t('connectionForm.enablePromptCaching')}
              hint={t('connectionForm.enableNanoGptCachingHint')}
            />
          </FormField>
          {nanogptCachingSettings.enabled && (
            <>
              <FormField label={t('connectionForm.promptCacheTtl')} hint={t('connectionForm.nanoGptPromptCacheTtlHint')}>
                <Select
                  value={nanogptCachingSettings.ttl}
                  onChange={(ttl) => setNanogptCachingSettings((current) => ({ ...current, ttl: ttl as '5m' | '1h' }))}
                  options={nanogptCacheTtlOptions}
                />
              </FormField>
              <FormField label="">
                <Toggle.Checkbox
                  checked={nanogptCachingSettings.stickyProvider}
                  onChange={(checked) => setNanogptCachingSettings((current) => ({ ...current, stickyProvider: checked }))}
                  label={t('connectionForm.stickyProvider')}
                  hint={t('connectionForm.stickyProviderHint')}
                />
              </FormField>
              <FormField
                label="Cache Cutoff Message Index"
                hint="Optional. Pin the cache boundary to a specific message index (0-based). Everything up to and including this index is eligible for caching. Leave blank to let NanoGPT decide."
              >
                <TextInput
                  value={
                    typeof nanogptCachingSettings.cutAfterMessageIndex === 'number'
                      ? String(nanogptCachingSettings.cutAfterMessageIndex)
                      : ''
                  }
                  onChange={(raw) => setNanogptCachingSettings((current) => {
                    const trimmed = raw.trim()
                    if (trimmed === '') {
                      const { cutAfterMessageIndex: _drop, ...rest } = current
                      return rest
                    }
                    const parsed = Number(trimmed)
                    if (!Number.isInteger(parsed) || parsed < 0) return current
                    return { ...current, cutAfterMessageIndex: parsed }
                  })}
                  placeholder="e.g. 4"
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
              </FormField>
              <FormField label="">
                <Toggle.Checkbox
                  checked={nanogptCachingSettings.explicitCacheControl === true}
                  onChange={(checked) => setNanogptCachingSettings((current) => {
                    if (checked) return { ...current, explicitCacheControl: true }
                    const { explicitCacheControl: _drop, ...rest } = current
                    return rest
                  })}
                  label="Explicit Cache Control"
                  hint="Trust inline cache_control markers in the request body instead of letting NanoGPT auto-inject breakpoints. Advanced — only enable if you know your prompts already carry their own markers."
                />
              </FormField>
              <FormField label="">
                <Toggle.Checkbox
                  checked={nanogptCachingSettings.forceCacheCapableRouting === true}
                  onChange={(checked) => setNanogptCachingSettings((current) => {
                    if (checked) return { ...current, forceCacheCapableRouting: true }
                    const { forceCacheCapableRouting: _drop, ...rest } = current
                    return rest
                  })}
                  label="Force Cache-Capable Routing (advanced)"
                  hint="⚠️ Sends top-level caching:true so NanoGPT picks a cache-capable upstream regardless of model. Per NanoGPT docs this MAY bypass subscription coverage and bill the request as pay-as-you-go. Leave off unless you specifically need cache hits on a model that isn't getting them via implicit caching."
                />
              </FormField>
            </>
          )}
        </>
      )}
      {showZaiCodingPlanToggle && (
        <FormField label="">
          <Toggle.Checkbox
            checked={useZaiCodingPlanEndpoint}
            onChange={setUseZaiCodingPlanEndpoint}
            label={t('connectionForm.useCodingPlanEndpoint')}
            hint={t('connectionForm.useCodingPlanEndpointHint')}
          />
        </FormField>
      )}
      {showAnthropicPromptCachingToggle && (
        <>
          <FormField label="">
            <Toggle.Checkbox
              checked={anthropicPromptCachingSettings.enabled}
              onChange={(checked) => setAnthropicPromptCachingSettings((current) => ({
                ...current,
                enabled: checked,
                automatic: checked ? current.automatic : DEFAULT_ANTHROPIC_PROMPT_CACHING.automatic,
              }))}
              label={t('connectionForm.enablePromptCaching')}
              hint={t('connectionForm.enableAnthropicCachingHint')}
            />
          </FormField>
          {anthropicPromptCachingSettings.enabled && (
            <>
              <FormField label={t('connectionForm.promptCacheTtl')} hint={t('connectionForm.anthropicPromptCacheTtlHint')}>
                <Select
                  value={anthropicPromptCachingSettings.ttl}
                  onChange={(ttl) => setAnthropicPromptCachingSettings((current) => ({ ...current, ttl: ttl as '5m' | '1h' }))}
                  options={anthropicCacheTtlOptions}
                />
              </FormField>
              <FormField label="">
                <Toggle.Checkbox
                  checked={anthropicPromptCachingSettings.automatic}
                  onChange={(checked) => setAnthropicPromptCachingSettings((current) => ({ ...current, automatic: checked }))}
                  label={t('connectionForm.useAutomaticCaching')}
                  hint={t('connectionForm.useAutomaticCachingHint')}
                />
              </FormField>
              <FormField label={t('connectionForm.explicitCacheBreakpoints')} hint={t('connectionForm.explicitCacheBreakpointsHint')}>
                <div className={styles.toggleStack}>
                  <Toggle.Checkbox
                    checked={anthropicPromptCachingSettings.breakpoints.tools}
                    onChange={(checked) => setAnthropicPromptCachingSettings((current) => ({
                      ...current,
                      breakpoints: { ...current.breakpoints, tools: checked },
                    }))}
                    label={t('connectionForm.cacheTools')}
                  />
                  <Toggle.Checkbox
                    checked={anthropicPromptCachingSettings.breakpoints.system}
                    onChange={(checked) => setAnthropicPromptCachingSettings((current) => ({
                      ...current,
                      breakpoints: { ...current.breakpoints, system: checked },
                    }))}
                    label={t('connectionForm.cacheSystemPrompt')}
                  />
                  <Toggle.Checkbox
                    checked={anthropicPromptCachingSettings.breakpoints.messages}
                    onChange={(checked) => setAnthropicPromptCachingSettings((current) => ({
                      ...current,
                      breakpoints: { ...current.breakpoints, messages: checked },
                    }))}
                    label={t('connectionForm.cacheConversationPrefix')}
                  />
                </div>
              </FormField>
            </>
          )}
        </>
      )}
      {isOpenRouter && (
        <OpenRouterSettings
          connectionId={profile?.id}
          connectionName={!profile ? name : undefined}
          hasApiKey={!!profile?.has_api_key || !!apiKey}
          settings={openrouterSettings}
          onChange={setOpenrouterSettings}
          onApiKeySet={() => {
            // Clear the manual key input since OAuth set it
            setApiKey('')
          }}
          onConnectionCreated={onOAuthCreated}
        />
      )}
      <FormField label="">
        <Toggle.Checkbox
          checked={bindReasoning}
          onChange={setBindReasoning}
          label={t('connectionForm.bindReasoningSettings')}
          hint={t('connectionForm.bindReasoningSettingsHint')}
        />
      </FormField>
      {bindReasoning && (
        <div className={styles.bindingCard}>
          <div className={styles.bindingCardHeader}>
            <div>
              <div className={styles.bindingCardTitle}>{t('connectionForm.savedReasoningSnapshot')}</div>
              <div className={styles.bindingCardSummary}>{getReasoningBindingSummary(normalizedBoundReasoningSettings, boundPromptBias)}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBoundReasoningSettings({ ...reasoningSettings })
                setBoundPromptBias(promptBias)
              }}
              title={bindingMatchesCurrent ? t('connectionForm.snapshotAlreadyMatches') : t('connectionForm.replaceSavedSnapshot')}
            >
              {bindingMatchesCurrent ? t('connectionForm.captured') : t('connectionForm.captureCurrent')}
            </Button>
          </div>
          {!bindingMatchesCurrent && (
            <div className={styles.bindingCardHint}>
              {t('connectionForm.currentValuesDiffer')}
            </div>
          )}
        </div>
      )}
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('connectionForm.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? t('connectionForm.save') : t('connectionForm.create')}
        </Button>
      </div>
    </div>
  )
}
