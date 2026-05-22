import { useState, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { sttConnectionsApi } from '@/api/stt-connections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import STTConnectionForm from './STTConnectionForm'
import STTConnectionItem from './STTConnectionItem'
import type { SttConnectionProfile, CreateSttConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'

export default function STTConnectionManager() {
  const profiles = useStore((s) => s.sttProfiles)
  const setProfiles = useStore((s) => s.setSttProfiles)
  const addProfile = useStore((s) => s.addSttProfile)
  const updateProfile = useStore((s) => s.updateSttProfile)
  const removeProfile = useStore((s) => s.removeSttProfile)
  const providers = useStore((s) => s.sttProviders)
  const setProviders = useStore((s) => s.setSttProviders)

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SttConnectionProfile | null>(null)

  useEffect(() => {
    let cancelled = false

    const storeState = useStore.getState()
    const cacheHit = storeState.sttProfiles.length > 0 && storeState.sttProviders.length > 0

    async function init() {
      if (!cacheHit) setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          sttConnectionsApi.list({ limit: 100 }),
          sttConnectionsApi.providers(),
        ])

        if (cancelled) return

        if (profilesResult.status === 'fulfilled') {
          setProfiles(profilesResult.value.data)
        }

        if (providersResult.status === 'fulfilled') {
          setProviders(providersResult.value.providers)
        }
      } catch (err) {
        console.error('[STTConnectionManager] Init failed:', err)
      } finally {
        if (!cancelled && !cacheHit) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (input: CreateSttConnectionInput) => {
    try {
      const profile = await sttConnectionsApi.create(input)
      addProfile(profile)
      if (input.is_default) {
        profiles.forEach((p) => {
          if (p.id !== profile.id && p.is_default) updateProfile(p.id, { is_default: false })
        })
      }
      setCreating(false)
    } catch (err) {
      console.error('[STTConnectionManager] Failed to create:', err)
    }
  }, [profiles, addProfile, updateProfile])

  const handleUpdate = useCallback((updated: SttConnectionProfile) => {
    updateProfile(updated.id, updated)
    if (updated.is_default) {
      profiles.forEach((p) => {
        if (p.id !== updated.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
  }, [profiles, updateProfile])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const duplicated = await sttConnectionsApi.duplicate(id)
      addProfile(duplicated)
    } catch (err) {
      console.error('[STTConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await sttConnectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      console.error('[STTConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile])

  if (loading) {
    return <div className={styles.loading}>Loading STT connections...</div>
  }

  return (
    <div className={styles.manager}>
      {!creating && (
        <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
          <Plus size={14} />
          <span>New STT Connection</span>
        </button>
      )}

      {creating && (
        <STTConnectionForm
          providers={providers}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className={styles.list}>
        {profiles.map((profile) => (
          <STTConnectionItem
            key={profile.id}
            profile={profile}
            providers={providers}
            onUpdate={handleUpdate}
            onDuplicate={() => handleDuplicate(profile.id)}
            onDelete={() => setDeleteTarget(profile)}
          />
        ))}
        {profiles.length === 0 && !creating && (
          <div className={styles.empty}>No STT connections configured.</div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete STT Connection"
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
