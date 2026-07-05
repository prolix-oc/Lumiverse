import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { listAllConnections } from '@/api/listAllConnections'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import TTSConnectionForm from './TTSConnectionForm'
import TTSConnectionItem from './TTSConnectionItem'
import type { TtsConnectionProfile, CreateTtsConnectionInput } from '@/types/api'
import styles from '../ConnectionManager.module.css'

export default function TTSConnectionManager() {
  const { t } = useTranslation('panels')
  const profiles = useStore((s) => s.ttsProfiles)
  const setProfiles = useStore((s) => s.setTtsProfiles)
  const addProfile = useStore((s) => s.addTtsProfile)
  const updateProfile = useStore((s) => s.updateTtsProfile)
  const removeProfile = useStore((s) => s.removeTtsProfile)
  const applyProfileOrder = useStore((s) => s.applyTtsProfileOrder)
  const providers = useStore((s) => s.ttsProviders)
  const setProviders = useStore((s) => s.setTtsProviders)
  const setSetting = useStore((s) => s.setSetting)
  const connectionsOrder = useStore((s) => s.connectionsOrder)

  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 4 } })
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { distance: 8 } })
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  const sensors = useSensors(mouseSensor, touchSensor, keyboardSensor)

  const orderedProfiles = useMemo(() => {
    const ttsOrder = connectionsOrder?.tts ?? []
    if (ttsOrder.length === 0) return profiles
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = ttsOrder.map((id) => byId.get(id)).filter((p): p is TtsConnectionProfile => Boolean(p))
    const seen = new Set(ordered.map((p) => p.id))
    const missing = profiles.filter((p) => !seen.has(p.id))
    return [...ordered, ...missing]
  }, [profiles, connectionsOrder])

  const orderedIds = useMemo(() => orderedProfiles.map((p) => p.id), [orderedProfiles])

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TtsConnectionProfile | null>(null)
  const [dragActiveId, setDragActiveId] = useState<string | null>(null)

  const activeProfile = orderedProfiles.find((p) => p.id === dragActiveId) ?? null

  // `useAppInit` preloads TTS profiles + providers right after auth. Only
  // show the loading placeholder on a true cold mount (empty store);
  // otherwise render from the store and refresh silently in the background.
  useEffect(() => {
    let cancelled = false

    const storeState = useStore.getState()
    const cacheHit = storeState.ttsProfiles.length > 0 && storeState.ttsProviders.length > 0

    async function init() {
      if (!cacheHit) setLoading(true)
      try {
        const [profilesResult, providersResult] = await Promise.allSettled([
          listAllConnections(ttsConnectionsApi),
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
        if (!cancelled && !cacheHit) setLoading(false)
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
      const nextOrder = (connectionsOrder?.tts ?? []).filter((id) => id !== deleteTarget.id)
      setSetting('connectionsOrder', { ...connectionsOrder, tts: nextOrder })
      setDeleteTarget(null)
    } catch (err) {
      console.error('[TTSConnectionManager] Failed to delete:', err)
    }
  }, [deleteTarget, removeProfile, connectionsOrder, setSetting])

  const handleDragStart = useCallback(({ active }: DragStartEvent) => setDragActiveId(String(active.id)), [])
  const handleDragCancel = useCallback(() => setDragActiveId(null), [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDragActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedIds.indexOf(String(active.id))
    const newIndex = orderedIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const newOrder = arrayMove(orderedIds, oldIndex, newIndex)
    applyProfileOrder(newOrder)
    setSetting('connectionsOrder', { ...connectionsOrder, tts: newOrder })
  }, [orderedIds, connectionsOrder, applyProfileOrder, setSetting])

  if (loading) {
    return <div className={styles.loading}>{t('ttsConnectionManager.loading')}</div>
  }

  return (
    <div className={styles.manager}>
      {!creating && (
        <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
          <Plus size={14} />
          <span>{t('ttsConnectionManager.newConnection')}</span>
        </button>
      )}

      {creating && (
        <TTSConnectionForm
          providers={providers}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          <div className={styles.list}>
            {orderedProfiles.map((profile) => (
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
              <div className={styles.empty}>{t('ttsConnectionManager.empty')}</div>
            )}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeProfile && (
            <div className={styles.itemDraggingOverlay}>
              <TTSConnectionItem
                profile={activeProfile}
                providers={providers}
                onUpdate={handleUpdate}
                onDuplicate={() => handleDuplicate(activeProfile.id)}
                onDelete={() => setDeleteTarget(activeProfile)}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {deleteTarget && (
        <ConfirmationModal
          title={t('ttsConnectionManager.deleteTitle')}
          message={t('ttsConnectionManager.deleteMessage', { name: deleteTarget.name })}
          isOpen={true}
          variant="danger"
          confirmText={t('ttsConnectionManager.deleteConfirm')}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
