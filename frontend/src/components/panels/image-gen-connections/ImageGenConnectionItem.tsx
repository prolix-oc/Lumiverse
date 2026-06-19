import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Trash2, Edit3, Zap, Check, Star, Copy, MoreVertical, RefreshCw, Workflow } from 'lucide-react'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type { ComfyUIFieldMapping, ComfyUIWorkflowConfig } from '@/api/image-gen-connections'
import type { ImageGenConnectionProfile, ImageGenProviderInfo, CreateImageGenConnectionInput, NanoGptSubscriptionUsage } from '@/types/api'
import ImageGenConnectionForm from './ImageGenConnectionForm'
import { ComfyWorkflowEditor } from './ComfyWorkflowEditor'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { Spinner } from '@/components/shared/Spinner'
import ProviderIcon from '@/components/shared/ProviderIcon'
import styles from '../connection-manager/ConnectionItem.module.css'
import clsx from 'clsx'

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatCompactCount(value: number) {
  return COMPACT_NUMBER_FORMATTER.format(value)
}

function formatTimeUntil(resetAt: number | null, unknownLabel: string) {
  if (!resetAt) return unknownLabel

  const diffMs = Math.max(0, resetAt - Date.now())
  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}d, ${hours}h`
  if (hours > 0) return `${hours}h, ${minutes}m`
  return `${minutes}m`
}

interface Props {
  profile: ImageGenConnectionProfile
  isActive: boolean
  providers: ImageGenProviderInfo[]
  onSelect: () => void
  onUpdate: (profile: ImageGenConnectionProfile) => void
  onDuplicate: () => void
  onDelete: () => void
}

export default function ImageGenConnectionItem({
 profile, isActive, providers, onSelect, onUpdate, onDuplicate, onDelete }: Props) {
  const { t: tc } = useTranslation('common')
  const { t } = useTranslation('panels')
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [nanoGptUsage, setNanoGptUsage] = useState<NanoGptSubscriptionUsage | null>(null)
  const [nanoGptUsageLoading, setNanoGptUsageLoading] = useState(false)
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false)
  const [workflowConfig, setWorkflowConfig] = useState<ComfyUIWorkflowConfig | null>(null)
  const [workflowError, setWorkflowError] = useState<string | null>(null)

  const isNanoGpt = profile.provider === 'nanogpt'
  const isComfyUI = profile.provider === 'comfyui'
  const showNanoGptUsage = isNanoGpt && isActive && profile.has_api_key && !editing

  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  useEffect(() => {
    if (!showNanoGptUsage) { setNanoGptUsage(null); return }
    setNanoGptUsageLoading(true)
    imageGenConnectionsApi.nanogptUsage(profile.id)
      .then(setNanoGptUsage)
      .catch(() => setNanoGptUsage(null))
      .finally(() => setNanoGptUsageLoading(false))
  }, [showNanoGptUsage, profile.id])

  const refreshNanoGptUsage = useCallback(() => {
    if (!showNanoGptUsage) return
    setNanoGptUsageLoading(true)
    imageGenConnectionsApi.nanogptUsage(profile.id)
      .then(setNanoGptUsage)
      .catch(() => setNanoGptUsage(null))
      .finally(() => setNanoGptUsageLoading(false))
  }, [showNanoGptUsage, profile.id])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await imageGenConnectionsApi.test(profile.id)
      setTestResult({ success: result.success, message: result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || t('connectionItem.connectionFailed') })
    } finally {
      setTesting(false)
    }
  }, [profile.id, t])

  const refreshComfyProfile = useCallback(async () => {
    try {
      onUpdate(await imageGenConnectionsApi.get(profile.id))
    } catch {
      // The workflow update already succeeded; stale list metadata is non-fatal.
    }
  }, [onUpdate, profile.id])

  const openWorkflowEditor = useCallback(async () => {
    if (!isComfyUI) return
    setMenuPos(null)
    setWorkflowEditorOpen(true)
    setWorkflowError(null)
    try {
      const configResponse = await imageGenConnectionsApi.getComfyUIWorkflowConfig(profile.id)
      setWorkflowConfig(configResponse.config)
    } catch (err: any) {
      setWorkflowError(err?.message || t('connectionItem.loadComfyWorkflowFailed'))
    }
  }, [isComfyUI, profile.id, t])

  const importComfyWorkflow = useCallback(async (workflow: unknown) => {
    const response = await imageGenConnectionsApi.importComfyUIWorkflow(profile.id, workflow)
    setWorkflowConfig(response.config)
    await refreshComfyProfile()
    return response.config
  }, [profile.id, refreshComfyProfile])

  const updateComfyMappings = useCallback(async (mappings: ComfyUIFieldMapping[]) => {
    const response = await imageGenConnectionsApi.updateComfyUIWorkflowMappings(profile.id, mappings)
    setWorkflowConfig(response.config)
    await refreshComfyProfile()
    return response.config
  }, [profile.id, refreshComfyProfile])

  const handleSaveEdit = useCallback(async (input: CreateImageGenConnectionInput) => {
    try {
      const updated = await imageGenConnectionsApi.update(profile.id, input)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      console.error('[ImageGenConnectionItem] Failed to update:', err)
    }
  }, [profile.id, onUpdate])

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
          <ProviderIcon kind="imageGen" provider={profile.provider} size={32} iconSize={16} className={styles.itemIcon} />
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
              ...(isComfyUI ? [{ key: 'workflow', label: t('connectionItem.comfyWorkflow'), icon: <Workflow size={14} />, onClick: openWorkflowEditor }] : []),
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
      {showNanoGptUsage && nanoGptUsage && (nanoGptUsage.daily || nanoGptUsage.monthly) && (
        [
          { key: 'daily', label: t('connectionItem.daily'), window: nanoGptUsage.daily, limit: nanoGptUsage.limits.daily },
          { key: 'monthly', label: t('connectionItem.monthly'), window: nanoGptUsage.monthly, limit: nanoGptUsage.limits.monthly },
        ]
          .filter((entry): entry is typeof entry & { window: NonNullable<typeof entry.window> } => entry.window != null)
          .map(({ key, label, window: win, limit }, idx) => (
            <div key={key} className={clsx(styles.creditsBar, styles.nanoGptUsageBar)}>
              <div className={styles.creditCell}>
                <span className={styles.creditLabel}>{label}</span>
                <span className={styles.creditValue}>
                  {limit !== null
                    ? `${formatCompactCount(win.remaining)} / ${formatCompactCount(limit)}`
                    : formatCompactCount(win.remaining)}
                </span>
              </div>
              <div className={styles.creditCell}>
                <span className={styles.creditLabel}>{t('connectionItem.used')}</span>
                <span className={styles.creditValue}>{formatCompactCount(win.used)}</span>
              </div>
              <div className={styles.creditCell}>
                <span className={styles.creditLabel}>{t('connectionItem.resetsIn')}</span>
                <span className={styles.creditValue}>{formatTimeUntil(win.resetAt, t('connectionItem.unknown'))}</span>
              </div>
              {idx === 0 && (
                <button type="button" className={styles.creditsRefresh} onClick={refreshNanoGptUsage} disabled={nanoGptUsageLoading}>
                  {nanoGptUsageLoading ? <Spinner size={10} /> : <RefreshCw size={10} />}
                </button>
              )}
            </div>
          ))
      )}
      {workflowEditorOpen && (
        <ComfyWorkflowEditor
          config={workflowConfig}
          error={workflowError}
          onImportWorkflow={importComfyWorkflow}
          onUpdateMappings={updateComfyMappings}
          onClose={() => setWorkflowEditorOpen(false)}
        />
      )}
    </div>
  )
}
