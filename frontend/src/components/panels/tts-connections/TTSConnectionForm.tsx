import { useState, useCallback, useEffect, useMemo } from 'react'
import { RefreshCw, Loader } from 'lucide-react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
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

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities

  const modelOptions = useMemo(() => {
    return capabilities?.staticModels || []
  }, [capabilities?.staticModels])

  const voiceOptions = useMemo(() => {
    if (voices.length > 0) return voices
    return capabilities?.staticVoices || []
  }, [voices, capabilities?.staticVoices])

  const fetchVoices = useCallback(async () => {
    if (!profile?.id) return
    setVoicesLoading(true)
    try {
      const result = await ttsConnectionsApi.voices(profile.id)
      if (result.voices.length > 0) setVoices(result.voices)
    } catch {
      setVoices([])
    } finally {
      setVoicesLoading(false)
    }
  }, [profile?.id])

  useEffect(() => {
    if (profile?.id && capabilities?.voiceListStyle === 'dynamic') {
      fetchVoices()
    }
  }, [profile?.id, capabilities?.voiceListStyle, fetchVoices])

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

      <FormField label="Voice" hint={!profile?.id && capabilities?.voiceListStyle === 'dynamic' ? 'Save connection first to fetch voice list' : undefined}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <Select
            value={voice}
            onChange={setVoice}
            options={[
              { value: '', label: 'Select voice...' },
              ...voiceOptions.map((v) => ({
                value: v.id,
                label: v.language ? `${v.name} (${v.language})` : v.name,
              })),
            ]}
          />
          {capabilities?.voiceListStyle === 'dynamic' && (
            <button
              type="button"
              onClick={fetchVoices}
              disabled={voicesLoading || !profile?.id}
              title={!profile?.id ? 'Save connection to fetch voices' : 'Refresh voices'}
              style={{
                padding: 6,
                border: 'none',
                background: 'transparent',
                cursor: !profile?.id ? 'not-allowed' : 'pointer',
                color: 'var(--lumiverse-text-muted)',
                opacity: !profile?.id ? 0.4 : 1,
              }}
            >
              {voicesLoading ? <Loader size={14} /> : <RefreshCw size={14} />}
            </button>
          )}
        </div>
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
