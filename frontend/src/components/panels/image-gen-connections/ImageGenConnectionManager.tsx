import ConnectionCollection from '../connection-manager/ConnectionCollection'
import { useConnectionLibrary, saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { useConnectionAccount } from '@/hooks/useConnectionAccount'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { listAllConnections } from '@/api/listAllConnections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImageGenConnectionForm from './ImageGenConnectionForm'
import ImageGenConnectionItem from './ImageGenConnectionItem'
import type { ImageGenConnectionProfile, CreateImageGenConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'
import { normalizeConnectionsOrder } from '@/store/slices/connections-order-merge'

export default function ImageGenConnectionManager() {
  const { t } = useTranslation('panels')
  const profiles = useStore((s) => s.imageGenProfiles)
  const setProfiles = useStore((s) => s.setImageGenProfiles)
  const addProfile = useStore((s) => s.addImageGenProfile)
  const updateProfile = useStore((s) => s.updateImageGenProfile)
  const removeProfile = useStore((s) => s.removeImageGenProfile)
  const applyProfileOrder = useStore((s) => s.applyImageGenProfileOrder)
  const activeId = useStore((s) => s.activeImageGenConnectionId)
  const setActive = useStore((s) => s.setActiveImageGenConnection)
  const providers = useStore((s) => s.imageGenProviders)
  const setProviders = useStore((s) => s.setImageGenProviders)
  const setSetting = useStore((s) => s.setSetting)
  const connectionsOrder = useStore((s) => s.connectionsOrder)

  const library = useConnectionLibrary('imageGen')
  const account = useConnectionAccount(profiles.find(profile => profile.id === activeId), 'imageGen')

  const orderedProfiles = useMemo(() => {
    const imageGenOrder = connectionsOrder?.imageGen ?? []
    if (imageGenOrder.length === 0) return profiles
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = imageGenOrder.map((id) => byId.get(id)).filter((p): p is ImageGenConnectionProfile => Boolean(p))
    const seen = new Set(ordered.map((p) => p.id))
    const missing = profiles.filter((p) => !seen.has(p.id))
    return [...ordered, ...missing]
  }, [profiles, connectionsOrder])

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

  // `useAppInit` preloads image-gen profiles + providers right after auth.
  // Only show the loading placeholder on a true cold mount (empty store);
  // otherwise render from the store and refresh silently in the background.
  useEffect(() => {
    let cancelled = false

    const storeState = useStore.getState()
    const cacheHit = storeState.imageGenProfiles.length > 0 && storeState.imageGenProviders.length > 0
    const expectedProfilesVersion = storeState.imageGenProfilesVersion

    async function init() {
      if (!cacheHit) setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          listAllConnections(imageGenConnectionsApi),
          imageGenConnectionsApi.providers(),
        ])

        if (cancelled) return

        if (profilesResult.status === 'fulfilled') {
          setProfiles(profilesResult.value.data, expectedProfilesVersion)
        }

        if (providersResult.status === 'fulfilled') {
          setProviders(providersResult.value.providers)
        }
      } catch (err) {
        console.error('[ImageGenConnectionManager] Init failed:', err)
      } finally {
        if (!cancelled && !cacheHit) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (input: CreateImageGenConnectionInput, folderId = '') => {
    try {
      const profile = await imageGenConnectionsApi.create(input)
      saveConnectionFolder('imageGen', profile.id, folderId)
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
      library.copyFolder(id, duplicated.id)
    } catch (err) {
      console.error('[ImageGenConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile, library])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await imageGenConnectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      library.forget(deleteTarget.id)
      const normalizedOrder = normalizeConnectionsOrder(connectionsOrder)
      const nextOrder = normalizedOrder.imageGen.filter((id) => id !== deleteTarget.id)
      setSetting('connectionsOrder', { ...normalizedOrder, imageGen: nextOrder })
      setDeleteTarget(null)
    } catch (err) {
      console.error('[ImageGenConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile, connectionsOrder, setSetting, library])

  const handleReorder = (ids: string[]) => {
    applyProfileOrder(ids)
    setSetting('connectionsOrder', { ...normalizeConnectionsOrder(useStore.getState().connectionsOrder), imageGen: ids })
  }

  if (loading) {
    return <div className={styles.loading}>{t('imageGenConnectionManager.loading')}</div>
  }

  return (
    <div className={styles.manager}>
      <ConnectionCollection kind="imageGen" profiles={orderedProfiles} onReorder={handleReorder}
        actions={!creating && (
          <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
            <Plus size={14} />
            <span>{t('imageGenConnectionManager.newConnection')}</span>
          </button>
        )}
        editor={creating && (
          <ImageGenConnectionForm
            providers={providers}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
          />
        )}
        emptyMessage={creating ? '' : t('imageGenConnectionManager.empty')}
        renderProfile={(profile, placement) => (
          <ImageGenConnectionItem
            placement={placement}
            key={profile.id}
            profile={profile}
            isActive={activeId === profile.id}
            providers={providers}
            nanoGptUsage={account.nanoGptUsage}
            nanoGptUsageLoading={account.loading}
            onRefreshNanoGptUsage={account.refresh}
            onSelect={() => setActive(profile.id)}
            onUpdate={handleUpdate}
            onDuplicate={() => handleDuplicate(profile.id)}
            onDelete={() => setDeleteTarget(profile)}
          />
        )} />

      {deleteTarget && (
        <ConfirmationModal
          title={t('imageGenConnectionManager.deleteTitle')}
          message={t('imageGenConnectionManager.deleteMessage', { name: deleteTarget.name })}
          isOpen={true}
          variant="danger"
          confirmText={t('imageGenConnectionManager.deleteConfirm')}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
