import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionsApi } from '@/api/connections'
import { useStore } from '@/store'
import { Button, Select } from '@/components/shared/FormComponents'
import type { ConnectionProfile } from '@/types/api'
import styles from './ConnectionItem.module.css'

export default function FallbackConnectionPicker({ profile, onUpdate, onClose }: {
  profile: ConnectionProfile
  onUpdate: (profile: ConnectionProfile) => void
  onClose: () => void
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'connectionItem' })
  const profiles = useStore((s) => s.profiles)
  const [value, setValue] = useState<string>(profile.metadata?.fallback_connection_id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidates = profiles.filter((p) => p.id !== profile.id && p.provider !== 'model_roulette')

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // Read the current profile to preserve metadata updated while the picker was open.
      const latest = await connectionsApi.get(profile.id)
      const updated = await connectionsApi.update(profile.id, {
        metadata: { ...latest.metadata, fallback_connection_id: value || null },
      })
      onUpdate(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('fallbackSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.fallbackPicker}>
      <label>
        {t('setFallback')}
        <Select
          aria-label={t('setFallback')}
          value={value}
          onChange={setValue}
          disabled={saving}
          options={[
            { value: '', label: t('noFallback') },
            ...(value && !candidates.some((p) => p.id === value)
              ? [{ value, label: t('fallbackUnavailable') }] : []),
            ...candidates.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </label>
      <p>{t('fallbackHint')}</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.itemActions}>
        <Button onClick={save} disabled={saving}>{t('saveFallback')}</Button>
        <Button variant="ghost" onClick={onClose} disabled={saving}>{t('cancelFallback')}</Button>
      </div>
    </div>
  )
}
