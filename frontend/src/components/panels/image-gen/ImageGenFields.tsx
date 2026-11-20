import { useState, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Shuffle } from 'lucide-react'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { Button, FormField, Select, TextInput, TextArea } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import { snapRangeValue } from '@/components/shared/rangeSliderMath'
import ModelCombobox from '../connection-manager/ModelCombobox'
import type { ImageGenConnectionProfile, ImageGenParameterSchema } from '@/types/api'
import type { LoraModelLoader } from '../imageGenLoraEditor'
import styles from '../ImageGenPanel.module.css'
const loadImageGenModels: LoraModelLoader = (id, subtype) => imageGenConnectionsApi.modelsBySubtype(id, subtype)
type ModelLoadResult = {
  profile: ImageGenConnectionProfile
  modelSubtype: string
  models: Array<{ id: string; label: string }>
  error: string | null
  loading: boolean
}

const modelRefreshKeys = new WeakMap<ImageGenConnectionProfile, number>()
let nextModelRefreshKey = 1

function modelRefreshKey(profile: ImageGenConnectionProfile | null, modelSubtype: string): string {
  if (!profile) return `none:${modelSubtype}`
  let key = modelRefreshKeys.get(profile)
  if (!key) {
    key = nextModelRefreshKey++
    modelRefreshKeys.set(profile, key)
  }
  return `${key}:${modelSubtype}`
}


function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeSliderSchemaValue(value: unknown, schema: ImageGenParameterSchema): number | null {
  if ((schema.type !== 'number' && schema.type !== 'integer') || schema.min === undefined || schema.max === undefined) {
    return null
  }

  const numeric = coerceFiniteNumber(value) ?? coerceFiniteNumber(schema.default) ?? schema.min
  const step = schema.step ?? (schema.type === 'integer' ? 1 : 0.1)
  return snapRangeValue(numeric, {
    min: schema.min,
    max: schema.max,
    step,
    integer: schema.type === 'integer',
  })
}

export function ToggleRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string }) {
  return (
    <Toggle.Checkbox
      checked={checked}
      onChange={onChange}
      label={label}
      hint={hint}
      className={styles.toggle}
    />
  )
}

/**
 * Image-gen variant of the shared ModelCombobox. Lazy-loads the model list
 * from the provider via `imageGenConnectionsApi.modelsBySubtype` and surfaces
 * the standard searchable combobox UI used by Connections / TTS / STT panels.
 */
export function ModelComboField({
  label,
  hint,
  paramKey,
  modelSubtype,
  activeConnection,
  value,
  onChange,
  loadModels = loadImageGenModels,
}: {
  label: string
  hint: string
  paramKey: string
  modelSubtype: string
  activeConnection: ImageGenConnectionProfile | null
  value: any
  onChange: (key: string, value: any) => void
  loadModels?: LoraModelLoader
}) {
  const { t } = useTranslation('panels')
  const [result, setResult] = useState<ModelLoadResult | null>(null)
  const latestInputsRef = useRef({ activeConnection, modelSubtype, loadModels })
  const requestIdRef = useRef(0)
  latestInputsRef.current = { activeConnection, modelSubtype, loadModels }

  const currentResult = result
    && result.profile.id === activeConnection?.id
    && result.modelSubtype === modelSubtype
  const models = useMemo(() => currentResult ? result.models : [], [currentResult, result?.models])
  const modelError = currentResult ? result.error : null
  const loading = currentResult ? result.loading : false

  const load = useCallback(async () => {
    if (!activeConnection) return
    const profile = activeConnection
    const subtype = modelSubtype
    const requestId = ++requestIdRef.current
    setResult({ profile, modelSubtype: subtype, models: [], error: null, loading: true })

    try {
      const response = await loadModels(profile.id, subtype)
      if (
        requestId !== requestIdRef.current
        || latestInputsRef.current.activeConnection !== profile
        || latestInputsRef.current.modelSubtype !== subtype
        || latestInputsRef.current.loadModels !== loadModels
      ) return

      const error = typeof response.error === 'string' && response.error.trim()
        ? response.error.trim()
        : null
      setResult({
        profile,
        modelSubtype: subtype,
        models: error ? [] : response.models ?? [],
        error,
        loading: false,
      })
    } catch (err: unknown) {
      if (
        requestId !== requestIdRef.current
        || latestInputsRef.current.activeConnection !== profile
        || latestInputsRef.current.modelSubtype !== subtype
        || latestInputsRef.current.loadModels !== loadModels
      ) return

      const message = err instanceof Error && err.message.trim()
        ? err.message.trim()
        : t('imageGenPanel.noModelsFound')
      setResult({ profile, modelSubtype: subtype, models: [], error: message, loading: false })
    }
  }, [activeConnection, loadModels, modelSubtype, t])

  const modelIds = useMemo(() => models.map((model) => model.id), [models])
  const modelLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const model of models) labels[model.id] = model.label
    return labels
  }, [models])

  const emptyMessage = activeConnection
    ? t('imageGenPanel.noModelsFound')
    : t('imageGenPanel.pickConnectionFirst')

  return (
    <FormField label={label} hint={hint}>
      <ModelCombobox
        value={typeof value === 'string' ? value : ''}
        onChange={(nextValue) => onChange(paramKey, nextValue || undefined)}
        models={modelIds}
        modelLabels={modelLabels}
        loading={loading}
        onRefresh={load}
        autoRefreshOnFocus
        refreshKey={modelRefreshKey(activeConnection, modelSubtype)}
        disabled={!activeConnection}
        placeholder={t('imageGenPanel.workflowOrConnectionDefault')}
        appearance="standard"
        emptyMessage={modelError || emptyMessage}
      />
    </FormField>
  )
}

