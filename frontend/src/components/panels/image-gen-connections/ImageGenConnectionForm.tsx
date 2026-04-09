import { useState, useCallback, useEffect, useMemo } from 'react'
import { RefreshCw, Loader } from 'lucide-react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type {
  ImageGenProviderInfo,
  ImageGenConnectionProfile,
  CreateImageGenConnectionInput,
} from '@/types/api'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: ImageGenProviderInfo[]
  profile?: ImageGenConnectionProfile
  onSave: (input: CreateImageGenConnectionInput) => void
  onCancel: () => void
}

export default function ImageGenConnectionForm({ providers, profile, onSave, onCancel }: Props) {
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || providers[0]?.id || 'google_gemini')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)

  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [byopLoading, setByopLoading] = useState(false)
  const [byopStatus, setByopStatus] = useState<string | null>(null)

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities
  const isPollinations = provider === 'pollinations'

  // Build model options from static list or fetched models
  const modelOptions = useMemo(() => {
    if (models.length > 0) return models
    return capabilities?.staticModels || []
  }, [models, capabilities?.staticModels])

  const fetchModels = useCallback(async () => {
    if (!profile?.id) return
    setModelsLoading(true)
    try {
      const result = await imageGenConnectionsApi.models(profile.id)
      if (result.models.length > 0) setModels(result.models)
    } catch {
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }, [profile?.id])

  useEffect(() => {
    if (profile?.id && capabilities?.modelListStyle !== 'static') {
      fetchModels()
    }
  }, [profile?.id, capabilities?.modelListStyle, fetchModels])

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

    if (pendingTarget && pendingTarget !== 'image-gen-connections') return

    const activeConnectionId = profile?.id || null
    if (pendingConnectionId && activeConnectionId && pendingConnectionId !== activeConnectionId) return

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
          await imageGenConnectionsApi.setApiKey(activeConnectionId, returnedApiKey)
          if (!cancelled) setByopStatus('Signed in with Pollinations. API key saved automatically.')
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

  const handlePollinationsSignIn = useCallback(async () => {
    setByopStatus(null)
    setByopLoading(true)
    try {
      const redirect_url = `${window.location.origin}${window.location.pathname}${window.location.search}`
      const result = await imageGenConnectionsApi.pollinationsAuthUrl({
        redirect_url,
        models: model.trim() || undefined,
      })
      sessionStorage.setItem(
        'pollinations_byop_pending',
        JSON.stringify({ connectionId: profile?.id || null, provider: 'pollinations', target: 'image-gen-connections' })
      )
      window.location.href = result.auth_url
    } catch (err: any) {
      const msg = String(err?.message || 'Failed to start Pollinations sign-in')
      setByopStatus(msg)
      setByopLoading(false)
    }
  }, [model, profile?.id])

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      provider,
      api_key: apiKey.trim() || undefined,
      api_url: apiUrl.trim() || undefined,
      model: model.trim() || undefined,
      is_default: isDefault,
    })
  }, [name, provider, apiKey, apiUrl, model, isDefault, onSave])

  return (
    <div className={styles.form}>
      <FormField label="Name" required>
        <TextInput value={name} onChange={setName} placeholder="Connection name" autoFocus={!profile} />
      </FormField>

      <FormField label="Provider">
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

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
        <TextInput
          value={apiKey}
          onChange={setApiKey}
          placeholder={profile?.has_api_key ? '••••••••' : 'Enter API key'}
          type="password"
        />
      </FormField>

      <FormField label="API URL" hint="Leave empty for default provider URL">
        <TextInput
          value={apiUrl}
          onChange={setApiUrl}
          placeholder={capabilities?.defaultUrl || 'https://...'}
        />
      </FormField>

      <FormField label="Model" hint={!profile?.id && capabilities?.modelListStyle !== 'static' ? 'Save connection first to fetch model list' : undefined}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <Select
            value={model}
            onChange={setModel}
            options={[
              { value: '', label: 'Select model...' },
              ...modelOptions.map((m) => ({ value: m.id, label: m.label })),
            ]}
          />
          {capabilities?.modelListStyle !== 'static' && (
            <button
              type="button"
              onClick={fetchModels}
              disabled={modelsLoading || !profile?.id}
              title={!profile?.id ? 'Save connection to fetch models' : 'Refresh models'}
              style={{
                padding: 6,
                border: 'none',
                background: 'transparent',
                cursor: !profile?.id ? 'not-allowed' : 'pointer',
                color: 'var(--lumiverse-text-muted)',
                opacity: !profile?.id ? 0.4 : 1,
              }}
            >
              {modelsLoading ? <Loader size={14} /> : <RefreshCw size={14} />}
            </button>
          )}
        </div>
      </FormField>

      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label="Set as default image gen connection" />
      </FormField>

      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? 'Save' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
