import { saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import ConnectionFolderField, { useConnectionFolderDraft } from '@/components/panels/connection-manager/ConnectionFolderField'
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { decisionConnectionsApi } from '@/api/decision-connections'
import { buildOpenRouterOAuthCallbackUrl } from '@/api/openrouter'
import { buildNanoGptOAuthCallbackUrl } from '@/api/nanogpt'
import { startProviderOAuthPopup } from '@/lib/providerOAuthPopup'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import type { DecisionProviderInfo, DecisionConnectionProfile, CreateDecisionConnectionInput, DecisionModelInfo } from '@/types/api'
import styles from '../ConnectionManager.module.css'

interface Props {
  providers: DecisionProviderInfo[]
  profile?: DecisionConnectionProfile
  onSave: (input: CreateDecisionConnectionInput, folderId?: string) => void | Promise<void>
  onCancel: () => void
  onOAuthComplete?: (profile: DecisionConnectionProfile, created: boolean) => void
}

export default function DecisionConnectionForm({ providers, profile, onSave, onCancel, onOAuthComplete }: Props) {
  const folder = useConnectionFolderDraft('decision', profile?.id)
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
  const oauthCleanup = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<string | null>(null)
  const [authenticatedProfile, setAuthenticatedProfile] = useState<DecisionConnectionProfile | null>(null)

  const capabilities = providers.find((p) => p.id === provider)?.capabilities
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const keyProfile = authenticatedProfile || profile
  const normalizedUrl = (value: string) => (value.trim() || capabilities?.defaultUrl || '').replace(/\/+$/, '')
  const canReuseKey = keyProfile?.has_api_key && provider === keyProfile.provider
    && normalizedUrl(apiUrl) === normalizedUrl(keyProfile.api_url)
  const supportsSignIn = provider === 'openrouter' || provider === 'nanogpt'
  const defaultEndpoint = normalizedUrl(apiUrl) === normalizedUrl('')
  const savedTargetMatches = !profile || profile.provider === provider && normalizedUrl(profile.api_url) === normalizedUrl(apiUrl)
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
  }, [provider, apiUrl, apiKey, clearKey, authenticatedProfile])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; oauthCleanup.current?.() }
  }, [])

  useEffect(() => { setOauthStatus(null) }, [provider, apiUrl])

  const changeProvider = (next: string) => {
    requestVersion.current += 1
    setProvider(next)
    setApiUrl('')
    setApiKey('')
    setClearKey(false)
    setModel(providers.find((p) => p.id === next)?.capabilities.suggestedModel || '')
    setModels([])
    setAuthenticatedProfile(null)
  }

  const handleSignIn = async () => {
    if (!supportsSignIn || !defaultEndpoint || !savedTargetMatches || oauthLoading || saving || !name.trim() || !model.trim() || unsupported) return
    setOauthLoading(true)
    setOauthStatus(null)
    setError(null)
    try {
      const callbackUrl = provider === 'openrouter' ? buildOpenRouterOAuthCallbackUrl() : buildNanoGptOAuthCallbackUrl()
      const flow = startProviderOAuthPopup({
        provider,
        callbackUrl,
        initiate: () => decisionConnectionsApi.initiateAuth(provider, callbackUrl, profile
          ? { connection_id: profile.id }
          : { connection: { name: name.trim(), provider, api_url: apiUrl.trim(), model: model.trim(), is_default: isDefault } }),
      })
      oauthCleanup.current = flow.cancel
      const authorization = await flow.result
      if (!authorization || !mounted.current) return
      const result = await decisionConnectionsApi.completeAuth(authorization.sessionToken, authorization.code)
      if (!mounted.current) return
      setAuthenticatedProfile(result.profile)
      setApiKey('')
      setClearKey(false)
      setOauthStatus(t('decisionConnectionForm.signInSaved'))
      if (result.created) saveConnectionFolder('decision', result.profile.id, folder.value)
      onOAuthComplete?.(result.profile, result.created)
    } catch (err: any) {
      if (mounted.current) setError(err?.body?.error || err?.message || t('decisionConnectionForm.signInFailed'))
    } finally {
      oauthCleanup.current = null
      if (mounted.current) setOauthLoading(false)
    }
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
    if (!name.trim() || !model.trim() || saving || oauthLoading || unsupported) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(), provider, api_key: clearKey ? '' : apiKey.trim() || undefined,
        api_url: apiUrl.trim(), model: model.trim(), is_default: isDefault,
      }, folder.value)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('decisionConnectionForm.saveFailed'))
    } finally { setSaving(false) }
  }

  return (
    <div className={styles.form}>
      <fieldset disabled={oauthLoading} className={styles.formFields}>
        <FormField label={t('decisionConnectionForm.name')} required>
          <TextInput value={name} onChange={setName} placeholder={t('decisionConnectionForm.connectionName')} autoFocus={!profile} />
        </FormField>
      <ConnectionFolderField kind="decision" {...folder} />
        <FormField label={t('decisionConnectionForm.provider')}>
          <Select value={provider} onChange={changeProvider} options={providerOptions} />
        </FormField>
        {supportsSignIn && (
          <FormField label={t('decisionConnectionForm.providerSignIn')} hint={t(!defaultEndpoint
            ? 'decisionConnectionForm.signInDefaultUrl'
            : !savedTargetMatches ? 'decisionConnectionForm.signInSaveFirst'
            : profile ? 'decisionConnectionForm.signInHintExisting' : 'decisionConnectionForm.signInHintCreate')}>
            <Button variant="secondary" size="sm" onClick={handleSignIn}
              disabled={oauthLoading || saving || !defaultEndpoint || !savedTargetMatches || !name.trim() || !model.trim() || unsupported}>
              {oauthLoading ? t('decisionConnectionForm.signingIn') : t('decisionConnectionForm.signIn', { provider: providers.find((p) => p.id === provider)?.name })}
            </Button>
            {oauthStatus && <span role="status">{oauthStatus}</span>}
          </FormField>
        )}
        <FormField label={t('decisionConnectionForm.apiKey')} hint={canReuseKey && !clearKey ? t('decisionConnectionForm.keySetHint') : undefined}>
          <TextInput value={apiKey} onChange={(value) => { setApiKey(value); setClearKey(false); setOauthStatus(null) }} placeholder={canReuseKey && !clearKey ? '••••••••' : t('decisionConnectionForm.enterApiKey')} type="password" />
          {keyProfile?.has_api_key && <Toggle.Checkbox checked={clearKey} onChange={(checked) => { setClearKey(checked); setOauthStatus(null); if (checked) setApiKey('') }} label={t('decisionConnectionForm.removeKey')} />}
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
      </fieldset>
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>{t('decisionConnectionForm.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!name.trim() || !model.trim() || saving || oauthLoading || unsupported}>
          {profile ? t('decisionConnectionForm.save') : t('decisionConnectionForm.create')}
        </Button>
      </div>
    </div>
  )
}
