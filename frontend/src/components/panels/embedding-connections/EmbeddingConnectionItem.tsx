import type { ConnectionPlacement } from '@/lib/connectionPlacement'
import { useConnectionRow } from '@/components/panels/connection-manager/useConnectionRow'
import { saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { Edit3, Trash2, Zap, GripVertical } from 'lucide-react'
import clsx from 'clsx'
import ProviderIcon from '@/components/shared/ProviderIcon'
import { embeddingsApi, type EmbeddingConnectionProfile, type EmbeddingDriverOption } from '@/api/embeddings'
import EmbeddingConnectionForm, { type EmbeddingConnectionDraft } from './EmbeddingConnectionForm'
import styles from '../connection-manager/ConnectionItem.module.css'

interface Props {
  placement?: ConnectionPlacement
  profile: EmbeddingConnectionProfile
  providers: EmbeddingDriverOption[]
  onUpdate: (profile: EmbeddingConnectionDraft) => Promise<boolean>
  onDelete: () => void
  disabled?: boolean
}

export default function EmbeddingConnectionItem({ placement = 'list', profile, providers, onUpdate, onDelete, disabled }: Props) {
  const { t } = useTranslation('panels')
  const { editing, setEditing, isRecent, ...sortable } = useConnectionRow(profile.id, placement)
  const { setNodeRef, style } = sortable
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await embeddingsApi.testConnection(profile.id)
      setTestResult({ success: result.success, message: result.dimension ? `Connection successful (${result.dimension} dimensions)` : result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err?.body?.message || err?.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div ref={setNodeRef} style={style} data-dragging={sortable.isDragging || undefined} className={clsx(styles.item, sortable.isDragging && styles.itemDragging)}>
      {editing ? (
        <EmbeddingConnectionForm
          providers={providers}
          profile={profile}
          onSave={async (next, folderId = '') => {
            if (await onUpdate(next)) {
              saveConnectionFolder('embedding', profile.id, folderId)
              setEditing(false)
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className={styles.itemRow}>
            {!isRecent && <button type="button" className={styles.dragHandle} {...sortable.attributes} {...sortable.listeners}
              aria-label={t('connectionItem.dragToReorder')}><GripVertical size={16} /></button>}
            <div className={styles.itemBtn} onMouseDown={event => sortable.listeners?.onMouseDown?.(event)} onTouchStart={event => sortable.listeners?.onTouchStart?.(event)} style={{ cursor: 'default' }}>
              <ProviderIcon kind="embedding" provider={profile.provider} size={32} iconSize={16} className={styles.itemIcon} />
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{profile.name || profile.provider}</span>
                <span className={styles.itemMeta}>
                  {profile.provider} / {profile.model}{profile.dimensions ? ` / ${profile.dimensions}d` : ''}
                </span>
              </div>
            </div>
            <div className={styles.itemActions}>
              <button type="button" className={clsx(styles.actionBtn, testResult?.success && styles.testSuccess, testResult && !testResult.success && styles.testFail)} onClick={test} disabled={testing} title="Test connection">
                <Zap size={13} />
              </button>
              <button type="button" className={styles.actionBtn} onClick={() => setEditing(true)} disabled={disabled} title="Edit">
                <Edit3 size={13} />
              </button>
              <button type="button" className={styles.actionBtn} onClick={onDelete} disabled={disabled} title="Delete">
                <Trash2 size={13} />
              </button>
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
