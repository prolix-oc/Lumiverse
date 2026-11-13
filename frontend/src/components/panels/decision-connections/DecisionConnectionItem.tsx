import type { ConnectionPlacement } from '@/lib/connectionPlacement'
import { useConnectionRow } from '@/components/panels/connection-manager/useConnectionRow'
import { saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Trash2, Edit3, Zap, Star, Copy, MoreVertical, GripVertical } from 'lucide-react'
import { decisionConnectionsApi } from '@/api/decision-connections'
import type { DecisionConnectionProfile, DecisionProviderInfo, CreateDecisionConnectionInput } from '@/types/api'
import DecisionConnectionForm from './DecisionConnectionForm'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ProviderIcon from '@/components/shared/ProviderIcon'
import styles from '../connection-manager/ConnectionItem.module.css'
import clsx from 'clsx'

interface Props {
  placement?: ConnectionPlacement
  profile: DecisionConnectionProfile
  providers: DecisionProviderInfo[]
  onUpdate: (profile: DecisionConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function DecisionConnectionItem({
  placement = 'list', profile, providers, onUpdate, onDuplicate, onDelete }: Props) {
  const { t: tc } = useTranslation('common')
  const { t } = useTranslation('panels')
  const { editing, setEditing, isRecent, ...sortable } = useConnectionRow(profile.id, placement)
  const [testing, setTesting] = useState(false)
  const [sampling, setSampling] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)

  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await decisionConnectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || t('connectionItem.connectionFailed') })
    } finally {
      setTesting(false)
    }
  }, [profile.id, t])

  const handleSample = useCallback(async () => {
    setSampling(true)
    setTestResult(null)
    try {
      const result = await decisionConnectionsApi.sample(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err?.body?.error || err.message || t('connectionItem.connectionFailed') })
    } finally { setSampling(false) }
  }, [profile.id, t])

  const handleSaveEdit = useCallback(async (input: CreateDecisionConnectionInput, folderId = '') => {
    const updated = await decisionConnectionsApi.update(profile.id, input)
    saveConnectionFolder('decision', profile.id, folderId)
    onUpdate(updated)
    setEditing(false)
  }, [profile.id, onUpdate, setEditing])

  const { attributes, listeners, setNodeRef, style, isDragging, handleRef } = sortable

  return (
    <div ref={setNodeRef} style={style} data-dragging={isDragging || undefined} className={clsx(styles.item, isDragging && styles.itemDragging)}>
      {editing ? (
        <DecisionConnectionForm
          providers={providers}
          profile={profile}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
          onOAuthComplete={(updated) => onUpdate(updated)}
        />
      ) : (
        <>
          <div className={styles.itemRow}>
            {!isRecent && <button
              ref={handleRef}
              type="button"
              className={styles.dragHandle}
              aria-label={t('connectionItem.dragToReorder')}
              title={t('connectionItem.dragToReorder')}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={16} />
            </button>}
            <div className={styles.itemBtn} onMouseDown={event => listeners?.onMouseDown?.(event)} onTouchStart={event => listeners?.onTouchStart?.(event)} style={{ cursor: 'default' }}>
              <ProviderIcon kind="decision" provider={profile.provider} size={32} iconSize={16} className={styles.itemIcon} />
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>
                  {profile.name}
                  {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
                </span>
                <span className={styles.itemMeta}>
                  {profile.provider}
                  {profile.model ? ` / ${profile.model}` : ''}
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
                  { key: 'sample', label: sampling ? t('decisionConnectionForm.checking') : t('decisionConnectionForm.sample'), icon: <Zap size={14} />, onClick: () => { setMenuPos(null); handleSample() }, disabled: sampling || testing || !profile.has_api_key || !profile.model },
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
