import { useState, useEffect, useCallback } from 'react'
import { Mic, Trash2, Edit3, Zap, Star, Copy, MoreVertical } from 'lucide-react'
import { sttConnectionsApi } from '@/api/stt-connections'
import type { SttConnectionProfile, SttProviderInfo, CreateSttConnectionInput } from '@/types/api'
import STTConnectionForm from './STTConnectionForm'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import styles from '../connection-manager/ConnectionItem.module.css'
import clsx from 'clsx'

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
}

interface Props {
  profile: SttConnectionProfile
  providers: SttProviderInfo[]
  onUpdate: (profile: SttConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function STTConnectionItem({ profile, providers, onUpdate, onDuplicate, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
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
      const result = await sttConnectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }, [profile.id])

  const handleSaveEdit = useCallback(async (input: CreateSttConnectionInput) => {
    try {
      const updated = await sttConnectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[STTConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

  const providerColor = PROVIDER_COLORS[profile.provider] || 'var(--lumiverse-text-dim)'

  if (editing) {
    return (
      <div className={styles.item}>
        <STTConnectionForm
          providers={providers}
          profile={profile}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemRow}>
        <div className={styles.itemBtn} style={{ cursor: 'default' }}>
          <div
            className={styles.itemIcon}
            style={{
              background: `color-mix(in srgb, ${providerColor} 10%, transparent)`,
              color: providerColor,
            }}
          >
            <Mic size={16} />
          </div>
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
          <button type="button" className={styles.actionBtn} onClick={() => setEditing(true)} title="Edit">
            <Edit3 size={13} />
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setMenuPos({ x: rect.right, y: rect.bottom + 4 })
            }}
            title="More actions"
          >
            <MoreVertical size={13} />
          </button>
          <ContextMenu
            position={menuPos}
            onClose={() => setMenuPos(null)}
            items={[
              { key: 'test', label: testing ? 'Testing...' : 'Test connection', icon: <Zap size={14} />, onClick: () => { setMenuPos(null); handleTest() }, disabled: testing },
              { key: 'duplicate', label: 'Duplicate', icon: <Copy size={14} />, onClick: () => { setMenuPos(null); onDuplicate() } },
              { key: 'div', type: 'divider' as const },
              { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, onClick: () => { setMenuPos(null); onDelete() }, danger: true },
            ] satisfies ContextMenuEntry[]}
          />
        </div>
      </div>
      {testResult && (
        <div className={clsx(styles.testMessage, testResult.success ? styles.testMessageSuccess : styles.testMessageFail)}>
          {testResult.message}
        </div>
      )}
    </div>
  )
}
