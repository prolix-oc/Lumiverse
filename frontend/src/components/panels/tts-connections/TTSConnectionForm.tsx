import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField, TextInput, TextArea, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { isQwenTtsProvider, QWEN_LANGUAGE_OPTIONS } from '@/lib/qwenTts'
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
  const { t } = useTranslation('panels')
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || providers[0]?.id || 'openai_tts')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [voice, setVoice] = useState(profile?.voice || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)
  const [defaultParameters, setDefaultParameters] = useState<Record<string, any>>(profile?.default_parameters || {})

  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities
  const isQwen = isQwenTtsProvider(provider)
  const qwenLanguage = typeof defaultParameters.language === 'string'
    && QWEN_LANGUAGE_OPTIONS.some((option) => option.value === defaultParameters.language)
    ? defaultParameters.language
    : 'Auto'
  const qwenInstruct = typeof defaultParameters.instruct === 'string'
    ? defaultParameters.instruct
    : ''
  const qwenUseStreaming = defaultParameters.use_streaming_endpoint !== false

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

  const setQwenLanguage = useCallback((next: string) => {
    setDefaultParameters((prev) => {
      const updated = { ...prev }
      if (!next || next === 'Auto') {
        delete updated.language
      } else {
        updated.language = next
      }
      return updated
    })
  }, [])

  const setQwenInstruct = useCallback((next: string) => {
    setDefaultParameters((prev) => {
      const updated = { ...prev }
      if (!next.trim()) {
        delete updated.instruct
      } else {
        updated.instruct = next
      }
      return updated
    })
  }, [])

  const setQwenUseStreaming = useCallback((next: boolean) => {
    setDefaultParameters((prev) => {
      const updated = { ...prev }
      if (next) {
        delete updated.use_streaming_endpoint
      } else {
        updated.use_streaming_endpoint = false
      }
      return updated
    })
  }, [])

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return
    const qwenDefaults: Record<string, any> = {}
    if (isQwen && typeof defaultParameters.language === 'string' && defaultParameters.language) {
      qwenDefaults.language = defaultParameters.language
    }
    if (isQwen && typeof defaultParameters.instruct === 'string' && defaultParameters.instruct.trim()) {
      qwenDefaults.instruct = defaultParameters.instruct.trim()
    }
    if (isQwen && defaultParameters.use_streaming_endpoint === false) {
      qwenDefaults.use_streaming_endpoint = false
    }
    onSave({
      name: name.trim(),
      provider,
      api_key: apiKey.trim() || undefined,
      api_url: apiUrl.trim() || undefined,
      model: model.trim() || undefined,
      voice: voice.trim() || undefined,
      is_default: isDefault,
      default_parameters: isQwen ? qwenDefaults : undefined,
    })
  }, [name, provider, apiKey, apiUrl, model, voice, isDefault, isQwen, defaultParameters, onSave])

  return (
    <div className={styles.form}>
      <FormField label={t('ttsConnectionForm.name')} required>
        <TextInput value={name} onChange={setName} placeholder={t('ttsConnectionForm.connectionName')} autoFocus={!profile} />
      </FormField>

      <FormField label={t('ttsConnectionForm.provider')}>
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

      {capabilities?.apiKeyRequired && (
        <FormField label={t('ttsConnectionForm.apiKey')} hint={profile?.has_api_key ? t('ttsConnectionForm.keySetHint') : undefined}>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            placeholder={profile?.has_api_key ? '••••••••' : t('ttsConnectionForm.enterApiKey')}
            type="password"
          />
        </FormField>
      )}

      <FormField label={t('ttsConnectionForm.apiUrl')} hint={t('ttsConnectionForm.apiUrlHint')}>
        <TextInput
          value={apiUrl}
          onChange={setApiUrl}
          placeholder={capabilities?.defaultUrl || 'https://...'}
        />
      </FormField>

      <FormField label={t('ttsConnectionForm.model')} hint={capabilities?.modelListStyle === 'dynamic' ? t('ttsConnectionForm.refreshHint') : undefined}>
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
          placeholder={t('ttsConnectionForm.modelPlaceholder')}
          emptyMessage={t('ttsConnectionForm.noTtsModels')}
        />
      </FormField>

      <FormField label={t('ttsConnectionForm.voice')} hint={capabilities?.voiceListStyle === 'dynamic' ? t('ttsConnectionForm.refreshHint') : undefined}>
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
          placeholder={isQwen ? t('ttsConnectionForm.qwenVoicePlaceholder') : t('ttsConnectionForm.voicePlaceholder')}
          emptyMessage={t('ttsConnectionForm.noVoices')}
        />
      </FormField>

      {isQwen && (
        <>
          <FormField label={t('ttsConnectionForm.qwenLanguage')} hint={t('ttsConnectionForm.qwenLanguageHint')}>
            <Select
              value={qwenLanguage}
              onChange={setQwenLanguage}
              options={QWEN_LANGUAGE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.value === 'Auto' ? t('ttsConnectionForm.qwenLanguageAuto') : option.label,
              }))}
            />
          </FormField>

          <FormField label={t('ttsConnectionForm.qwenInstruct')} hint={t('ttsConnectionForm.qwenInstructHint')}>
            <TextArea
              value={qwenInstruct}
              onChange={setQwenInstruct}
              placeholder={t('ttsConnectionForm.qwenInstructPlaceholder')}
              rows={3}
            />
          </FormField>

          <FormField label="">
            <Toggle.Checkbox
              checked={qwenUseStreaming}
              onChange={setQwenUseStreaming}
              label={t('ttsConnectionForm.qwenUseStreaming')}
              hint={t('ttsConnectionForm.qwenUseStreamingHint')}
            />
          </FormField>

          <div className={styles.bindingCard}>
            <div className={styles.bindingCardTitle}>{t('ttsConnectionForm.qwenCloneTitle')}</div>
            <div className={styles.bindingCardHint}>
              {profile
                ? t('ttsConnectionForm.qwenCloneHintSaved')
                : t('ttsConnectionForm.qwenCloneHintUnsaved')}
            </div>
          </div>
        </>
      )}

      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label={t('ttsConnectionForm.setDefault')} />
      </FormField>

      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('ttsConnectionForm.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? t('ttsConnectionForm.save') : t('ttsConnectionForm.create')}
        </Button>
      </div>
    </div>
  )
}
