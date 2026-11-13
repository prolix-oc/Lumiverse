import ConnectionCollection from '../connection-manager/ConnectionCollection'
import { useConnectionLibrary, saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { decisionConnectionsApi } from '@/api/decision-connections'
import { listAllConnections } from '@/api/listAllConnections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import DecisionConnectionForm from './DecisionConnectionForm'
import DecisionConnectionItem from './DecisionConnectionItem'
import type { DecisionConnectionProfile, CreateDecisionConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'
import { normalizeConnectionsOrder } from '@/store/slices/connections-order-merge'

export default function DecisionConnectionManager() {
  const { t } = useTranslation('panels')
  const profiles = useStore((s) => s.decisionProfiles)
  const setProfiles = useStore((s) => s.setDecisionProfiles)
  const addProfile = useStore((s) => s.addDecisionProfile)
  const updateProfile = useStore((s) => s.updateDecisionProfile)
  const removeProfile = useStore((s) => s.removeDecisionProfile)
  const applyProfileOrder = useStore((s) => s.applyDecisionProfileOrder)
  const providers = useStore((s) => s.decisionProviders)
  const setProviders = useStore((s) => s.setDecisionProviders)
  const setSetting = useStore((s) => s.setSetting)
  const connectionsOrder = useStore((s) => s.connectionsOrder)

  const library = useConnectionLibrary('decision')

  const orderedProfiles = useMemo(() => {
    const decisionOrder = connectionsOrder?.decision ?? []
    if (decisionOrder.length === 0) return profiles
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = decisionOrder.map((id) => byId.get(id)).filter((p): p is DecisionConnectionProfile => Boolean(p))
    const seen = new Set(ordered.map((p) => p.id))
    const missing = profiles.filter((p) => !seen.has(p.id))
    return [...ordered, ...missing]
  }, [profiles, connectionsOrder])

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DecisionConnectionProfile | null>(null)

  useEffect(() => {
    let cancelled = false

    const storeState = useStore.getState()
    const cacheHit = storeState.decisionProfiles.length > 0 && storeState.decisionProviders.length > 0

    async function init() {
      if (!cacheHit) setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          listAllConnections(decisionConnectionsApi),
          decisionConnectionsApi.providers(),
        ])

        if (cancelled) return

        if (profilesResult.status === 'fulfilled') {
          setProfiles(profilesResult.value.data)
        }

        if (providersResult.status === 'fulfilled') {
          setProviders(providersResult.value.providers)
        }
      } catch (err) {
        console.error('[DecisionConnectionManager] Init failed:', err)
      } finally {
        if (!cancelled && !cacheHit) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (input: CreateDecisionConnectionInput, folderId = '') => {
    const profile = await decisionConnectionsApi.create(input)
    saveConnectionFolder('decision', profile.id, folderId)
    addProfile(profile)
    if (input.is_default) {
      profiles.forEach((p) => {
        if (p.id !== profile.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
    setCreating(false)
  }, [profiles, addProfile, updateProfile])

  const handleOAuthComplete = useCallback((profile: DecisionConnectionProfile) => {
    addProfile(profile)
    if (profile.is_default) {
      profiles.forEach((p) => {
        if (p.id !== profile.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
    setCreating(false)
  }, [profiles, addProfile, updateProfile])

  const handleUpdate = useCallback((updated: DecisionConnectionProfile) => {
    updateProfile(updated.id, updated)
    if (updated.is_default) {
      profiles.forEach((p) => {
        if (p.id !== updated.id && p.is_default) updateProfile(p.id, { is_default: false })
      })
    }
  }, [profiles, updateProfile])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const duplicated = await decisionConnectionsApi.duplicate(id)
      addProfile(duplicated)
      library.copyFolder(id, duplicated.id)
    } catch (err) {
      console.error('[DecisionConnectionManager] Failed to duplicate:', err)
    }
  }, [addProfile, library])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await decisionConnectionsApi.delete(deleteTarget.id)
      removeProfile(deleteTarget.id)
      library.forget(deleteTarget.id)
      const normalizedOrder = normalizeConnectionsOrder(connectionsOrder)
      const nextOrder = normalizedOrder.decision.filter((id) => id !== deleteTarget.id)
      setSetting('connectionsOrder', { ...normalizedOrder, decision: nextOrder })
      setDeleteTarget(null)
    } catch (err) {
      console.error('[DecisionConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile, connectionsOrder, setSetting, library])

  const handleReorder = (ids: string[]) => {
    applyProfileOrder(ids)
    setSetting('connectionsOrder', { ...normalizeConnectionsOrder(useStore.getState().connectionsOrder), decision: ids })
  }

  if (loading) {
    return <div className={styles.loading}>{t('decisionConnectionManager.loading')}</div>
  }

  return (
    <div className={styles.manager}>
      <ConnectionCollection kind="decision" profiles={orderedProfiles} onReorder={handleReorder}
        actions={!creating && (
          <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
            <Plus size={14} />
            <span>{t('decisionConnectionManager.newConnection')}</span>
          </button>
        )}
        editor={creating && (
          <DecisionConnectionForm
            providers={providers}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
            onOAuthComplete={handleOAuthComplete}
          />
        )}
        emptyMessage={creating ? '' : t('decisionConnectionManager.empty')}
        renderProfile={(profile, placement) => (
          <DecisionConnectionItem
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
          title={t('decisionConnectionManager.deleteTitle')}
          message={t('decisionConnectionManager.deleteMessage', { name: deleteTarget.name })}
          isOpen={true}
          variant="danger"
          confirmText={t('decisionConnectionManager.deleteConfirm')}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
