import ConnectionCollection from '../connection-manager/ConnectionCollection'
import { useConnectionLibrary, saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { sttConnectionsApi } from '@/api/stt-connections'
import { listAllConnections } from '@/api/listAllConnections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import STTConnectionForm from './STTConnectionForm'
import STTConnectionItem from './STTConnectionItem'
import type { SttConnectionProfile, CreateSttConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'
import { normalizeConnectionsOrder } from '@/store/slices/connections-order-merge'

export default function STTConnectionManager() {
  const { t } = useTranslation('panels')
  const profiles = useStore((s) => s.sttProfiles)
  const setProfiles = useStore((s) => s.setSttProfiles)
  const addProfile = useStore((s) => s.addSttProfile)
  const updateProfile = useStore((s) => s.updateSttProfile)
  const removeProfile = useStore((s) => s.removeSttProfile)
  const applyProfileOrder = useStore((s) => s.applySttProfileOrder)
  const providers = useStore((s) => s.sttProviders)
  const setProviders = useStore((s) => s.setSttProviders)
  const setSetting = useStore((s) => s.setSetting)
  const connectionsOrder = useStore((s) => s.connectionsOrder)

  const library = useConnectionLibrary('stt')

  const orderedProfiles = useMemo(() => {
    const sttOrder = connectionsOrder?.stt ?? []
    if (sttOrder.length === 0) return profiles
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = sttOrder.map((id) => byId.get(id)).filter((p): p is SttConnectionProfile => Boolean(p))
    const seen = new Set(ordered.map((p) => p.id))
    const missing = profiles.filter((p) => !seen.has(p.id))
    return [...ordered, ...missing]
  }, [profiles, connectionsOrder])

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
          listAllConnections(sttConnectionsApi),
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

  const handleCreate = useCallback(async (input: CreateSttConnectionInput, folderId = '') => {
    try {
      const profile = await sttConnectionsApi.create(input)
      saveConnectionFolder('stt', profile.id, folderId)
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
      library.copyFolder(id, duplicated.id)
    } catch (err) {
      console.error('[STTConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile, library])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await sttConnectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      library.forget(deleteTarget.id)
      const normalizedOrder = normalizeConnectionsOrder(connectionsOrder)
      const nextOrder = normalizedOrder.stt.filter((id) => id !== deleteTarget.id)
      setSetting('connectionsOrder', { ...normalizedOrder, stt: nextOrder })
      setDeleteTarget(null)
    } catch (err) {
      console.error('[STTConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile, connectionsOrder, setSetting, library])

  const handleReorder = (ids: string[]) => {
    applyProfileOrder(ids)
    setSetting('connectionsOrder', { ...normalizeConnectionsOrder(useStore.getState().connectionsOrder), stt: ids })
  }

  if (loading) {
    return <div className={styles.loading}>{t('sttConnectionManager.loading')}</div>
  }

  return (
    <div className={styles.manager}>
      <ConnectionCollection kind="stt" profiles={orderedProfiles} onReorder={handleReorder}
        actions={!creating && (
          <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
            <Plus size={14} />
            <span>{t('sttConnectionManager.newConnection')}</span>
          </button>
        )}
        editor={creating && (
          <STTConnectionForm
            providers={providers}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
          />
        )}
        emptyMessage={creating ? '' : t('sttConnectionManager.empty')}
        renderProfile={(profile, placement) => (
          <STTConnectionItem
            placement={placement}
            key={profile.id}
            profile={profile}
            providers={providers}
            onUpdate={handleUpdate}
            onDuplicate={() => handleDuplicate(profile.id)}
            onDelete={() => setDeleteTarget(profile)}
          />
        )} />

      {deleteTarget && (
        <ConfirmationModal
          title={t('sttConnectionManager.deleteTitle')}
          message={t('sttConnectionManager.deleteMessage', { name: deleteTarget.name })}
          isOpen={true}
          variant="danger"
          confirmText={t('sttConnectionManager.deleteConfirm')}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
