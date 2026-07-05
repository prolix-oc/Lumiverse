import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'

import { Trash2, Edit3, Zap, Star, Copy, MoreVertical, Volume2, GripVertical } from 'lucide-react'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { formatTtsConnectionVoiceLabel, isQwenTtsProvider } from '@/lib/qwenTts'
import { useStore } from '@/store'
import type { TtsConnectionProfile, TtsProviderInfo, CreateTtsConnectionInput } from '@/types/api'
import TTSConnectionForm from './TTSConnectionForm'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import ProviderIcon from '@/components/shared/ProviderIcon'
import styles from '../connection-manager/ConnectionItem.module.css'
import clsx from 'clsx'

interface Props {
  profile: TtsConnectionProfile
  providers: TtsProviderInfo[]
  onUpdate: (profile: TtsConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function TTSConnectionItem({
 profile, providers, onUpdate, onDuplicate, onDelete }: Props) {
  const { t: tc } = useTranslation('common')
  const { t } = useTranslation('panels')
  const openModal = useStore((s) => s.openModal)
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)
  const isQwen = isQwenTtsProvider(profile.provider)
  const voiceLabel = formatTtsConnectionVoiceLabel(profile)

  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await ttsConnectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || t('connectionItem.connectionFailed') })
    } finally {
      setTesting(false)
    }
  }, [profile.id, t])

  const handleSaveEdit = useCallback(async (input: CreateTtsConnectionInput) => {
    try {
      const updated = await ttsConnectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[TTSConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: profile.id })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })

  return (
    <div ref={setNodeRef} style={style} className={clsx(styles.item, isDragging && styles.itemDragging)}>
      {editing ? (
        <TTSConnectionForm
          providers={providers}
          profile={profile}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className={styles.itemRow}>
            <button
              type="button"
              className={styles.dragHandle}
              aria-label={t('connectionItem.dragToReorder')}
              title={t('connectionItem.dragToReorder')}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={16} />
            </button>
            <div className={styles.itemBtn} style={{ cursor: 'default' }}>
              <ProviderIcon kind="tts" provider={profile.provider} size={32} iconSize={16} className={styles.itemIcon} />
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>
                  {profile.name}
                  {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
                </span>
                <span className={styles.itemMeta}>
                  {profile.provider}
                  {profile.model ? ` / ${profile.model}` : ''}
                  {voiceLabel ? ` / ${voiceLabel}` : ''}
                </span>
              </div>
            </div>
            <div className={styles.itemActions}>
              <button type="button" className={styles.actionBtn} onClick={() => setEditing(true)} title={tc('actions.edit')}>
                <Edit3 size={13} />
              </button>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setMenuPos({ x: rect.right, y: rect.bottom + 4 })
                }}
                title={t('connectionItem.moreActions')}
              >
                <MoreVertical size={13} />
              </button>
              <ContextMenu
                position={menuPos}
                onClose={() => setMenuPos(null)}
                items={[
                  { key: 'test', label: testing ? t('connectionItem.testing') : t('connectionItem.testConnection'), icon: <Zap size={14} />, onClick: () => { setMenuPos(null); handleTest() }, disabled: testing },
                  ...(isQwen
                    ? [{
                        key: 'qwen-clones',
                        label: t('qwenCustomVoiceManager.menuAction'),
                        icon: <Volume2 size={14} />,
                        onClick: () => {
                          setMenuPos(null)
                          openModal('qwenCustomVoice', { connectionId: profile.id })
                        },
                      }]
                    : []),
                  { key: 'duplicate', label: t('connectionItem.duplicate'), icon: <Copy size={14} />, onClick: () => { setMenuPos(null); onDuplicate() } },
                  { key: 'div', type: 'divider' as const },
                  { key: 'delete', label: t('connectionItem.delete'), icon: <Trash2 size={14} />, onClick: () => { setMenuPos(null); onDelete() }, danger: true },
                ] satisfies ContextMenuEntry[]}
              />
            </div>
          </div>
          {testResult && (
            <div className={clsx(styles.testMessage, testResult.success ? styles.testMessageSuccess : styles.testMessageFail)}>
              {testResult.message}
            </div>
          )}
        </>
      )}
    </div>
  )
}
