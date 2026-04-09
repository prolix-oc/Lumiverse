import { useState, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImageGenConnectionForm from './ImageGenConnectionForm'
import ImageGenConnectionItem from './ImageGenConnectionItem'
import type { ImageGenConnectionProfile, CreateImageGenConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'

export default function ImageGenConnectionManager() {
  const profiles = useStore((s) => s.imageGenProfiles)
  const setProfiles = useStore((s) => s.setImageGenProfiles)
  const addProfile = useStore((s) => s.addImageGenProfile)
  const updateProfile = useStore((s) => s.updateImageGenProfile)
  const removeProfile = useStore((s) => s.removeImageGenProfile)
  const activeId = useStore((s) => s.activeImageGenConnectionId)
  const setActive = useStore((s) => s.setActiveImageGenConnection)
  const providers = useStore((s) => s.imageGenProviders)
  const setProviders = useStore((s) => s.setImageGenProviders)

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ImageGenConnectionProfile | null>(null)

  useEffect(() => {
    const returnedKey = sessionStorage.getItem('pollinations_byop_returned_api_key')
    const pendingRaw = sessionStorage.getItem('pollinations_byop_pending')
    if (!returnedKey || !pendingRaw) return

    try {
      const pending = JSON.parse(pendingRaw) as { target?: string; provider?: string; connectionId?: string | null }
      if (pending.target !== 'image-gen-connections') return
      if (pending.provider !== 'pollinations') return
      if (pending.connectionId) return
      setCreating(true)
    } catch {
      // ignore malformed pending state
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          imageGenConnectionsApi.list({ limit: 100 }),
          imageGenConnectionsApi.providers(),
        ])

        if (cancelled) return

        if (profilesResult.status === 'fulfilled') {
          setProfiles(profilesResult.value.data)
        }

        if (providersResult.status === 'fulfilled') {
          setProviders(providersResult.value.providers)
        }
      } catch (err) {
        console.error('[ImageGenConnectionManager] Init failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (input: CreateImageGenConnectionInput) => {
    try {
      const profile = await imageGenConnectionsApi.create(input)
      addProfile(profile)
      if (input.is_default) {
        profiles.forEach((p) => {
          if (p.id !== profile.id && p.is_default) updateProfile(p.id, { is_default: false })
        })
      }
      setCreating(false)
    } catch (err) {
      console.error('[ImageGenConnectionManager] Failed to create:', err)
    }
  }, [profiles, addProfile, updateProfile])

  const handleUpdate = useCallback((updated: ImageGenConnectionProfile) => {
    updateProfile(updated.id, updated)
    if (updated.is_default) {
      profiles.forEach((p) => {
        if (p.id !== updated.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
  }, [profiles, updateProfile])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const duplicated = await imageGenConnectionsApi.duplicate(id)
      addProfile(duplicated)
    } catch (err) {
      console.error('[ImageGenConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await imageGenConnectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      console.error('[ImageGenConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile])

  if (loading) {
    return <div className={styles.loading}>Loading image gen connections...</div>
  }

  return (
    <div className={styles.manager}>
      {!creating && (
        <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
          <Plus size={14} />
          <span>New Image Gen Connection</span>
        </button>
      )}

      {creating && (
        <ImageGenConnectionForm
          providers={providers}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className={styles.list}>
        {profiles.map((profile) => (
          <ImageGenConnectionItem
            key={profile.id}
            profile={profile}
            isActive={activeId === profile.id}
            providers={providers}
            onSelect={() => setActive(activeId === profile.id ? null : profile.id)}
            onUpdate={handleUpdate}
            onDuplicate={() => handleDuplicate(profile.id)}
            onDelete={() => setDeleteTarget(profile)}
          />
        ))}
        {profiles.length === 0 && !creating && (
          <div className={styles.empty}>No image generation connections configured.</div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete Image Gen Connection"
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
