import { useState, useCallback, useMemo } from 'react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import type {
  SttProviderInfo,
  SttConnectionProfile,
  CreateSttConnectionInput,
} from '@/types/api'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: SttProviderInfo[]
  profile?: SttConnectionProfile
  onSave: (input: CreateSttConnectionInput) => void
  onCancel: () => void
}

export default function STTConnectionForm({ providers, profile, onSave, onCancel }: Props) {
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || providers[0]?.id || 'openai')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)

  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))

  const modelOptions = useMemo(
    () => capabilities?.staticModels || [],
    [capabilities?.staticModels],
  )

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

      {capabilities?.apiKeyRequired && (
        <FormField label="API Key" hint={profile?.has_api_key ? 'Key is set. Enter a new value to replace it.' : undefined}>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            placeholder={profile?.has_api_key ? '••••••••' : 'Enter API key'}
            type="password"
          />
        </FormField>
      )}

      <FormField label="API URL" hint="Leave empty for default provider URL">
        <TextInput
          value={apiUrl}
          onChange={setApiUrl}
          placeholder={capabilities?.defaultUrl || 'https://...'}
        />
      </FormField>

      <FormField label="Model">
        <Select
          value={model}
          onChange={setModel}
          options={[
            { value: '', label: 'Select model...' },
            ...modelOptions.map((m) => ({ value: m.id, label: m.label })),
          ]}
        />
      </FormField>

      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label="Set as default STT connection" />
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
