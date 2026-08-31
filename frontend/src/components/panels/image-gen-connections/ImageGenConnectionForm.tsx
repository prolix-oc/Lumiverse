import { useState, useCallback, useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import ModelCombobox from '../connection-manager/ModelCombobox'
import { Toggle } from '@/components/shared/Toggle'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type {
  ImageGenProviderInfo,
  ImageGenConnectionProfile,
  CreateImageGenConnectionInput,
} from '@/types/api'
import ConnectionReviewStatus from '@/components/shared/ConnectionReviewStatus'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: ImageGenProviderInfo[]
  profile?: ImageGenConnectionProfile
  onSave: (input: CreateImageGenConnectionInput) => void
  onCancel: () => void
  onReview?: () => Promise<void> | void
  focusTargetRef?: RefObject<HTMLElement | null>
}

export default function ImageGenConnectionForm({ providers, profile, onSave, onCancel, onReview, focusTargetRef }: Props) {
  const { t } = useTranslation('panels')
  const reviewRequired = profile?.review_required === true
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

  const modelIds = useMemo(() => modelOptions.map((m) => m.id), [modelOptions])
  const modelLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const m of modelOptions) labels[m.id] = m.label
    return labels
  }, [modelOptions])
  const isDynamicModelList = capabilities?.modelListStyle !== 'static'

  const fetchModels = useCallback(async () => {
    if (reviewRequired) return
    setModelsLoading(true)
    try {
      const result = await imageGenConnectionsApi.previewModels({
        connection_id: profile?.id,
        provider,
        api_url: apiUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      })
      if (result.models.length > 0) setModels(result.models)
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
          if (!cancelled) setByopStatus(t('connectionForm.pollinationsSaved'))
        } catch {
          if (!cancelled) {
            setByopStatus(t('connectionForm.pollinationsAutoSaveFailed'))
          }
        }
      } else if (!cancelled) {
        setByopStatus(t('connectionForm.pollinationsCaptured'))
      }

      clearRedirectArtifacts()
    }

    void applyReturnedKey()
    return () => {
      cancelled = true
    }
  }, [isPollinations, profile?.id, t])

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
      const msg = String(err?.message || t('connectionForm.pollinationsStartFailed'))
      setByopStatus(msg)
      setByopLoading(false)
    }
  }, [model, profile?.id, t])

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
      <FormField label={t('connectionForm.name')} required>
        <TextInput value={name} onChange={setName} placeholder={t('connectionForm.connectionName')} autoFocus={!profile} />
      </FormField>

      <FormField label={t('connectionForm.provider')}>
        <Select value={provider} onChange={setProvider} options={providerOptions} />
      </FormField>

      {isPollinations && (
        <FormField label={t('connectionForm.pollinationsByop')} hint={t('connectionForm.pollinationsByopHint')}>
          <div className={styles.byopRow}>
            <Button
              variant="secondary"
              size="sm"
              onClick={handlePollinationsSignIn}
              disabled={byopLoading}
            >
              {byopLoading ? t('connectionForm.redirecting') : t('connectionForm.signInWithPollinations')}
            </Button>
            {byopStatus && <span className={styles.byopStatus}>{byopStatus}</span>}
          </div>
        </FormField>
      )}

      <FormField label={t('connectionForm.apiKey')} hint={profile?.has_api_key ? t('connectionForm.keyAlreadySet') : undefined}>
        <TextInput
          value={apiKey}
          onChange={setApiKey}
          placeholder={profile?.has_api_key ? '••••••••' : t('connectionForm.enterApiKey')}
          type="password"
        />
      </FormField>

      <FormField label={t('connectionForm.apiUrl')} hint={t('connectionForm.defaultApiUrlHint')}>
        <TextInput
          value={apiUrl}
          onChange={setApiUrl}
          placeholder={capabilities?.defaultUrl || 'https://...'}
        />
      </FormField>

      <FormField label={t('connectionForm.model')} hint={isDynamicModelList ? t('connectionForm.modelHint') : undefined}>
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={modelIds}
          modelLabels={modelLabels}
          loading={modelsLoading}
          onRefresh={isDynamicModelList ? fetchModels : undefined}
          autoRefreshOnFocus={isDynamicModelList}
          refreshKey={`${provider}:${apiUrl}`}
          placeholder={t('imageGenConnectionForm.selectModel')}
          emptyMessage={isDynamicModelList ? t('imageGenConnectionForm.noModelsDynamic') : t('imageGenConnectionForm.noModelsStatic')}
          appearance="standard"
        />
      </FormField>

      <FormField label="">
        <Toggle.Checkbox checked={isDefault} onChange={setIsDefault} label={t('imageGenConnectionForm.setAsDefault')} />
      </FormField>

      </fieldset>
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('connectionForm.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          {profile ? t('connectionForm.save') : t('connectionForm.create')}
        </Button>
      </div>
    </div>
  )
}
