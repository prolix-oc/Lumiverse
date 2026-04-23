import { useState, useCallback, useEffect, useRef } from 'react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { connectionsApi } from '@/api/connections'
import { useStore } from '@/store'
import {
  areReasoningSettingsEqual,
  getReasoningBindingSummary,
  normalizeReasoningSettingsForProvider,
} from '@/lib/reasoning-binding'
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
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || 'openai')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)
  const [useResponsesApi, setUseResponsesApi] = useState(profile?.metadata?.use_responses_api || false)
  const [useSubscriptionApi, setUseSubscriptionApi] = useState(profile?.metadata?.use_subscription_api || false)
  const [bindReasoning, setBindReasoning] = useState(!!profile?.metadata?.reasoningBindings)
  const reasoningSettings = useStore((s) => s.reasoningSettings)
  const [boundReasoningSettings, setBoundReasoningSettings] = useState<ReasoningSettings>(
    () => ({ ...(profile?.metadata?.reasoningBindings?.settings || reasoningSettings) })
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
  }, [apiKey, apiUrl, isVertexAI, profile?.id, profile?.metadata, provider, useSubscriptionApi, vertexRegion])

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
            setByopStatus('Signed in with Pollinations. API key saved automatically.')
          }
        } catch {
          if (!cancelled) {
            setByopStatus('Pollinations sign-in succeeded, but auto-save failed. Click Save to persist manually.')
          }
        }
      } else if (!cancelled) {
        setByopStatus('Signed in with Pollinations. API key captured. Click Create to save this connection.')
      }

      clearRedirectArtifacts()
    }

    void applyReturnedKey()
    return () => {
      cancelled = true
    }
  }, [isPollinations, profile?.id])

  const showResponsesApiToggle = provider === 'openai'
  const showSubscriptionApiToggle = provider === 'nanogpt'
  const isOpenRouter = provider === 'openrouter'
  // Vertex AI derives its host from `metadata.vertex_region`, so the API URL
  // field has no purpose and we don't display it.
  const hideApiUrl = isOpenRouter || provider === 'nanogpt' || isVertexAI
  const normalizedBoundReasoningSettings = normalizeReasoningSettingsForProvider(boundReasoningSettings, provider, model)
  const normalizedCurrentReasoningSettings = normalizeReasoningSettingsForProvider(reasoningSettings, provider, model)
  const bindingMatchesCurrent = areReasoningSettingsEqual(normalizedBoundReasoningSettings, normalizedCurrentReasoningSettings)

  useEffect(() => {
    setBindReasoning(!!profile?.metadata?.reasoningBindings)
    setBoundReasoningSettings({ ...(profile?.metadata?.reasoningBindings?.settings || reasoningSettings) })
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
      const msg = String(err?.message || 'Failed to start Pollinations sign-in')
      setByopStatus(msg)
      setByopLoading(false)
    }
  }, [model, profile?.id])

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
          alert('Invalid service account JSON: missing required fields (private_key, client_email, project_id)')
          return
        }
        // Store the raw JSON as the "API key"
        setApiKey(text)
        setSaFileName(file.name)
      } catch {
        alert('Invalid JSON file. Please upload a valid Google service account key file.')
      }
    }
    reader.readAsText(file)
    // Reset file input so the same file can be re-selected
    e.target.value = ''
  }, [])

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
    if (bindReasoning) {
      metadata.reasoningBindings = { settings: normalizedBoundReasoningSettings }
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
  }, [name, provider, apiKey, apiUrl, model, isDefault, useResponsesApi, showResponsesApiToggle, useSubscriptionApi, showSubscriptionApiToggle, bindReasoning, boundReasoningSettings, profile?.metadata, onSave, isVertexAI, vertexRegion, saFileName, isOpenRouter, openrouterSettings])

  return (
    <div className={styles.form}>
      <FormField label="Name" required>
        <TextInput value={name} onChange={setName} placeholder="Connection name" autoFocus={!profile} />
      </FormField>
      <FormField label="Provider">
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

      {isVertexAI ? (
        <>
          <FormField
            label="Service Account JSON"
            hint={
              profile?.has_api_key
                ? `Credentials loaded${saFileName ? ` (${saFileName})` : ''}. Upload a new file to replace.`
                : 'Upload your Google Cloud service account key JSON file'
            }
          >
            <div className={styles.fileUploadRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                {apiKey ? 'File loaded' : 'Choose file'}
              </Button>
              {(saFileName || apiKey) && (
                <span className={styles.fileUploadName}>
                  {saFileName || 'service-account.json'}
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
          <FormField label="Region" hint="Google Cloud region for Vertex AI">
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
            <FormField label="Pollinations BYOP" hint="Use Sign in with Pollinations to fetch a BYOP key automatically, or paste a key manually below.">
              <div className={styles.byopRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePollinationsSignIn}
                  disabled={byopLoading}
                >
                  {byopLoading ? 'Redirecting...' : 'Sign in with Pollinations'}
                </Button>
                {byopStatus && <span className={styles.byopStatus}>{byopStatus}</span>}
              </div>
            </FormField>
          )}
          <FormField label="API Key" hint={profile?.has_api_key ? 'Key is set. Enter a new value to replace it.' : undefined}>
            <TextInput value={apiKey} onChange={setApiKey} placeholder={profile?.has_api_key ? '••••••••' : 'Enter API key'} type="password" />
          </FormField>
        </>
      )}

      {!hideApiUrl && (
        <FormField label="API URL" hint={isVertexAI ? 'Leave empty to use default Vertex AI endpoint with selected region' : 'Leave empty for default provider URL'}>
          <TextInput value={apiUrl} onChange={setApiUrl} placeholder={urlPlaceholder} />
        </FormField>
      )}
      <FormField label="Model" hint="Refresh uses the current form values, even before the connection is saved.">
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={models}
          modelLabels={modelLabels}
          loading={modelsLoading}
          onRefresh={fetchModels}
          placeholder={isVertexAI ? 'gemini-2.5-flash' : 'gpt-4o'}
        />
      </FormField>
      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label="Set as default connection" />
      </FormField>
      {showResponsesApiToggle && (
        <FormField label="">
          <Toggle.Checkbox checked={useResponsesApi} onChange={setUseResponsesApi} label="Use Responses API" hint="Use /v1/responses instead of /v1/chat/completions" />
        </FormField>
      )}
      {showSubscriptionApiToggle && (
        <FormField label="">
          <Toggle.Checkbox checked={useSubscriptionApi} onChange={setUseSubscriptionApi} label="Use Subscription API" hint="Use /api/subscription/v1 to only use models from your NanoGPT subscription" />
        </FormField>
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
        <Toggle.Checkbox checked={bindReasoning} onChange={setBindReasoning} label="Bind reasoning settings" hint="Save current reasoning settings and auto-apply when this connection is selected" />
      </FormField>
      {bindReasoning && (
        <div className={styles.bindingCard}>
          <div className={styles.bindingCardHeader}>
            <div>
              <div className={styles.bindingCardTitle}>Saved reasoning snapshot</div>
              <div className={styles.bindingCardSummary}>{getReasoningBindingSummary(normalizedBoundReasoningSettings)}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBoundReasoningSettings({ ...reasoningSettings })}
              title={bindingMatchesCurrent ? 'Snapshot already matches the current reasoning settings' : 'Replace the saved snapshot with the current reasoning settings'}
            >
              {bindingMatchesCurrent ? 'Captured' : 'Capture Current'}
            </Button>
          </div>
          {!bindingMatchesCurrent && (
            <div className={styles.bindingCardHint}>
              Current panel values differ from this connection's saved snapshot.
            </div>
          )}
        </div>
      )}
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? 'Save' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
