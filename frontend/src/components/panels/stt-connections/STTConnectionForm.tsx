import { useState, useCallback, useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { sttConnectionsApi } from '@/api/stt-connections'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import type {
  SttProviderInfo,
  SttConnectionProfile,
  CreateSttConnectionInput,
} from '@/types/api'
import ConnectionReviewStatus from '@/components/shared/ConnectionReviewStatus'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: SttProviderInfo[]
  profile?: SttConnectionProfile
  onSave: (input: CreateSttConnectionInput) => void
  onCancel: () => void
  onReview?: () => Promise<void> | void
  focusTargetRef?: RefObject<HTMLElement | null>
}
export default function STTConnectionForm({ providers, profile, onSave, onCancel, onReview, focusTargetRef }: Props) {
  const { t } = useTranslation('panels')
  const reviewRequired = profile?.review_required === true
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || providers[0]?.id || 'openai')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile?.model || '')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const selectedProvider = providers.find((p) => p.id === provider)
  const capabilities = selectedProvider?.capabilities
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))

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
  const fetchModels = useCallback(async () => {
    if (reviewRequired) return
    setModelsLoading(true)
    try {
      const result = await sttConnectionsApi.previewModels({
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
  }, [apiKey, apiUrl, profile?.id, provider, reviewRequired])

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
      {profile && <ConnectionReviewStatus profile={profile} onReview={onReview ?? (() => undefined)} focusTargetRef={focusTargetRef} />}
      <fieldset disabled={reviewRequired} style={{ border: 0, padding: 0, margin: 0 }}>
      <FormField label={t('sttConnectionForm.name')} required>
        <TextInput value={name} onChange={setName} placeholder={t('sttConnectionForm.connectionName')} autoFocus={!profile} />
      </FormField>

      <FormField label={t('sttConnectionForm.provider')}>
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

      {capabilities?.apiKeyRequired && (
        <FormField label={t('sttConnectionForm.apiKey')} hint={profile?.has_api_key ? t('sttConnectionForm.keySetHint') : undefined}>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            placeholder={profile?.has_api_key ? '••••••••' : t('sttConnectionForm.enterApiKey')}
            type="password"
          />
        </FormField>
      )}

      <FormField label={t('sttConnectionForm.apiUrl')} hint={t('sttConnectionForm.apiUrlHint')}>
        <TextInput
          value={apiUrl}
          onChange={setApiUrl}
          placeholder={capabilities?.defaultUrl || 'https://...'}
        />
      </FormField>

      <FormField label={t('sttConnectionForm.model')} hint={t('sttConnectionForm.modelHint')}>
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={modelIds}
          modelLabels={modelLabels}
          loading={modelsLoading}
          onRefresh={fetchModels}
          autoRefreshOnFocus
          refreshKey={`${provider}:${profile?.id || ''}`}
          appearance="standard"
          placeholder={t('sttConnectionForm.modelPlaceholder')}
          emptyMessage={t('sttConnectionForm.noModels')}
        />
      </FormField>

      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label={t('sttConnectionForm.setDefault')} />
      </FormField>

      </fieldset>
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('sttConnectionForm.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? t('sttConnectionForm.save') : t('sttConnectionForm.create')}
        </Button>
      </div>
    </div>
  )
}
