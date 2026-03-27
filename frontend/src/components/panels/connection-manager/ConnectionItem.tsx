import { useState, useEffect, useCallback } from 'react'
import { Link2, Trash2, Edit3, Zap, Check, Loader, Star, BrainCircuit } from 'lucide-react'
import { connectionsApi } from '@/api/connections'
import type { ConnectionProfile, ProviderInfo, CreateConnectionProfileInput } from '@/types/api'
import ConnectionForm from './ConnectionForm'
import styles from './ConnectionItem.module.css'
import clsx from 'clsx'

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  openrouter: '#6366f1',
  custom: 'var(--lumiverse-text-dim)',
}

interface ConnectionItemProps {
  profile: ConnectionProfile
  isActive: boolean
  providers: ProviderInfo[]
  onSelect: () => void
  onUpdate: (profile: ConnectionProfile) => void
  onDelete: () => void
}

export default function ConnectionItem({ profile, isActive, providers, onSelect, onUpdate, onDelete }: ConnectionItemProps) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  // Auto-dismiss test result after 5s
  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await connectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }, [profile.id])

  const handleSaveEdit = useCallback(async (input: CreateConnectionProfileInput) => {
    try {
      const updated = await connectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[ConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

  const providerColor = PROVIDER_COLORS[profile.provider] || PROVIDER_COLORS.custom

  if (editing) {
    return (
      <div className={styles.item}>
        <ConnectionForm
          providers={providers}
          profile={profile}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <div className={clsx(styles.item, isActive && styles.itemActive)}>
      <div className={styles.itemRow}>
        <button type="button" className={styles.itemBtn} onClick={onSelect}>
          <div
            className={styles.itemIcon}
            style={{
              background: `color-mix(in srgb, ${providerColor} 10%, transparent)`,
              color: providerColor,
            }}
          >
            <Link2 size={16} />
          </div>
          <div className={styles.itemInfo}>
            <span className={styles.itemName}>
              {profile.name}
              {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
              {profile.metadata?.reasoningBindings && <span title="Reasoning settings bound"><BrainCircuit size={11} className={styles.reasoningBound} /></span>}
            </span>
            <span className={styles.itemMeta}>
              {profile.provider}{profile.model ? ` / ${profile.model}` : ''}
            </span>
          </div>
          {isActive && <Check size={14} className={styles.activeCheck} />}
        </button>
        <div className={styles.itemActions}>
          <button
            type="button"
            className={clsx(styles.actionBtn, testResult && (testResult.success ? styles.testSuccess : styles.testFail))}
            onClick={handleTest}
            title="Test connection"
            disabled={testing}
          >
            {testing ? <Loader size={13} className={styles.spinner} /> : <Zap size={13} />}
          </button>
          <button type="button" className={styles.actionBtn} onClick={() => setEditing(true)} title="Edit">
            <Edit3 size={13} />
          </button>
          <button type="button" className={clsx(styles.actionBtn, styles.deleteBtn)} onClick={onDelete} title="Delete">
            <Trash2 size={13} />
          </button>
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
