import { useState, useCallback, useEffect } from 'react'
import { FormField, TextInput, Select } from '@/components/shared/FormComponents'
import { connectionsApi } from '@/api/connections'
import ModelCombobox from './ModelCombobox'
import type { ProviderInfo, ConnectionProfile, CreateConnectionProfileInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'

interface ConnectionFormProps {
  providers: ProviderInfo[]
  profile?: ConnectionProfile
  onSave: (input: CreateConnectionProfileInput) => void
  onCancel: () => void
}

const FALLBACK_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
]

export default function ConnectionForm({ providers, profile, onSave, onCancel }: ConnectionFormProps) {
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || 'openai')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)
  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const providerOptions = providers.length > 0
    ? providers.map((p) => ({ value: p.id, label: p.name }))
    : FALLBACK_PROVIDERS

  const selectedProvider = providers.find((p) => p.id === provider)
  const urlPlaceholder = selectedProvider?.default_url || 'https://api.openai.com/v1'

  const fetchModels = useCallback(async () => {
    if (!profile?.id) return
    setModelsLoading(true)
    try {
      const result = await connectionsApi.models(profile.id)
      setModels(result.models)
    } catch (err) {
      console.error('[ConnectionForm] Failed to fetch models:', err)
    } finally {
      setModelsLoading(false)
    }
  }, [profile?.id])

  useEffect(() => {
    if (profile?.id) fetchModels()
  }, [profile?.id, fetchModels])

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
        <TextInput value={apiKey} onChange={setApiKey} placeholder={profile?.has_api_key ? '••••••••' : 'Enter API key'} type="password" />
      </FormField>
      <FormField label="API URL" hint="Leave empty for default provider URL">
        <TextInput value={apiUrl} onChange={setApiUrl} placeholder={urlPlaceholder} />
      </FormField>
      <FormField label="Model">
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={models}
          loading={modelsLoading}
          onRefresh={profile?.id ? fetchModels : undefined}
          placeholder="gpt-4o"
        />
      </FormField>
      <FormField label="">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Set as default connection
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