/** Render a single parameter from the provider capability schema */
/** Raw Request Override editor — validates JSON inline so typos don't silently break generation. */
function RawOverrideField({
  label,
  schema,
  value,
  onChange,
}: {
  label: string
  schema: ImageGenParameterSchema
  value: any
  onChange: (value: string) => void
}) {
  const { t } = useTranslation('panels')
  const text = typeof value === 'string' ? value : ''
  let error: string | undefined
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        error = t('imageGenPanel.rawOverrideNotObject')
      }
    } catch {
      error = t('imageGenPanel.rawOverrideInvalidJson')
    }
  }
  return (
    <FormField label={label} hint={schema.description} error={error}>
      <TextArea rows={3} value={text} onChange={onChange} placeholder='{"steps": 30}' />
    </FormField>
  )
}

export function ParamField({
  paramKey,
  schema,
  value,
  onChange,
  activeConnection,
}: {
  paramKey: string
  schema: ImageGenParameterSchema
  value: any
  onChange: (key: string, value: any) => void
  activeConnection?: ImageGenConnectionProfile | null
}) {
  const displayName = /^(negative[_]?prompt)$/i.test(paramKey) ? "Provider Negative Prompt" : paramKey
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/^Unet\b/, 'UNet')
    .trim()
  const normalizedSliderValue = useMemo(
    () => normalizeSliderSchemaValue(value, schema),
    [schema, value],
  )

  // Model-component fields get a combobox backed by the API
  if (schema.modelSubtype && schema.type === 'string') {
    return (
      <ModelComboField
        label={displayName}
        hint={schema.description}
        paramKey={paramKey}
        modelSubtype={schema.modelSubtype}
        activeConnection={activeConnection ?? null}
        value={value}
        onChange={onChange}
      />
    )
  }

  switch (schema.type) {
    case 'select':
      return (
        <FormField label={displayName} hint={schema.description}>
          <Select
            aria-label={displayName}
            value={value ?? schema.default ?? ''}
            onChange={(v) => onChange(paramKey, v)}
            options={(schema.options || []).map((o) => ({ value: o.id, label: o.label }))}
          />
        </FormField>
      )

    case 'boolean':
      return (
        <FormField label="" hint={schema.description}>
          <ToggleRow
            checked={value ?? schema.default ?? false}
            onChange={(checked) => onChange(paramKey, checked)}
            label={displayName}
          />
        </FormField>
      )

    case 'number':
    case 'integer':
      if (schema.min !== undefined && schema.max !== undefined) {
        const numValue = normalizedSliderValue ?? coerceFiniteNumber(schema.default) ?? schema.min
        const step = schema.step ?? (schema.type === 'integer' ? 1 : 0.1)
        const isInt = schema.type === 'integer'
        return (
          <LabeledRangeSlider
            label={displayName}
            hint={schema.description}
            min={schema.min}
            max={schema.max}
            step={step}
            integer={isInt}
            value={numValue}
            formatValue={(v) => isInt ? String(v) : v.toFixed(step < 1 ? 2 : 1)}
            onCommit={(v) =>
              onChange(
                paramKey,
                snapRangeValue(v, {
                  min: schema.min!,
                  max: schema.max!,
                  step,
                  integer: isInt,
                }),
              )}
          />
        )
      }
      if (schema.type === 'integer' && paramKey.toLowerCase() === 'seed') {
        return (
          <FormField label={displayName} hint={schema.description}>
            <div className={styles.inlineRow}>
              <TextInput
            aria-label={displayName}
                className={styles.inlineGrow}
                value={value != null ? String(value) : ''}
                onChange={(v) => {
                  const parsed = parseInt(v)
                  onChange(paramKey, v === '' ? undefined : (isNaN(parsed) ? undefined : parsed))
                }}
                placeholder={schema.default != null ? String(schema.default) : ''}
              />
              <Button
                variant="secondary"
                size="sm"
                icon={<Shuffle size={14} />}
                onClick={() => onChange(paramKey, -1)}
              >
                Randomize
              </Button>
            </div>
          </FormField>
        )
      }
      return (
        <FormField label={displayName} hint={schema.description}>
          <TextInput
            aria-label={displayName}
            value={value != null ? String(value) : ''}
            onChange={(v) => {
              const parsed = schema.type === 'integer' ? parseInt(v) : parseFloat(v)
              onChange(paramKey, v === '' ? undefined : (isNaN(parsed) ? undefined : parsed))
            }}
            placeholder={schema.default != null ? String(schema.default) : ''}
          />
        </FormField>
      )

    case 'string':
      if (paramKey === 'rawRequestOverride') {
        return (
          <RawOverrideField
            label={displayName}
            schema={schema}
            value={value}
            onChange={(v) => onChange(paramKey, v)}
          />
        )
      }
      if (schema.description?.toLowerCase().includes('prompt') || schema.description?.toLowerCase().includes('negative')) {
        return (
          <FormField label={displayName} hint={schema.description}>
            <TextArea
              aria-label={displayName}
              rows={3}
              value={value ?? schema.default ?? ''}
              onChange={(v) => onChange(paramKey, v)}
              placeholder={schema.default != null ? String(schema.default) : ''}
            />
          </FormField>
        )
      }
      return (
        <FormField label={displayName} hint={schema.description}>
          <TextInput
            aria-label={displayName}
            value={value ?? schema.default ?? ''}
            onChange={(v) => onChange(paramKey, v)}
          />
        </FormField>
      )

    default:
      return null
  }
}