import { useState, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { connectionsApi } from '@/api/connections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ConnectionForm from './connection-manager/ConnectionForm'
import ConnectionItem from './connection-manager/ConnectionItem'
import type { ConnectionProfile, CreateConnectionProfileInput } from '@/types/api'
import styles from './ConnectionManager.module.css'

const FALLBACK_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', default_url: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', default_url: 'https://api.anthropic.com' },
  { id: 'google', name: 'Google Gemini', default_url: 'https://generativelanguage.googleapis.com' },
]

export default function ConnectionManager() {
  const profiles = useStore((s) => s.profiles)
  const setProfiles = useStore((s) => s.setProfiles)
  const addProfile = useStore((s) => s.addProfile)
  const updateProfile = useStore((s) => s.updateProfile)
  const removeProfile = useStore((s) => s.removeProfile)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const setActiveProfile = useStore((s) => s.setActiveProfile)
  const providers = useStore((s) => s.providers)
  const setProviders = useStore((s) => s.setProviders)

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ConnectionProfile | null>(null)

  // Initialization: load profiles and providers in parallel
  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          connectionsApi.list({ limit: 100 }),
          connectionsApi.providers(),
        ])

        if (cancelled) return

        if (profilesResult.status === 'fulfilled') {
          setProfiles(profilesResult.value.data)
        }

        const loadedProviders = providersResult.status === 'fulfilled'
          ? providersResult.value.providers
          : FALLBACK_PROVIDERS
        setProviders(loadedProviders)
      } catch (err) {
        console.error('[ConnectionManager] Init failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (input: CreateConnectionProfileInput) => {
    try {
      const profile = await connectionsApi.create(input)
      addProfile(profile)
      // If this was set as default, update other profiles
      if (input.is_default) {
        profiles.forEach((p) => {
          if (p.id !== profile.id && p.is_default) updateProfile(p.id, { is_default: false })
        })
      }
      setCreating(false)
    } catch (err) {
      console.error('[ConnectionManager] Failed to create:', err)
    }
  }, [profiles, addProfile, updateProfile])

  const handleUpdate = useCallback((updated: ConnectionProfile) => {
    updateProfile(updated.id, updated)
    // If this was set as default, clear default on others
    if (updated.is_default) {
      profiles.forEach((p) => {
        if (p.id !== updated.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
  }, [profiles, updateProfile])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const duplicated = await connectionsApi.duplicate(id)
      addProfile(duplicated)
    } catch (err) {
      console.error('[ConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await connectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      console.error('[ConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile])

  if (loading) {
    return <div className={styles.loading}>Loading connections...</div>
  }

  return (
    <div className={styles.manager}>
      {!creating && (
        <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
          <Plus size={14} />
          <span>New Connection</span>
        </button>
      )}

      {creating && (
        <ConnectionForm
          providers={providers}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
          onOAuthCreated={(profile) => {
            addProfile(profile)
            setCreating(false)
          }}
        />
      )}

      <div className={styles.list}>
        {profiles.map((profile) => (
          <ConnectionItem
            key={profile.id}
            profile={profile}
            isActive={activeProfileId === profile.id}
            providers={providers}
            onSelect={() => setActiveProfile(activeProfileId === profile.id ? null : profile.id)}
            onUpdate={handleUpdate}
            onDuplicate={() => handleDuplicate(profile.id)}
            onDelete={() => setDeleteTarget(profile)}
          />
        ))}
        {profiles.length === 0 && !creating && (
          <div className={styles.empty}>No connections configured. Add one to start chatting.</div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete Connection"
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
