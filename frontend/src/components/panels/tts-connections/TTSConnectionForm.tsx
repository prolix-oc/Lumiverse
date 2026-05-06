import { useState, useCallback, useEffect, useMemo } from 'react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { ttsConnectionsApi } from '@/api/tts-connections'
import type {
  TtsProviderInfo,
  TtsConnectionProfile,
  CreateTtsConnectionInput,
  TtsVoice,
} from '@/types/api'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: TtsProviderInfo[]
  profile?: TtsConnectionProfile
  onSave: (input: CreateTtsConnectionInput) => void
  onCancel: () => void
}

export default function TTSConnectionForm({ providers, profile, onSave, onCancel }: Props) {
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || providers[0]?.id || 'openai_tts')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [voice, setVoice] = useState(profile?.voice || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)

  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities

  const modelOptions = useMemo(() => {
    const options = models.length > 0 ? models : capabilities?.staticModels || []
    if (model && !options.some((option) => option.id === model)) {
      return [{ id: model, label: model }, ...options]
    }
    return options
  }, [capabilities?.staticModels, model, models])

  const modelIds = useMemo(() => modelOptions.map((option) => option.id), [modelOptions])

  const modelLabels = useMemo(() => {
    return Object.fromEntries(
      modelOptions
        .filter((option) => option.label && option.label !== option.id)
        .map((option) => [option.id, option.label])
    )
  }, [modelOptions])

  const voiceOptions = useMemo(() => {
    const options = voices.length > 0 ? voices : capabilities?.staticVoices || []
    if (voice && !options.some((option) => option.id === voice)) {
      return [{ id: voice, name: voice }, ...options]
    }
    return options
  }, [voices, capabilities?.staticVoices, voice])

  const voiceIds = useMemo(() => voiceOptions.map((option) => option.id), [voiceOptions])

  const voiceLabels = useMemo(() => {
    return Object.fromEntries(
      voiceOptions.map((option) => [
        option.id,
        option.language ? `${option.name} (${option.language})` : option.name,
      ])
    )
  }, [voiceOptions])

  const fetchModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const result = await ttsConnectionsApi.previewModels({
        connection_id: profile?.id,
        provider,
        api_url: apiUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      })
      setModels(result.models)
    } catch {
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }, [apiKey, apiUrl, profile?.id, provider])

  const fetchVoices = useCallback(async () => {
    setVoicesLoading(true)
    try {
      const result = await ttsConnectionsApi.previewVoices({
        connection_id: profile?.id,
        provider,
        api_url: apiUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      })
      setVoices(result.voices)
    } catch {
      setVoices([])
    } finally {
      setVoicesLoading(false)
    }
  }, [apiKey, apiUrl, profile?.id, provider])

  useEffect(() => {
    if (profile?.id && capabilities?.voiceListStyle === 'dynamic') {
      fetchVoices()
    }
  }, [profile?.id, capabilities?.voiceListStyle, fetchVoices])

  useEffect(() => {
    if (profile?.id && capabilities?.modelListStyle === 'dynamic') {
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
      voice: voice.trim() || undefined,
      is_default: isDefault,
    })
  }, [name, provider, apiKey, apiUrl, model, voice, isDefault, onSave])

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

      <FormField label="Model" hint={capabilities?.modelListStyle === 'dynamic' ? 'Refresh uses the current form values, even before the connection is saved.' : undefined}>
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={modelIds}
          modelLabels={modelLabels}
          loading={modelsLoading}
          onRefresh={capabilities?.modelListStyle === 'dynamic' ? fetchModels : undefined}
          autoRefreshOnFocus={capabilities?.modelListStyle === 'dynamic'}
          refreshKey={`${provider}:${profile?.id || ''}:models`}
          appearance="standard"
          placeholder="gpt-4o-mini-tts"
          emptyMessage="No TTS models found. Enter one manually."
        />
      </FormField>

      <FormField label="Voice" hint={capabilities?.voiceListStyle === 'dynamic' ? 'Refresh uses the current form values, even before the connection is saved.' : undefined}>
        <ModelCombobox
          value={voice}
          onChange={setVoice}
          models={voiceIds}
          modelLabels={voiceLabels}
          loading={voicesLoading}
          onRefresh={capabilities?.voiceListStyle === 'dynamic' ? fetchVoices : undefined}
          autoRefreshOnFocus={capabilities?.voiceListStyle === 'dynamic'}
          refreshKey={`${provider}:${profile?.id || ''}:voices`}
          appearance="standard"
          placeholder="alloy or voice_..."
          emptyMessage="No voices found. Enter one manually."
        />
      </FormField>

      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label="Set as default TTS connection" />
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
