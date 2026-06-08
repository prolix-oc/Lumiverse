import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/store'
import { connectionsApi } from '@/api/connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { sttConnectionsApi } from '@/api/stt-connections'
import ProviderIcon from './ProviderIcon'
import SearchableSelect, { type SearchableSelectOption } from './SearchableSelect'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import styles from './ConnectionSelect.module.css'

export type ConnectionKind = 'llm' | 'imageGen' | 'tts' | 'stt'

/** The fields every connection-profile variant shares; enough to render a row. */
interface ConnectionLike {
  id: string
  name: string
  provider: string
  model?: string
}

interface ConnectionSelectProps {
  /** Picks both the store slice that supplies the list and the models endpoint. */
  kind: ConnectionKind
  /** Selected connection id; '' means none selected. */
  value: string
  onChange: (id: string) => void

  /** Render a paired model picker beneath the selector (llm / imageGen / tts / stt). */
  withModel?: boolean
  modelValue?: string
  onModelChange?: (model: string) => void

  // Pass-throughs to SearchableSelect — all optional; SearchableSelect supplies
  // translated defaults for the message props when omitted.
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  ariaLabel?: string
  disabled?: boolean
  portal?: boolean
  align?: 'left' | 'right'
  clearable?: boolean
  clearLabel?: string
  triggerClassName?: string

  // Pass-throughs to the paired ModelCombobox (only used when withModel).
  modelPlaceholder?: string
  modelEmptyMessage?: string
  modelNoConnectionMessage?: string
  modelAppearance?: 'compact' | 'standard' | 'editor'
}

/** Normalise the per-kind models endpoint into the shape ModelCombobox wants. */
async function fetchModels(
  kind: ConnectionKind,
  id: string,
): Promise<{ models: string[]; labels: Record<string, string> }> {
  if (kind === 'llm') {
    const r = await connectionsApi.models(id)
    return { models: r.models || [], labels: r.model_labels || {} }
  }
  // imageGen / tts / stt all return Array<{ id, label }>.
  const api =
    kind === 'imageGen' ? imageGenConnectionsApi : kind === 'tts' ? ttsConnectionsApi : sttConnectionsApi
  const r = await api.models(id)
  const models = (r.models || []).map((m) => m.id)
  const labels: Record<string, string> = {}
  for (const m of r.models || []) labels[m.id] = m.label
  return { models, labels }
}

/**
 * Standardised connection picker. Reads the connection list from the store slice
 * for `kind` (the single source of truth — see useAppInit's load-all-at-init),
 * renders each profile with the panel's provider icon + "model · provider" sublabel,
 * and optionally pairs a model combobox whose list it fetches and owns.
 */
export default function ConnectionSelect({
  kind,
  value,
  onChange,
  withModel = false,
  modelValue,
  onModelChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  ariaLabel,
  disabled,
  portal,
  align,
  clearable,
  clearLabel,
  triggerClassName,
  modelPlaceholder,
  modelEmptyMessage,
  modelNoConnectionMessage,
  modelAppearance,
}: ConnectionSelectProps) {
  const profiles = useStore((s) =>
    kind === 'llm'
      ? s.profiles
      : kind === 'imageGen'
        ? s.imageGenProfiles
        : kind === 'tts'
          ? s.ttsProfiles
          : s.sttProfiles,
  ) as ConnectionLike[]

  const options: SearchableSelectOption[] = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.id,
        label: p.name,
        sublabel: p.model ? `${p.provider} / ${p.model}` : p.provider,
        leading: <ProviderIcon kind={kind} provider={p.provider} fill />,
      })),
    [profiles, kind],
  )

  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)

  const loadModels = useCallback(async () => {
    if (!withModel || !value) {
      setModels([])
      setModelLabels({})
      return
    }
    setModelsLoading(true)
    try {
      const result = await fetchModels(kind, value)
      setModels(result.models)
      setModelLabels(result.labels)
    } catch {
      setModels([])
      setModelLabels({})
    } finally {
      setModelsLoading(false)
    }
  }, [withModel, value, kind])

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  // Switching connections replaces the model with the new connection's
  // configured default (the old model may not exist on the new connection).
  const handleConnectionChange = useCallback(
    (next: string) => {
      onChange(next)
      if (withModel && next !== value) {
        const profile = profiles.find((p) => p.id === next) || null
        onModelChange?.(profile?.model || '')
      }
    },
    [onChange, withModel, value, profiles, onModelChange],
  )

  // Seed the model from the connection's default when a connection is already
  // selected on mount but no model is set yet (e.g. a panel that defaults to the
  // active connection). Runs once, so the user can still clear the field after.
  const seededModelRef = useRef(false)
  useEffect(() => {
    if (!withModel || seededModelRef.current) return
    if (!value || profiles.length === 0) return
    seededModelRef.current = true
    if (!modelValue) {
      const profile = profiles.find((p) => p.id === value) || null
      if (profile?.model) onModelChange?.(profile.model)
    }
  }, [withModel, value, profiles, modelValue, onModelChange])

  const select = (
    <SearchableSelect
      value={value}
      onChange={handleConnectionChange}
      options={options}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      ariaLabel={ariaLabel}
      disabled={disabled}
      portal={portal}
      align={align}
      clearable={clearable}
      clearLabel={clearLabel}
      triggerClassName={triggerClassName}
      leadingClassName={styles.leadingSlot}
      showSelectedSublabel
    />
  )

  if (!withModel) return select

  return (
    <div className={styles.withModel}>
      {select}
      <ModelCombobox
        value={modelValue ?? ''}
        onChange={(m) => onModelChange?.(m)}
        models={models}
        modelLabels={modelLabels}
        loading={modelsLoading}
        onRefresh={loadModels}
        autoRefreshOnFocus
        refreshKey={value}
        disabled={!value}
        placeholder={modelPlaceholder}
        emptyMessage={value ? modelEmptyMessage : modelNoConnectionMessage}
        appearance={modelAppearance}
      />
    </div>
  )
}
