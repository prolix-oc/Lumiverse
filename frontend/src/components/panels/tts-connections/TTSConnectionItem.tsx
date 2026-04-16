import { useState, useEffect, useCallback } from 'react'
import { Volume2, Trash2, Edit3, Zap, Check, Loader, Star, Copy, MoreVertical } from 'lucide-react'
import { ttsConnectionsApi } from '@/api/tts-connections'
import type { TtsConnectionProfile, TtsProviderInfo, CreateTtsConnectionInput } from '@/types/api'
import TTSConnectionForm from './TTSConnectionForm'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import styles from '../connection-manager/ConnectionItem.module.css'
import clsx from 'clsx'

const PROVIDER_COLORS: Record<string, string> = {
  openai_tts: '#10a37f',
  elevenlabs: '#8b5cf6',
  kokoro: '#f59e0b',
}

interface Props {
  profile: TtsConnectionProfile
  providers: TtsProviderInfo[]
  onUpdate: (profile: TtsConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function TTSConnectionItem({ profile, providers, onUpdate, onDuplicate, onDelete }: Props) {
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
      const result = await ttsConnectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }, [profile.id])

  const handleSaveEdit = useCallback(async (input: CreateTtsConnectionInput) => {
    try {
      const updated = await ttsConnectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[TTSConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

  const providerColor = PROVIDER_COLORS[profile.provider] || 'var(--lumiverse-text-dim)'

  if (editing) {
    return (
      <div className={styles.item}>
        <TTSConnectionForm
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
            <Volume2 size={16} />
          </div>
          <div className={styles.itemInfo}>
            <span className={styles.itemName}>
              {profile.name}
              {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
            </span>
            <span className={styles.itemMeta}>
              {profile.provider}
              {profile.model ? ` / ${profile.model}` : ''}
              {profile.voice ? ` / ${profile.voice}` : ''}
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
