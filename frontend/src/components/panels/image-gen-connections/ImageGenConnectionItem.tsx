import { useState, useEffect, useCallback } from 'react'
import { ImageIcon, Trash2, Edit3, Zap, Check, Loader, Star } from 'lucide-react'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type { ImageGenConnectionProfile, ImageGenProviderInfo, CreateImageGenConnectionInput } from '@/types/api'
import ImageGenConnectionForm from './ImageGenConnectionForm'
import styles from '../connection-manager/ConnectionItem.module.css'
import clsx from 'clsx'

const PROVIDER_COLORS: Record<string, string> = {
  google_gemini: '#4285f4',
  nanogpt: '#10b981',
  novelai: '#8b5cf6',
}

interface Props {
  profile: ImageGenConnectionProfile
  isActive: boolean
  providers: ImageGenProviderInfo[]
  onSelect: () => void
  onUpdate: (profile: ImageGenConnectionProfile) => void
  onDelete: () => void
}

export default function ImageGenConnectionItem({ profile, isActive, providers, onSelect, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await imageGenConnectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }, [profile.id])

  const handleSaveEdit = useCallback(async (input: CreateImageGenConnectionInput) => {
    try {
      const updated = await imageGenConnectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[ImageGenConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

  const providerColor = PROVIDER_COLORS[profile.provider] || 'var(--lumiverse-text-dim)'

  if (editing) {
    return (
      <div className={styles.item}>
        <ImageGenConnectionForm
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
            <ImageIcon size={16} />
          </div>
          <div className={styles.itemInfo}>
            <span className={styles.itemName}>
              {profile.name}
              {profile.is_default && <Star size={11} className={styles.defaultStar} fill="#f5a623" />}
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
