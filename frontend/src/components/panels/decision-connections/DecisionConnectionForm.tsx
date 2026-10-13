import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { decisionConnectionsApi } from '@/api/decision-connections'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import type { DecisionProviderInfo, DecisionConnectionProfile, CreateDecisionConnectionInput, DecisionModelInfo } from '@/types/api'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: DecisionProviderInfo[]
  profile?: DecisionConnectionProfile
  onSave: (input: CreateDecisionConnectionInput) => void | Promise<void>
  onCancel: () => void
}

export default function DecisionConnectionForm({ providers, profile, onSave, onCancel }: Props) {
  const { t } = useTranslation('panels')
  const [name, setName] = useState(profile?.name || '')
  const [provider, setProvider] = useState(profile?.provider || providers[0]?.id || 'openrouter')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [apiUrl, setApiUrl] = useState(profile?.api_url || '')
  const [model, setModel] = useState(profile ? profile.model : providers[0]?.capabilities.suggestedModel || '~typesafe/jev-latest')
  const [isDefault, setIsDefault] = useState(profile?.is_default || false)
  const [models, setModels] = useState<DecisionModelInfo[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const capabilities = providers.find((p) => p.id === provider)?.capabilities
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const canReuseKey = profile?.has_api_key && provider === profile.provider
    && (apiUrl.trim() || capabilities?.defaultUrl) === (profile.api_url.trim() || capabilities?.defaultUrl)
  const unsupported = models.some((option) => option.id === model && option.protocol === 'unsupported')
  const modelOptions = useMemo(() => {
    const options = models.filter((option) => option.protocol !== 'unsupported')
    if (model && !options.some((option) => option.id === model)) return [{ id: model, label: model }, ...options]
    return options
  }, [model, models])
  const modelIds = useMemo(() => modelOptions.map((option) => option.id), [modelOptions])
  const modelLabels = useMemo(() => Object.fromEntries(modelOptions.map((option) => [option.id, option.label])), [modelOptions])

  useEffect(() => {
    requestVersion.current += 1
    setModels([])
    setModelsLoading(false)
    setError(null)
    return () => { requestVersion.current += 1 }
  }, [provider, apiUrl, apiKey, clearKey])

  const changeProvider = (next: string) => {
    requestVersion.current += 1
    setProvider(next)
    setApiUrl('')
    setApiKey('')
    setClearKey(false)
    setModel(providers.find((p) => p.id === next)?.capabilities.suggestedModel || '')
    setModels([])
  }
  const fetchModels = useCallback(async () => {
    const version = ++requestVersion.current
    setModelsLoading(true)
    setError(null)
    try {
      const result = await decisionConnectionsApi.previewModels({
        connection_id: profile?.id,
        provider,
        api_url: apiUrl.trim(),
        api_key: clearKey ? '' : apiKey.trim() || undefined,
      })
      if (version !== requestVersion.current) return
      setModels(result.models)
      if (result.error) setError(result.error)
    } catch (err: any) {
      if (version === requestVersion.current) setError(err?.body?.error || err?.message || t('decisionConnectionForm.modelError'))
    } finally {
      if (version === requestVersion.current) setModelsLoading(false)
    }
  }, [apiKey, apiUrl, clearKey, profile?.id, provider, t])

  const handleSubmit = async () => {
    if (!name.trim() || !model.trim() || saving || unsupported) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(), provider, api_key: clearKey ? '' : apiKey.trim() || undefined,
        api_url: apiUrl.trim(), model: model.trim(), is_default: isDefault,
      })
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('decisionConnectionForm.saveFailed'))
    } finally { setSaving(false) }
  }

  return (
    <div className={styles.form}>
      <FormField label={t('decisionConnectionForm.name')} required>
        <TextInput value={name} onChange={setName} placeholder={t('decisionConnectionForm.connectionName')} autoFocus={!profile} />
      </FormField>
      <FormField label={t('decisionConnectionForm.provider')}>
        <Select value={provider} onChange={changeProvider} options={providerOptions} />
      </FormField>
      <FormField label={t('decisionConnectionForm.apiKey')} hint={canReuseKey && !clearKey ? t('decisionConnectionForm.keySetHint') : undefined}>
        <TextInput value={apiKey} onChange={(value) => { setApiKey(value); setClearKey(false) }} placeholder={canReuseKey && !clearKey ? '••••••••' : t('decisionConnectionForm.enterApiKey')} type="password" />
        {profile?.has_api_key && <Toggle.Checkbox checked={clearKey} onChange={(checked) => { setClearKey(checked); if (checked) setApiKey('') }} label={t('decisionConnectionForm.removeKey')} />}
      </FormField>
      <FormField label={t('decisionConnectionForm.apiUrl')} hint={t('decisionConnectionForm.apiUrlHint')}>
        <TextInput value={apiUrl} onChange={setApiUrl} placeholder={capabilities?.defaultUrl || 'https://.../v1'} />
      </FormField>
      <FormField label={t('decisionConnectionForm.model')} hint={t('decisionConnectionForm.modelHint')}>
        <ModelCombobox value={model} onChange={setModel} models={modelIds} modelLabels={modelLabels} loading={modelsLoading}
          onRefresh={fetchModels} autoRefreshOnFocus refreshKey={provider + ':' + apiUrl + ':' + (profile?.id || '')}
          appearance="standard" placeholder={t('decisionConnectionForm.modelPlaceholder')} emptyMessage={t('decisionConnectionForm.noModels')} />
      </FormField>
      {unsupported && <p role="alert">{t('decisionConnectionForm.unsupportedModel')}</p>}
      {error && <p role="alert">{error}</p>}
      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label={t('decisionConnectionForm.setDefault')} />
      </FormField>
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>{t('decisionConnectionForm.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim() || !model.trim() || saving || unsupported}>
          {profile ? t('decisionConnectionForm.save') : t('decisionConnectionForm.create')}
        </Button>
      </div>
    </div>
  )
}
