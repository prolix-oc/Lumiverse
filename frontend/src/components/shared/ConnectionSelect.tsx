import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/store'
import type { AppStore } from '@/types/store'
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

/** Store-slice selector per kind; exhaustive, so a new kind won't compile until added here. */
const PROFILE_SELECTOR_MAP: Record<ConnectionKind, (s: AppStore) => ConnectionLike[]> = {
  llm: (s) => s.profiles,
  imageGen: (s) => s.imageGenProfiles,
  tts: (s) => s.ttsProfiles,
  stt: (s) => s.sttProfiles,
}

interface ConnectionSelectProps {
  /** Picks both the store slice that supplies the list and the models endpoint. */
  kind: ConnectionKind
  /** Selected connection id; '' means none selected. */
  value: string
  onChange: (id: string) => void

  /** Render a paired model picker beneath the selector. */
  withModel?: boolean
  modelValue?: string
  onModelChange?: (model: string) => void
  /**
   * Seed/reset the paired model from the connection's default when the
   * connection changes. Disable where '' means "use connection default at
   * request time", so a persisted picker never pins a snapshot of it.
   */
  seedDefaultModel?: boolean

  // Pass-throughs to SearchableSelect (it supplies translated defaults for the
  // message props).
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
 * Shared connection picker: store-fed list for `kind`, provider icon + sublabel
 * rows, optional paired model combobox.
 */
export default function ConnectionSelect({
  kind,
  value,
  onChange,
  withModel = false,
  modelValue,
  onModelChange,
  seedDefaultModel = true,
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
  const profiles = useStore(PROFILE_SELECTOR_MAP[kind])

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

  // A slow response for the old connection must not overwrite the new one's.
  const loadSeqRef = useRef(0)
  const loadModels = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!withModel || !value) {
      setModels([])
      setModelLabels({})
      return
    }
    setModelsLoading(true)
    try {
      const result = await fetchConnectionModels(kind, value)
      if (seq !== loadSeqRef.current) return
      setModels(result.models)
      setModelLabels(result.labels)
    } catch {
      if (seq !== loadSeqRef.current) return
      setModels([])
      setModelLabels({})
    } finally {
      if (seq === loadSeqRef.current) setModelsLoading(false)
    }
  }, [withModel, value, kind])

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  // Reconcile the paired model when the connection changes (an effect so it
  // also covers programmatic `value` changes, not just dropdown picks).
  // First connection ('' to id): seed only an empty model, never overwrite one;
  // saved settings can hydrate in late. A real switch (id to id/''): reset to
  // the new connection's default, or '' when seedDefaultModel is off.
  // prevConnRef makes model edits on their own never trigger a reseed.
  const prevConnRef = useRef<string | null>(null)
  useEffect(() => {
    if (!withModel || profiles.length === 0) return
    const prev = prevConnRef.current
    if (prev === value) return
    prevConnRef.current = value
    const profile = profiles.find((p) => p.id === value) || null
    if (prev === null || prev === '') {
      if (seedDefaultModel && value && !modelValue && profile?.model) onModelChange?.(profile.model)
    } else {
      onModelChange?.(seedDefaultModel ? profile?.model || '' : '')
    }
  }, [withModel, seedDefaultModel, value, profiles, modelValue, onModelChange])

  const select = (
    <SearchableSelect
      value={value}
      onChange={onChange}
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
