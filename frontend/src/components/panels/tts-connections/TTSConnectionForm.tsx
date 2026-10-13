import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField, TextInput, TextArea, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { VERTEX_REGIONS } from '@/components/panels/connection-manager/vertexConstants'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { isQwenTtsProvider, QWEN_LANGUAGE_OPTIONS } from '@/lib/qwenTts'
import { getTtsVoiceLabel, getTtsVoiceSublabel } from '@/lib/ttsVoiceLabels'
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

  const isVertex = provider === 'google_vertex_tts'
  const isGoogle = isVertex || provider === 'google_tts'
  const googleUseStreaming = defaultParameters.use_streaming_endpoint !== false
  const [vertexRegion, setVertexRegion] = useState(profile?.metadata?.vertex_region || 'us-central1')
  const [saFileName, setSaFileName] = useState<string | null>(profile?.metadata?.sa_file_name || null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [voicesLoading, setVoicesLoading] = useState(false)
  const voicesRequestRef = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 })
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities
  const isQwen = isQwenTtsProvider(provider)
  const isOpenVox = provider === 'openvox_tts'
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
      voiceOptions.map((option) => {
        const label = getTtsVoiceLabel(option)
        const sublabel = getTtsVoiceSublabel(option)
        return [option.id, sublabel ? `${label} — ${sublabel}` : label]
      })
    )
  }, [voiceOptions])

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

  const fetchModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const metadata: Record<string, any> = { ...profile?.metadata }
      if (isVertex) {
        metadata.vertex_region = vertexRegion
      }
      const result = await ttsConnectionsApi.previewModels({
        connection_id: profile?.id,
        provider,
        api_url: isVertex ? undefined : (apiUrl.trim() || undefined),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        api_key: apiKey.trim() || undefined,
      })
      setModels(result.models)
    } catch {
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }, [apiKey, apiUrl, isVertex, profile?.id, profile?.metadata, provider, vertexRegion])

  const cancelVoicesRequest = useCallback(() => {
    const request = voicesRequestRef.current
    request.controller?.abort()
    voicesRequestRef.current = { generation: request.generation + 1 }
  }, [])

  const fetchVoices = useCallback(async () => {
    const previousRequest = voicesRequestRef.current
    previousRequest.controller?.abort()
    const controller = new AbortController()
    const generation = previousRequest.generation + 1
    voicesRequestRef.current = { generation, controller }
    setVoicesLoading(true)
    try {
      const metadata: Record<string, any> = { ...profile?.metadata }
      if (isVertex) {
        metadata.vertex_region = vertexRegion
      }
      const result = await ttsConnectionsApi.previewVoices(
        {
          connection_id: profile?.id,
          provider,
          api_url: isVertex ? undefined : (apiUrl.trim() || undefined),
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          api_key: apiKey.trim() || undefined,
          model: model.trim() || undefined,
        },
        { signal: controller.signal },
      )
      if (voicesRequestRef.current.generation !== generation) return
      setVoices(result.voices)
    } catch {
      if (voicesRequestRef.current.generation !== generation) return
      setVoices([])
    } finally {
      if (voicesRequestRef.current.generation === generation) {
        voicesRequestRef.current = { generation }
        setVoicesLoading(false)
      }
    }
  }, [apiKey, apiUrl, isVertex, model, profile?.id, profile?.metadata, provider, vertexRegion])

  const handleModelChange = useCallback((nextModel: string) => {
    setModel(nextModel)
    if (isOpenVox && nextModel !== model) {
      cancelVoicesRequest()
      setVoicesLoading(false)
      setVoice('')
      setVoices([])
      setDefaultParameters((prev) => {
        const updated = { ...prev }
        delete updated.language
        return updated
      })
    }
  }, [cancelVoicesRequest, isOpenVox, model])

  const handleVoiceChange = useCallback((nextVoice: string) => {
    setVoice(nextVoice)
    if (!isOpenVox) return

    const selectedVoice = voiceOptions.find((option) => option.id === nextVoice)
    if (!selectedVoice?.language) return
    setDefaultParameters((prev) => ({
      ...prev,
      language: selectedVoice.language,
    }))
  }, [isOpenVox, voiceOptions])

  useEffect(() => {
    if (profile?.id && capabilities?.voiceListStyle === 'dynamic') {
      void fetchVoices()
    }
    return cancelVoicesRequest
  }, [profile?.id, capabilities?.voiceListStyle, fetchVoices, cancelVoicesRequest])

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

  const setGoogleUseStreaming = useCallback((next: boolean) => {
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
    const metadata: Record<string, any> = { ...profile?.metadata }
    if (isVertex) {
      metadata.vertex_region = vertexRegion
      if (saFileName) metadata.sa_file_name = saFileName
    } else {
      delete metadata.vertex_region
      delete metadata.sa_file_name
    }
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
    const googleDefaults: Record<string, any> = { ...defaultParameters }
    if (defaultParameters.use_streaming_endpoint === false) {
      googleDefaults.use_streaming_endpoint = false
    } else {
      delete googleDefaults.use_streaming_endpoint
    }
    const openVoxDefaults: Record<string, any> = {}
    if (isOpenVox && typeof defaultParameters.language === 'string' && defaultParameters.language.trim()) {
      openVoxDefaults.language = defaultParameters.language.trim()
    }
    onSave({
      name: name.trim(),
      provider,
      api_key: apiKey.trim() || undefined,
      api_url: isVertex ? undefined : (apiUrl.trim() || undefined),
      model: model.trim() || undefined,
      voice: voice.trim() || undefined,
      is_default: isDefault,
      default_parameters: isQwen
        ? qwenDefaults
        : isGoogle
          ? (Object.keys(googleDefaults).length > 0 ? googleDefaults : undefined)
          : isOpenVox && Object.keys(openVoxDefaults).length > 0
            ? openVoxDefaults
            : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    })
  }, [name, provider, apiKey, apiUrl, model, voice, isDefault, isQwen, isGoogle, isOpenVox, defaultParameters, onSave, isVertex, vertexRegion, saFileName, profile?.metadata])

  return (
    <div className={styles.form}>
      <FormField label={t('ttsConnectionForm.name')} required>
        <TextInput value={name} onChange={setName} placeholder={t('ttsConnectionForm.connectionName')} autoFocus={!profile} />
      </FormField>

      <FormField label={t('ttsConnectionForm.provider')}>
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

      {isVertex ? (
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
        </>
      )}

      <FormField label={t('ttsConnectionForm.model')} hint={capabilities?.modelListStyle === 'dynamic' ? t('ttsConnectionForm.refreshHint') : undefined}>
        <ModelCombobox
          value={model}
          onChange={handleModelChange}
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
          onChange={handleVoiceChange}
          models={voiceIds}
          modelLabels={voiceLabels}
          loading={voicesLoading}
          onRefresh={capabilities?.voiceListStyle === 'dynamic' ? fetchVoices : undefined}
          autoRefreshOnFocus={capabilities?.voiceListStyle === 'dynamic'}
          refreshKey={`${provider}:${profile?.id || ''}:${model}:voices`}
          disabled={isOpenVox && !model.trim()}
          appearance="standard"
          placeholder={isQwen ? t('ttsConnectionForm.qwenVoicePlaceholder') : t('ttsConnectionForm.voicePlaceholder')}
          emptyMessage={t('ttsConnectionForm.noVoices')}
        />
      </FormField>

      {isGoogle && (
        <FormField label="">
          <Toggle.Checkbox
            checked={googleUseStreaming}
            onChange={setGoogleUseStreaming}
            label={t('ttsConnectionForm.qwenUseStreaming')}
            hint={t('ttsConnectionForm.qwenUseStreamingHint')}
          />
        </FormField>
      )}

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
