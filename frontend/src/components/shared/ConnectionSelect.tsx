import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/store'
import { fetchConnectionModels, type ConnectionKind } from '@/api/connectionModels'
import ProviderIcon from './ProviderIcon'
import SearchableSelect, { type SearchableSelectOption } from './SearchableSelect'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import styles from './ConnectionSelect.module.css'

export type { ConnectionKind }

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
      const result = await fetchConnectionModels(kind, value)
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

  // The dropdown just reports the new connection id; keeping the paired model in
  // sync is the reconcile effect's job below, so it covers BOTH a dropdown pick
  // and a programmatic `value` change (e.g. a panel bound to the active
  // connection that gets switched out from under it).
  const handleConnectionChange = useCallback((next: string) => onChange(next), [onChange])

  // Reconcile the paired model whenever the *connection* changes:
  //  - first reconcile (mount): seed an empty model from the connection's default,
  //    but leave an already-set model alone (e.g. a restored saved value);
  //  - any later connection change: reset the model to the new connection's
  //    default (the old model may not exist on it).
  // `prevConnRef` tracks the last reconciled connection, so editing or clearing
  // the model on its own never triggers a reseed.
  const prevConnRef = useRef<string | null>(null)
  useEffect(() => {
    if (!withModel || profiles.length === 0) return
    const prev = prevConnRef.current
    if (prev === value) return
    prevConnRef.current = value
    const profile = profiles.find((p) => p.id === value) || null
    if (prev === null) {
      if (value && !modelValue && profile?.model) onModelChange?.(profile.model)
    } else {
      onModelChange?.(profile?.model || '')
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
