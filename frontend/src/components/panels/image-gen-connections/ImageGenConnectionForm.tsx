import { useState, useCallback, useEffect, useMemo } from 'react'
import { RefreshCw, Loader } from 'lucide-react'
import { FormField, TextInput, Select } from '@/components/shared/FormComponents'
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

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities

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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Set as default image gen connection
        </label>
      </FormField>

      <div className={styles.formActions}>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
        <button type="button" className={styles.saveBtn} onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  )
}
