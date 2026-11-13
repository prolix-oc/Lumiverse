import { useTranslation } from 'react-i18next'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import { Button, FormField, Select, TextArea, TextInput } from '@/components/shared/FormComponents'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import { Toggle } from '@/components/shared/Toggle'
import type { TtsParameterSchema } from '@/types/api'
import styles from '../ConnectionManager.module.css'

const SAMPLE_RATES: Record<string, string[]> = {
  mp3: ['32000', '44100'],
  wav: ['8000', '16000', '24000', '32000', '44100'],
  pcm: ['8000', '16000', '24000', '32000', '44100'],
  opus: ['48000'],
}
const GROUPS = ['delivery', 'sampling', 'audio', 'generation', 'pronunciation']

interface Props {
  model: string
  schema: Record<string, TtsParameterSchema>
  values: Record<string, any>
  onChange: (values: Record<string, any>) => void
}

export function fishDictionaryError(values: Record<string, any>): 'incomplete' | 'invalid' | null {
  const id = String(values.pronunciation_dictionary_id ?? '').trim()
  const version = String(values.pronunciation_dictionary_version ?? '').trim()
  if (!!id !== !!version) return 'incomplete'
  if ([id, version].some((value) => value && !/^[A-Za-z0-9_-]{1,128}$/.test(value))) return 'invalid'
  return null
}

/** Assemble Fish's settings from the same controls used elsewhere in the app. */
export default function FishAudioSettings({ model, schema, values, onChange }: Props) {
  const { t } = useTranslation('panels')
  const effectiveModel = model.trim() || 's2.1-pro'
  const format = values.format || schema.format?.default || 'mp3'
  const setValue = (key: string, value: any) => {
    const next = { ...values }
    if (value == null || value === '') delete next[key]
    else next[key] = value
    if (key === 'format' && next.sample_rate != null && !SAMPLE_RATES[value]?.includes(String(next.sample_rate))) {
      delete next.sample_rate
    }
    onChange(next)
  }
  const dictionaryError = fishDictionaryError(values)

  const renderField = (key: string, parameter: TtsParameterSchema) => {
    const label = parameter.label || key.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
    const value = values[key] ?? parameter.default
    if (parameter.type === 'boolean') {
      const checked = key === 'quality_guard' && values[key] == null
        ? values.features?.includes('quality-guard') === true
        : value === true || value === 'true'
      return <Toggle.Checkbox key={key} label={label} hint={parameter.description} checked={checked} onChange={(next) => setValue(key, next)} />
    }
    if (parameter.type === 'select') {
      const options = (parameter.options || []).filter((option) => (
        key !== 'sample_rate' || option.id === '' || SAMPLE_RATES[format]?.includes(option.id)
      ))
      return (
        <FormField key={key} label={label} hint={parameter.description}>
          <Select
            aria-label={label}
            value={options.some((option) => option.id === String(value)) ? String(value) : String(parameter.default ?? '')}
            options={options.map((option) => ({
              value: option.id,
              label: key === 'format' && option.id === 'pcm' ? t('ttsConnectionForm.fishPcmExternal') : option.label,
              disabled: key === 'format' && option.id === 'pcm',
            }))}
            onChange={(next) => setValue(key, next)}
          />
        </FormField>
      )
    }
    if (parameter.type === 'number' || parameter.type === 'integer') {
      if (parameter.min != null && parameter.max != null) {
        return (
          <LabeledRangeSlider
            key={key}
            label={label}
            hint={parameter.description}
            value={Number(value)}
            min={parameter.min}
            max={parameter.max}
            step={parameter.step}
            integer={parameter.type === 'integer'}
            onCommit={(next) => setValue(key, next)}
          />
        )
      }
      return (
        <FormField key={key} label={label} hint={parameter.description}>
          <TextInput
            aria-label={label}
            type="number"
            value={String(value ?? '')}
            step={parameter.step ?? 'any'}
            onChange={(next) => setValue(key, next === '' ? undefined : Number(next))}
          />
        </FormField>
      )
    }
    return (
      <FormField
        key={key}
        label={label}
        hint={parameter.description}
        error={dictionaryError && key === 'pronunciation_dictionary_version'
          ? t(dictionaryError === 'incomplete' ? 'ttsConnectionForm.fishDictionaryIncomplete' : 'ttsConnectionForm.fishDictionaryInvalid')
          : undefined}
      >
        {key === 'voice_direction'
          ? <TextArea aria-label={label} value={String(value ?? '')} rows={2} onChange={(next) => setValue(key, next)} />
          : <TextInput aria-label={label} value={String(value ?? '')} onChange={(next) => setValue(key, next)} />}
      </FormField>
    )
  }

  return (
    <div className={styles.manager}>
      {GROUPS.map((group) => {
        const fields = Object.entries(schema).filter(([, parameter]) => (
          parameter.group === group
          && (!parameter.models || parameter.models.includes(effectiveModel))
          && (!parameter.formats || parameter.formats.includes(format))
        ))
        if (fields.length === 0) return null
        return (
          <CollapsibleSection key={group} title={t(`ttsConnectionForm.fishGroups.${group}`)} defaultExpanded={group === 'delivery' || group === 'sampling'}>
            <div className={styles.manager}>{fields.map(([key, parameter]) => renderField(key, parameter))}</div>
          </CollapsibleSection>
        )
      })}
      <Button variant="ghost" size="sm" onClick={() => {
        const next = { ...values }
        Object.keys(schema).forEach((key) => delete next[key])
        if (Array.isArray(next.features)) {
          next.features = next.features.filter((flag: string) => flag !== 'quality-guard')
          if (next.features.length === 0) delete next.features
        }
        onChange(next)
      }}>{t('ttsConnectionForm.fishReset')}</Button>
    </div>
  )
}
