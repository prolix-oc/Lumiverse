import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, RefreshCw, Settings2 } from 'lucide-react'
import { nanoGptApi, type NanoGptConnectionSettings, type NanoGptModelProviders, type NanoGptProviderRouting } from '@/api/nanogpt'
import { updateNanoGptModelRouting } from '@/lib/nanogpt-routing'
import { Button, FormField, Select } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { Spinner } from '@/components/shared/Spinner'
import MultiChipSelect from './MultiChipSelect'
import styles from './NanoGptSettings.module.css'
import sectionStyles from './OpenRouterSettings.module.css'

interface Props {
  settings: NanoGptConnectionSettings
  onChange: (settings: NanoGptConnectionSettings) => void
  model: string
  connectionId?: string
  apiKey: string
  apiUrl: string
  hasApiKey: boolean
  subscriptionOnly: boolean
}

function formatPrice(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${(value * 1000).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : '—'
}

export default function NanoGptSettings({ settings, onChange, model, connectionId, apiKey, apiUrl, hasApiKey, subscriptionOnly }: Props) {
  const { t } = useTranslation('panels', { keyPrefix: 'nanoGptSettings' })
  const [sectionOpen, setSectionOpen] = useState(false)
  const sectionId = useId()
  const [discovery, setDiscovery] = useState<{ model: string; data?: NanoGptModelProviders; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const modelId = model.trim()
  const canDiscover = !!modelId && (!!apiKey.trim() || hasApiKey)

  useEffect(() => {
    let cancelled = false
    setDiscovery(null)
    setLoading(canDiscover)
    if (!canDiscover) return
    const timer = setTimeout(() => {
      nanoGptApi.providers({ connection_id: connectionId, api_key: apiKey.trim() || undefined, api_url: apiUrl.trim() || undefined, model: modelId })
        .then((data) => { if (!cancelled) setDiscovery({ model: modelId, data }) })
        .catch((err) => { if (!cancelled) setDiscovery({ model: modelId, error: err.body?.error || err.message || t('discoveryFailed') }) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [modelId, connectionId, apiKey, apiUrl, canDiscover, refresh, t])

  const data = discovery?.model === modelId ? discovery.data : undefined
  const error = discovery?.model === modelId ? discovery.error : undefined
  const routing = settings.model_overrides?.[modelId] || {}
  const updateRouting = (patch: Partial<NanoGptProviderRouting>) => onChange(updateNanoGptModelRouting(settings, modelId, patch))
  const options = (data?.providers || []).filter((p) => p.available).map((p) => ({ value: p.provider, label: p.displayName || p.provider }))
  const exclusionOptions = (data?.providers || []).map((p) => ({ value: p.provider, label: p.displayName || p.provider }))
  const savedRouting = Object.keys(routing).length > 0

  return (
    <div className={styles.container} data-component="NanoGptSettings">
      <div className={styles.header}>
        <button
          type="button"
          className={`${sectionStyles.sectionToggle} ${styles.sectionToggle}`}
          aria-expanded={sectionOpen}
          aria-controls={sectionId}
          onClick={() => setSectionOpen((open) => !open)}
        >
          <ChevronRight size={12} className={`${sectionStyles.sectionChevron} ${sectionOpen ? sectionStyles.sectionChevronOpen : ''}`} />
          <Settings2 size={13} className={sectionStyles.sectionToggleIcon} />
          <span>{t('title')}</span>
        </button>
        <Button size="icon-sm" variant="ghost" title={t('refresh')} aria-label={t('refresh')} disabled={!canDiscover || loading} onClick={() => setRefresh((n) => n + 1)} icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} />
      </div>
      {sectionOpen && (
        <div id={sectionId} className={`${sectionStyles.sectionContent} ${styles.sectionContent}`}>
          <Toggle.Checkbox className={styles.checkbox} checked={settings.billing_mode === 'paygo'} disabled={subscriptionOnly} onChange={(enabled) => onChange({ ...settings, billing_mode: enabled ? 'paygo' : undefined })} label={t('forcePaygo')} hint={t('forcePaygoHint')} />
          <p className={styles.hint}>{subscriptionOnly ? t('subscriptionOnlyHint') : t('billingHint')}</p>
          {!canDiscover && <p className={styles.hint}>{t('needsModelAndKey')}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          {data && !data.supportsProviderSelection && <p className={styles.hint}>{t('unsupported')}</p>}
          {savedRouting && <Button size="sm" variant="ghost" onClick={() => {
            const model_overrides = { ...settings.model_overrides }
            delete model_overrides[modelId]
            onChange({ ...settings, model_overrides })
          }}>{t('reset')}</Button>}
          {data?.supportsProviderSelection && (
            <>
              <p className={styles.hint}>{t('perModel', { model: data.displayName })}</p>
              <fieldset className={styles.controls} disabled={subscriptionOnly}>
                <FormField label={t('sort')}>
                  <Select aria-label={t('sort')} value={routing.sort || ''} onChange={(sort) => updateRouting({ sort: (sort || undefined) as NanoGptProviderRouting['sort'] })} options={[
                    { value: '', label: t('inherit') }, { value: 'auto', label: t('auto') },
                    ...['price', 'speed', 'throughput', 'latency'].map((value) => ({ value, label: t(value) })),
                  ]} />
                </FormField>
                <FormField label={t('only')} hint={t('onlyHint')}>
                  <MultiChipSelect options={options} selected={routing.only || []} onChange={(only) => updateRouting({ only })} />
                </FormField>
                <FormField label={t('order')} hint={t('orderHint')}>
                  <MultiChipSelect options={options} selected={routing.order || []} onChange={(order) => updateRouting({ order })} />
                </FormField>
                <FormField label={t('ignore')}>
                  <MultiChipSelect options={exclusionOptions} selected={routing.ignore || []} onChange={(ignore) => updateRouting({ ignore })} />
                </FormField>
                <Toggle.Checkbox className={styles.checkbox} checked={routing.allow_fallbacks !== false} onChange={(enabled) => updateRouting({ allow_fallbacks: enabled ? undefined : false })} label={t('fallbacks')} hint={t('fallbacksHint')} />
                <Toggle.Checkbox className={styles.checkbox} checked={routing.require_parameters === true} onChange={(enabled) => updateRouting({ require_parameters: enabled ? true : undefined })} label={t('requireParameters')} />
              </fieldset>
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <caption>{t('pricingCaption')}</caption>
                  <thead><tr><th>{t('provider')}</th><th>{t('input')}</th><th>{t('output')}</th></tr></thead>
                  <tbody>
                    {data.defaultPrice && <tr><td>{t('autoPrice')}</td><td>{formatPrice(data.defaultPrice.inputPer1kTokens)}</td><td>{formatPrice(data.defaultPrice.outputPer1kTokens)}</td></tr>}
                    {data.providers.map((p) => {
                      const price = p.effectivePricing?.effective_price || p.pricing
                      return <tr key={p.provider}><td>{p.displayName || p.provider}{!p.available && ` (${t('unavailable')})`}{p.quantization && ` · ${p.quantization}`}</td><td>{formatPrice(price?.inputPer1kTokens)}</td><td>{formatPrice(price?.outputPer1kTokens)}</td></tr>
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
