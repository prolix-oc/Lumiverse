import { useState, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import TTSConnectionForm from './TTSConnectionForm'
import TTSConnectionItem from './TTSConnectionItem'
import type { TtsConnectionProfile, CreateTtsConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'

export default function TTSConnectionManager() {
  const profiles = useStore((s) => s.ttsProfiles)
  const setProfiles = useStore((s) => s.setTtsProfiles)
  const addProfile = useStore((s) => s.addTtsProfile)
  const updateProfile = useStore((s) => s.updateTtsProfile)
  const removeProfile = useStore((s) => s.removeTtsProfile)
  const providers = useStore((s) => s.ttsProviders)
  const setProviders = useStore((s) => s.setTtsProviders)

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TtsConnectionProfile | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          ttsConnectionsApi.list({ limit: 100 }),
          ttsConnectionsApi.providers(),
        ])

        if (cancelled) return

        if (profilesResult.status === 'fulfilled') {
          setProfiles(profilesResult.value.data)
        }

        if (providersResult.status === 'fulfilled') {
          setProviders(providersResult.value.providers)
        }
      } catch (err) {
        console.error('[TTSConnectionManager] Init failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (input: CreateTtsConnectionInput) => {
    try {
      const profile = await ttsConnectionsApi.create(input)
      addProfile(profile)
      if (input.is_default) {
        profiles.forEach((p) => {
          if (p.id !== profile.id && p.is_default) updateProfile(p.id, { is_default: false })
        })
      }
      setCreating(false)
    } catch (err) {
      console.error('[TTSConnectionManager] Failed to create:', err)
    }
  }, [profiles, addProfile, updateProfile])

  const handleUpdate = useCallback((updated: TtsConnectionProfile) => {
    updateProfile(updated.id, updated)
    if (updated.is_default) {
      profiles.forEach((p) => {
        if (p.id !== updated.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
  }, [profiles, updateProfile])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const duplicated = await ttsConnectionsApi.duplicate(id)
      addProfile(duplicated)
    } catch (err) {
      console.error('[TTSConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await ttsConnectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      console.error('[TTSConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile])

  if (loading) {
    return <div className={styles.loading}>Loading TTS connections...</div>
  }

  return (
    <div className={styles.manager}>
      {!creating && (
        <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
          <Plus size={14} />
          <span>New TTS Connection</span>
        </button>
      )}

      {creating && (
        <TTSConnectionForm
          providers={providers}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className={styles.list}>
        {profiles.map((profile) => (
          <TTSConnectionItem
            key={profile.id}
            profile={profile}
            providers={providers}
            onUpdate={handleUpdate}
            onDuplicate={() => handleDuplicate(profile.id)}
            onDelete={() => setDeleteTarget(profile)}
          />
        ))}
        {profiles.length === 0 && !creating && (
          <div className={styles.empty}>No TTS connections configured.</div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete TTS Connection"
          message={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          isOpen={true}
          variant="danger"
          confirmText="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
