import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { ttsConnectionsApi } from '@/api/tts-connections'
import type { TtsVoice, VoiceRef } from '@/types/api'
import styles from './VoicePicker.module.css'

interface VoicePickerProps {
  /** Current selection. `null` means "no override / use fallback". */
  value: VoiceRef | null
  onChange: (next: VoiceRef | null) => void
  /** Label for the connection clear option, e.g. "Use global default". */
  clearLabel?: string
  /** When false, the clear-to-null affordance is hidden (forced selection). */
  clearable?: boolean
  /** Optional extra aria description for screen readers. */
  ariaLabel?: string
  /** Disable the whole picker (e.g. when its parent toggle is off). */
  disabled?: boolean
  /**
   * Render the connection and voice dropdowns through a portal anchored to
   * `document.body`. Required when the picker is placed inside a modal with
   * `overflow: hidden` (or any clipping ancestor) — otherwise the popover
   * gets cut off at the modal edge.
   */
  portal?: boolean
}

/**
 * Two-step voice selector: pick a TTS connection, then pick a voice within
 * that connection. Used wherever a `VoiceRef` is configurable — global
 * narrator voice, character default voice, per-chat member override.
 *
 * Voice options are fetched live for dynamic-voice providers and fall back
 * to the connection's static voice list otherwise. When no voices come back
 * (e.g. unset API key), the input accepts a free-form voice id so users
 * who know the voice name aren't blocked.
 */
export default function VoicePicker({
  value,
  onChange,
  clearLabel = 'Use default',
  clearable = true,
  ariaLabel = 'Voice',
  disabled,
  portal,
}: VoicePickerProps) {
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const ttsProviders = useStore((s) => s.ttsProviders)

  const [voicesByConnection, setVoicesByConnection] = useState<Record<string, TtsVoice[]>>({})
  const [voicesLoading, setVoicesLoading] = useState(false)

  const connectionOptions = useMemo(
    () => ttsProfiles.map((p) => ({ value: p.id, label: p.name, sublabel: p.provider })),
    [ttsProfiles],
  )

  const activeConnection = useMemo(
    () => ttsProfiles.find((p) => p.id === value?.connectionId) ?? null,
    [ttsProfiles, value?.connectionId],
  )

  const provider = activeConnection
    ? ttsProviders.find((p) => p.id === activeConnection.provider) ?? null
    : null

  // Fetch the active connection's voices when it changes — but only once per
  // session per connection, since voice lists are stable for the lifetime of
  // a connection profile.
  useEffect(() => {
    if (!activeConnection) return
    if (voicesByConnection[activeConnection.id]) return
    let cancelled = false
    setVoicesLoading(true)
    ttsConnectionsApi
      .voices(activeConnection.id)
      .then((result) => {
        if (cancelled) return
        setVoicesByConnection((prev) => ({ ...prev, [activeConnection.id]: result.voices }))
      })
      .catch(() => {
        if (cancelled) return
        // Cache an empty list so we don't refetch on every interaction —
        // user falls back to the static voice list or manual entry.
        setVoicesByConnection((prev) => ({ ...prev, [activeConnection.id]: [] }))
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false)
      })
    return () => { cancelled = true }
  }, [activeConnection, voicesByConnection])

  const voiceOptions = useMemo(() => {
    if (!activeConnection) return []
    const dynamicVoices = voicesByConnection[activeConnection.id] ?? []
    const staticVoices = provider?.capabilities?.staticVoices ?? []
    const merged = dynamicVoices.length > 0 ? dynamicVoices : staticVoices
    const options = merged.map((v) => ({
      value: v.id,
      label: v.name,
      sublabel: v.language ?? undefined,
    }))
    // Preserve a manually-typed voice id that isn't in the list.
    if (value?.voice && !options.some((o) => o.value === value.voice)) {
      options.unshift({ value: value.voice, label: value.voice, sublabel: undefined })
    }
    return options
  }, [activeConnection, voicesByConnection, provider, value?.voice])

  const handleConnectionChange = (next: string) => {
    if (!next) {
      onChange(null)
      return
    }
    // Reset voice when switching connections — the previous voice id may not
    // exist on the new provider.
    onChange({ connectionId: next, voice: '' })
  }

  const handleVoiceChange = (next: string) => {
    if (!value) return
    onChange({ ...value, voice: next })
  }

  return (
    <div className={styles.picker} data-disabled={disabled || undefined}>
      <div className={styles.row}>
        <span className={styles.label}>Connection</span>
        <SearchableSelect
          value={value?.connectionId ?? ''}
          onChange={handleConnectionChange}
          options={connectionOptions}
          placeholder="Select a connection…"
          searchPlaceholder="Search connections…"
          ariaLabel={`${ariaLabel} connection`}
          emptyMessage="No TTS connections configured"
          clearable={clearable}
          clearLabel={clearLabel}
          portal={portal}
        />
      </div>

      {activeConnection && (
        <div className={styles.row}>
          <span className={styles.label}>Voice</span>
          <SearchableSelect
            value={value?.voice ?? ''}
            onChange={handleVoiceChange}
            options={voiceOptions}
            placeholder={voicesLoading ? 'Loading voices…' : 'Select a voice…'}
            searchPlaceholder="Search voices…"
            ariaLabel={`${ariaLabel} voice`}
            emptyMessage={voicesLoading ? 'Loading…' : 'No voices available — use the connection default'}
            clearable
            clearLabel="Connection default"
            portal={portal}
          />
        </div>
      )}
    </div>
  )
}
