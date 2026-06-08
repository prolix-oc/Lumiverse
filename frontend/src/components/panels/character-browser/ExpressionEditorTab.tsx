import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Upload, Image as ImageIcon, Ghost, Trash2, Users } from 'lucide-react'
import { expressionsApi } from '@/api/expressions'
import { characterGalleryApi } from '@/api/character-gallery'
import { connectionsApi } from '@/api/connections'
import { imagesApi } from '@/api/images'
import { settingsApi } from '@/api/settings'
import { useStore } from '@/store'
import ExpressionSlotCard from './ExpressionSlotCard'
import ImageLightbox from '@/components/shared/ImageLightbox'
import NumericInput from '@/components/shared/NumericInput'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { Toggle } from '@/components/shared/Toggle'
import type { ExpressionConfig, ExpressionSlot, ExpressionGroups } from '@/types/expressions'
import type { CharacterGalleryItem } from '@/types/api'
import styles from './ExpressionEditorTab.module.css'
import editorStyles from './CharacterEditorPage.module.css'

type DetectionMode = 'auto' | 'council' | 'off'

interface DetectionSettings {
  mode: DetectionMode
  contextWindow: number
  connectionProfileId?: string
  model?: string
}

const DETECTION_DEFAULTS: DetectionSettings = { mode: 'auto', contextWindow: 5 }

interface Props {
  characterId: string
}

function toExpressionLabel(fileName: string, fallback: string) {
  const baseName = fileName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_\- ]/g, '').trim()
  return baseName || fallback
}

export default function ExpressionEditorTab({ characterId }: Props) {
  const { t } = useTranslation('panels')
  const defaultExpressionLabel = t('characterEditor.expressionEditor.defaultExpressionLabel')
  const [config, setConfig] = useState<ExpressionConfig | null>(null)
  const [groups, setGroups] = useState<ExpressionGroups | null>(null)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [showGalleryPicker, setShowGalleryPicker] = useState(false)
  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [pickerLabel, setPickerLabel] = useState('')
  const [pickerImageId, setPickerImageId] = useState<string | null>(null)
  const [detection, setDetection] = useState<DetectionSettings>(DETECTION_DEFAULTS)
  const [exprModels, setExprModels] = useState<string[]>([])
  const [exprModelLabels, setExprModelLabels] = useState<Record<string, string>>({})
  const [exprModelsLoading, setExprModelsLoading] = useState(false)
  const profiles = useStore((s) => s.profiles)
  const zipRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const fetchConfig = useCallback(() => {
    setLoading(true)
    Promise.all([
      expressionsApi.get(characterId).catch(() => ({ enabled: false, defaultExpression: '', mappings: {} } as ExpressionConfig)),
      expressionsApi.getGroups(characterId).catch(() => ({} as ExpressionGroups)),
    ]).then(([cfg, grps]) => {
      setConfig(cfg)
      const hasGroups = grps && Object.keys(grps).length > 0
      setGroups(hasGroups ? grps : null)
      if (hasGroups && !activeGroup) {
        setActiveGroup(Object.keys(grps).filter((n) => n !== '_default')[0] || Object.keys(grps)[0] || null)
      }
    }).finally(() => setLoading(false))
  }, [characterId])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  // Load detection settings (global, not per-character)
  useEffect(() => {
    settingsApi.get('expressionDetection')
      .then((row) => {
        if (row?.value) setDetection({ ...DETECTION_DEFAULTS, ...(row.value as Partial<DetectionSettings>) })
      })
      .catch(() => {})
  }, [])

  const fetchExprModels = useCallback(async () => {
    if (!detection.connectionProfileId) {
      setExprModels([])
      setExprModelLabels({})
      return
    }
    setExprModelsLoading(true)
    try {
      const result = await connectionsApi.models(detection.connectionProfileId)
      setExprModels(result.models || [])
      setExprModelLabels(result.model_labels || {})
    } catch {
      setExprModels([])
      setExprModelLabels({})
    } finally {
      setExprModelsLoading(false)
    }
  }, [detection.connectionProfileId])

  useEffect(() => {
    if (!detection.connectionProfileId) {
      setExprModels([])
      setExprModelLabels({})
      return
    }
    fetchExprModels()
  }, [fetchExprModels, detection.connectionProfileId])

  const saveDetection = useCallback((updated: DetectionSettings) => {
    setDetection(updated)
    settingsApi.put('expressionDetection', updated).catch(() => {})
  }, [])

  const saveConfig = useCallback(
    (updated: ExpressionConfig) => {
      setConfig(updated)
      expressionsApi.put(characterId, updated).catch(() => {})
    },
    [characterId]
  )

  const handleToggleEnabled = useCallback(() => {
    if (!config) return
    saveConfig({ ...config, enabled: !config.enabled })
  }, [config, saveConfig])

  const handleDefaultChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!config) return
      saveConfig({ ...config, defaultExpression: e.target.value })
    },
    [config, saveConfig]
  )

  const handleZipUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''
      setUploading(true)
      try {
        const result = await expressionsApi.uploadZip(characterId, file)
        setConfig(result)
      } catch {
        // silent
      } finally {
        setUploading(false)
      }
    },
    [characterId]
  )

  const handleDelete = useCallback(
    (label: string) => {
      expressionsApi.removeLabel(characterId, label)
        .then(setConfig)
        .catch(() => {})
    },
    [characterId]
  )

  const handleRename = useCallback(
    (oldLabel: string, newLabel: string) => {
      if (!config) return
      const imageId = config.mappings[oldLabel]
      if (!imageId) return
      const { [oldLabel]: _, ...rest } = config.mappings
      const updated: ExpressionConfig = {
        ...config,
        mappings: { ...rest, [newLabel]: imageId },
        defaultExpression: config.defaultExpression === oldLabel ? newLabel : config.defaultExpression,
      }
      saveConfig(updated)
    },
    [config, saveConfig]
  )

  const handleDirectUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0 || !config) return
      e.target.value = ''
      setUploading(true)
      try {
        let updated: ExpressionConfig = {
          ...config,
          mappings: { ...config.mappings },
        }
        let hasChanges = false

        for (const file of files) {
          try {
            const image = await imagesApi.upload(file)
            const label = toExpressionLabel(file.name, defaultExpressionLabel)
            updated = {
              ...updated,
              enabled: true,
              mappings: { ...updated.mappings, [label]: image.id },
              defaultExpression: updated.defaultExpression || label,
            }
            hasChanges = true
          } catch {
            // Continue processing the rest of the selection.
          }
        }

        if (hasChanges) {
          saveConfig(updated)
        }
      } catch {
        // silent
      } finally {
        setUploading(false)
      }
    },
    [characterId, config, saveConfig, defaultExpressionLabel]
  )

  const openGalleryPicker = useCallback(() => {
    setShowGalleryPicker(true)
    characterGalleryApi.list(characterId)
      .then(setGalleryItems)
      .catch(() => setGalleryItems([]))
  }, [characterId])

  const confirmGalleryPick = useCallback(() => {
    if (!pickerImageId || !pickerLabel.trim() || !config) return
    const label = pickerLabel.trim().toLowerCase()
    const updated: ExpressionConfig = {
      ...config,
      enabled: true,
      mappings: { ...config.mappings, [label]: pickerImageId },
      defaultExpression: config.defaultExpression || label,
    }
    saveConfig(updated)
    setShowGalleryPicker(false)
    setPickerLabel('')
    setPickerImageId(null)
  }, [pickerImageId, pickerLabel, config, saveConfig])

  // ── Multi-character group management ──────────────────────────────────────

  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const groupZipRef = useRef<HTMLInputElement>(null)
  const groupUploadRef = useRef<HTMLInputElement>(null)

  const handleConvertToGroups = useCallback(() => {
    expressionsApi.convertToGroups(characterId).then((grps) => {
      setGroups(grps)
      setConfig({ enabled: false, defaultExpression: '', mappings: {} })
      setActiveGroup(Object.keys(grps)[0] || null)
    }).catch(() => {})
  }, [characterId])

  const handleConvertToFlat = useCallback(() => {
    if (!activeGroup) return
    expressionsApi.convertToFlat(characterId, activeGroup).then((cfg) => {
      setConfig(cfg)
      setGroups(null)
      setActiveGroup(null)
    }).catch(() => {})
  }, [characterId, activeGroup])

  const handleAddGroup = useCallback(() => {
    const name = newGroupName.trim()
    if (!name) return
    expressionsApi.addGroup(characterId, name).then((grps) => {
      setGroups(grps)
      setActiveGroup(name)
      setShowAddGroup(false)
      setNewGroupName('')
    }).catch(() => {})
  }, [characterId, newGroupName])

  const handleGroupZipUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !activeGroup) return
      e.target.value = ''
      setUploading(true)
      try {
        const updated = await expressionsApi.uploadGroupZip(characterId, activeGroup, file)
        setGroups(updated)
      } catch { /* silent */ }
      finally { setUploading(false) }
    },
    [characterId, activeGroup]
  )

  const handleGroupDirectUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0 || !activeGroup || !groups || !groups[activeGroup]) return
      e.target.value = ''
      setUploading(true)
      try {
        let updated: ExpressionGroups = {
          ...groups,
          [activeGroup]: { ...groups[activeGroup] },
        }
        let hasChanges = false

        for (const file of files) {
          try {
            const image = await imagesApi.upload(file)
            const label = toExpressionLabel(file.name, defaultExpressionLabel)
            updated = {
              ...updated,
              [activeGroup]: {
                ...updated[activeGroup],
                [label]: image.id,
              },
            }
            hasChanges = true
          } catch {
            // Continue processing the rest of the selection.
          }
        }

        if (hasChanges) {
          setGroups(updated)
          await expressionsApi.putGroups(characterId, updated)
        }
      } catch { /* silent */ }
      finally { setUploading(false) }
    },
    [characterId, activeGroup, groups, defaultExpressionLabel]
  )

  const handleGroupGalleryPick = useCallback(() => {
    if (!pickerImageId || !pickerLabel.trim() || !activeGroup) return
    const label = pickerLabel.trim().toLowerCase()
    expressionsApi.addGroupLabel(characterId, activeGroup, label, pickerImageId).then((updated) => {
      setGroups(updated)
      setShowGalleryPicker(false)
      setPickerLabel('')
      setPickerImageId(null)
    }).catch(() => {})
  }, [characterId, activeGroup, pickerImageId, pickerLabel])

  const groupNames = useMemo(() => {
    if (!groups) return []
    // Named characters first, _default last
    const named = Object.keys(groups).filter((n) => n !== '_default').sort()
    if (groups['_default']) named.push('_default')
    return named
  }, [groups])

  const multiDetectionModes = useMemo(
    () =>
      [
        { mode: 'auto' as const, name: t('characterEditor.expressionEditor.modes.auto.name'), desc: t('characterEditor.expressionEditor.modes.auto.descMulti') },
        { mode: 'off' as const, name: t('characterEditor.expressionEditor.modes.off.name'), desc: t('characterEditor.expressionEditor.modes.off.descMulti') },
      ] as const,
    [t],
  )

  const singleDetectionModes = useMemo(
    () =>
      [
        { mode: 'auto' as const, name: t('characterEditor.expressionEditor.modes.auto.name'), desc: t('characterEditor.expressionEditor.modes.auto.descSingle') },
        { mode: 'council' as const, name: t('characterEditor.expressionEditor.modes.council.name'), desc: t('characterEditor.expressionEditor.modes.council.desc') },
        { mode: 'off' as const, name: t('characterEditor.expressionEditor.modes.off.descManual'), desc: t('characterEditor.expressionEditor.modes.off.descSingle') },
      ] as const,
    [t],
  )

  const renderAutoDetectionFields = (showContextWindow: boolean) => (
    <>
      {showContextWindow && (
        <div className={styles.contextRow}>
          <label htmlFor="expr-context-window">{t('characterEditor.expressionEditor.messagesToAnalyze')}</label>
          <NumericInput
            id="expr-context-window"
            className={styles.contextInput}
            value={detection.contextWindow}
            min={1}
            max={20}
            integer
            onChange={(value) => {
              const val = Math.max(1, Math.min(20, value ?? 5))
              saveDetection({ ...detection, contextWindow: val })
            }}
          />
        </div>
      )}
      <div className={styles.detectionField}>
        <label className={styles.detectionFieldLabel}>{t('characterEditor.expressionEditor.connectionProfile')}</label>
        <ConnectionSelect
          kind="llm"
          value={detection.connectionProfileId || ''}
          onChange={(val) => saveDetection({ ...detection, connectionProfileId: val, model: profiles.find((p) => p.id === val)?.model || '' })}
          placeholder={t('characterEditor.expressionEditor.useSidecarDefault')}
          searchPlaceholder={t('characterEditor.expressionEditor.searchConnections')}
          emptyMessage={t('characterEditor.expressionEditor.noConnectionProfiles')}
          clearable
          clearLabel={t('characterEditor.expressionEditor.useSidecarDefault')}
        />
      </div>
      <div className={styles.detectionField}>
        <label className={styles.detectionFieldLabel}>{t('characterEditor.expressionEditor.model')}</label>
        <ModelCombobox
          value={detection.model || ''}
          onChange={(val) => saveDetection({ ...detection, model: val })}
          placeholder={
            detection.connectionProfileId
              ? t('characterEditor.expressionEditor.modelPlaceholderWithConnection')
              : t('characterEditor.expressionEditor.selectConnectionFirst')
          }
          models={exprModels}
          modelLabels={exprModelLabels}
          loading={exprModelsLoading}
          onRefresh={fetchExprModels}
          autoRefreshOnFocus
          refreshKey={detection.connectionProfileId}
          disabled={!detection.connectionProfileId}
          emptyMessage={
            detection.connectionProfileId
              ? t('characterEditor.expressionEditor.noModelsReturned')
              : t('characterEditor.expressionEditor.selectConnectionProfileFirst')
          }
        />
        {!detection.connectionProfileId && (
          <span className={styles.detectionFieldHint}>{t('characterEditor.expressionEditor.sidecarFallbackHint')}</span>
        )}
      </div>
    </>
  )

  const renderGalleryPicker = (onConfirm: () => void) => (
    <div>
      <span className={editorStyles.fieldLabel}>{t('characterEditor.expressionEditor.selectFromGallery')}</span>
      {galleryItems.length === 0 ? (
        <div className={styles.emptyHint} style={{ padding: '20px 0' }}>
          {t('characterEditor.expressionEditor.noGalleryImages')}
        </div>
      ) : (
        <>
          <div className={styles.galleryModal}>
            {galleryItems.map((item) => (
              <div
                key={item.id}
                className={`${styles.galleryPickItem}${pickerImageId === item.image_id ? ` ${styles.selected}` : ''}`}
                onClick={() => {
                  setPickerImageId(item.image_id)
                  if (!pickerLabel) setPickerLabel(item.caption || defaultExpressionLabel)
                }}
              >
                <img src={characterGalleryApi.smallUrl(item.image_id)} alt={item.caption || ''} className={styles.galleryPickImage} />
              </div>
            ))}
          </div>
          {pickerImageId && (
            <div className={styles.labelPrompt}>
              <span className={editorStyles.fieldHelper}>{t('characterEditor.expressionEditor.expressionLabelPrompt')}</span>
              <input
                type="text"
                className={styles.labelPromptInput}
                value={pickerLabel}
                onChange={(e) => setPickerLabel(e.target.value)}
                placeholder={t('characterEditor.expressionEditor.expressionLabelPlaceholder')}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') onConfirm() }}
              />
              <div className={styles.labelPromptActions}>
                <button type="button" className={styles.labelPromptBtn} onClick={() => { setShowGalleryPicker(false); setPickerImageId(null); setPickerLabel('') }}>
                  {t('characterEditor.expressionEditor.cancel')}
                </button>
                <button type="button" className={styles.labelPromptBtnPrimary} onClick={onConfirm} disabled={!pickerLabel.trim()}>
                  {t('characterEditor.expressionEditor.addExpression')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )

  const activeGroupSlots: ExpressionSlot[] = useMemo(() => {
    if (!groups || !activeGroup || !groups[activeGroup]) return []
    return Object.entries(groups[activeGroup]).map(([label, imageId]) => ({ label, imageId }))
  }, [groups, activeGroup])

  const handleGroupLabelDelete = useCallback(
    (label: string) => {
      if (!activeGroup) return
      expressionsApi.removeGroupLabel(characterId, activeGroup, label)
        .then((updated) => {
          setGroups(Object.keys(updated).length > 0 ? updated : null)
          if (!updated[activeGroup]) {
            setActiveGroup(Object.keys(updated).filter((n) => n !== '_default')[0] || Object.keys(updated)[0] || null)
          }
        })
        .catch(() => {})
    },
    [characterId, activeGroup]
  )

  const handleGroupLabelRename = useCallback(
    (oldLabel: string, newLabel: string) => {
      if (!groups || !activeGroup || !groups[activeGroup]) return
      const groupMap = groups[activeGroup]
      const imageId = groupMap[oldLabel]
      if (!imageId) return
      const { [oldLabel]: _, ...rest } = groupMap
      const updated: ExpressionGroups = { ...groups, [activeGroup]: { ...rest, [newLabel]: imageId } }
      setGroups(updated)
      expressionsApi.putGroups(characterId, updated).catch(() => {})
    },
    [characterId, groups, activeGroup]
  )

  const handleDeleteGroup = useCallback(
    (groupName: string) => {
      expressionsApi.removeGroup(characterId, groupName)
        .then((updated) => {
          const hasRemaining = Object.keys(updated).length > 0
          setGroups(hasRemaining ? updated : null)
          if (activeGroup === groupName) {
            setActiveGroup(
              hasRemaining
                ? Object.keys(updated).filter((n) => n !== '_default')[0] || Object.keys(updated)[0] || null
                : null
            )
          }
        })
        .catch(() => {})
    },
    [characterId, activeGroup]
  )

  if (loading) return null

  // ── Multi-character grouped view ────────────────────────────────────────
  if (groups && groupNames.length > 0) {
    const totalExpressions = Object.values(groups).reduce((sum, g) => sum + Object.keys(g).length, 0)

    return (
      <div>
        <div className={styles.header}>
          <span className={editorStyles.fieldLabel}>{t('characterEditor.expressionEditor.titleMulti')}</span>
          <span className={editorStyles.fieldHelper}>
            {t('characterEditor.expressionEditor.titleMultiHelper', {
              count: groupNames.filter((n) => n !== '_default').length,
              total: totalExpressions,
            })}
          </span>
        </div>

        <div className={styles.detectionSection}>
          <div className={styles.detectionHeader}>{t('characterEditor.expressionEditor.detectionHeader')}</div>
          <div className={styles.detectionHint}>{t('characterEditor.expressionEditor.detectionHintMulti')}</div>
          <div className={styles.detectionModes}>
            {multiDetectionModes.map(({ mode, name, desc }) => (
              <label key={mode} className={styles.modeOption}>
                <input
                  type="radio"
                  name="expr-detection-mode"
                  checked={detection.mode === mode || (detection.mode === 'council' && mode === 'auto')}
                  onChange={() => saveDetection({ ...detection, mode })}
                />
                <span className={styles.modeLabel}>
                  <span className={styles.modeName}>{name}</span>
                  <span className={styles.modeDesc}>{desc}</span>
                </span>
              </label>
            ))}
          </div>
          {detection.mode === 'auto' && renderAutoDetectionFields(false)}
        </div>

        {/* Character group tabs + add button */}
        <div className={styles.groupTabs}>
          {groupNames.map((name) => (
            <button
              key={name}
              type="button"
              className={activeGroup === name ? styles.groupTabActive : styles.groupTab}
              onClick={() => setActiveGroup(name)}
            >
              {name === '_default' ? t('characterEditor.expressionEditor.defaultGroup') : name}
              <span className={styles.groupTabCount}>{Object.keys(groups[name]).length}</span>
            </button>
          ))}
          <button
            type="button"
            className={styles.groupTab}
            onClick={() => setShowAddGroup(true)}
            title={t('characterEditor.expressionEditor.addCharacterTitle')}
          >
            <Plus size={14} />
          </button>
        </div>

        {showAddGroup && (
          <div className={styles.labelPrompt}>
            <span className={editorStyles.fieldHelper}>{t('characterEditor.expressionEditor.newGroupPrompt')}</span>
            <input
              type="text"
              className={styles.labelPromptInput}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder={t('characterEditor.expressionEditor.newGroupPlaceholder')}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddGroup() }}
            />
            <div className={styles.labelPromptActions}>
              <button type="button" className={styles.labelPromptBtn} onClick={() => { setShowAddGroup(false); setNewGroupName('') }}>
                {t('characterEditor.expressionEditor.cancel')}
              </button>
              <button type="button" className={styles.labelPromptBtnPrimary} onClick={handleAddGroup} disabled={!newGroupName.trim()}>
                {t('characterEditor.expressionEditor.addCharacterBtn')}
              </button>
            </div>
          </div>
        )}

        {/* Active group content */}
        {activeGroup && groups[activeGroup] && (
          <>
            <div className={styles.groupHeader}>
              <span className={styles.count}>
                {t('characterEditor.expressionEditor.expressionsCount', { count: activeGroupSlots.length })}
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {groupNames.length === 1 && (
                  <button type="button" className={styles.groupDeleteBtn} onClick={handleConvertToFlat}>
                    {t('characterEditor.expressionEditor.switchToSingle')}
                  </button>
                )}
                <button type="button" className={styles.groupDeleteBtn} onClick={() => handleDeleteGroup(activeGroup)}>
                  <Trash2 size={12} /> {t('characterEditor.expressionEditor.removeGroup')}
                </button>
              </div>
            </div>

            <div className={styles.controls}>
              <button type="button" className={styles.controlBtn} onClick={() => groupZipRef.current?.click()}>
                <Upload size={14} /> {t('characterEditor.expressionEditor.importZip')}
              </button>
              <button type="button" className={styles.controlBtn} onClick={openGalleryPicker}>
                <ImageIcon size={14} /> {t('characterEditor.expressionEditor.addFromGallery')}
              </button>
              <button type="button" className={styles.controlBtn} onClick={() => groupUploadRef.current?.click()}>
                <Plus size={14} /> {t('characterEditor.expressionEditor.uploadImages')}
              </button>
              <input ref={groupZipRef} type="file" accept=".zip" hidden onChange={handleGroupZipUpload} />
              <input ref={groupUploadRef} type="file" accept="image/*" multiple hidden onChange={handleGroupDirectUpload} />
            </div>

            {uploading && <div className={styles.uploading}>{t('characterEditor.expressionEditor.uploading')}</div>}

            {activeGroupSlots.length === 0 && !uploading && (
              <div className={styles.empty}>
                <Ghost size={40} className={styles.emptyIcon} />
                <div className={styles.emptyTitle}>{t('characterEditor.expressionEditor.emptyTitle')}</div>
                <div className={styles.emptyHint}>{t('characterEditor.expressionEditor.emptyHintMulti')}</div>
              </div>
            )}

            {activeGroupSlots.length > 0 && (
              <div className={styles.grid}>
                {activeGroupSlots.map((slot) => (
                  <ExpressionSlotCard
                    key={slot.label}
                    label={slot.label}
                    imageId={slot.imageId}
                    onDelete={handleGroupLabelDelete}
                    onRename={handleGroupLabelRename}
                    onPreview={setLightboxSrc}
                  />
                ))}
                <div className={styles.addCard} onClick={() => groupUploadRef.current?.click()}>
                  <Plus size={24} />
                </div>
              </div>
            )}
          </>
        )}

        {showGalleryPicker && renderGalleryPicker(handleGroupGalleryPick)}

        {lightboxSrc && (
          <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
        )}
      </div>
    )
  }

  // ── Single-character flat view (existing) ───────────────────────────────

  const slots: ExpressionSlot[] = config
    ? Object.entries(config.mappings).map(([label, imageId]) => ({ label, imageId }))
    : []

  const hasSlots = slots.length > 0

  return (
    <div>
      <div className={styles.header}>
        <span className={editorStyles.fieldLabel}>{t('characterEditor.expressionEditor.title')}</span>
        <span className={editorStyles.fieldHelper}>{t('characterEditor.expressionEditor.titleHelper')}</span>
      </div>

      <div className={styles.enableRow}>
        <Toggle.Checkbox
          checked={config?.enabled ?? false}
          onChange={handleToggleEnabled}
          label={t('characterEditor.expressionEditor.enableDisplay')}
        />
      </div>

      {hasSlots && (
        <div className={styles.detectionSection}>
          <div className={styles.detectionHeader}>{t('characterEditor.expressionEditor.detectionHeader')}</div>
          <div className={styles.detectionHint}>{t('characterEditor.expressionEditor.detectionHintSingle')}</div>
          <div className={styles.detectionModes}>
            {singleDetectionModes.map(({ mode, name, desc }) => (
              <label key={mode} className={styles.modeOption}>
                <input
                  type="radio"
                  name="expr-detection-mode"
                  checked={detection.mode === mode}
                  onChange={() => saveDetection({ ...detection, mode })}
                />
                <span className={styles.modeLabel}>
                  <span className={styles.modeName}>{name}</span>
                  <span className={styles.modeDesc}>{desc}</span>
                </span>
              </label>
            ))}
          </div>
          {detection.mode === 'auto' && renderAutoDetectionFields(true)}
        </div>
      )}

      {hasSlots && (
        <div className={styles.defaultRow}>
          <label htmlFor="expr-default">{t('characterEditor.expressionEditor.defaultExpression')}</label>
          <select
            id="expr-default"
            className={styles.defaultSelect}
            value={config?.defaultExpression ?? ''}
            onChange={handleDefaultChange}
          >
            <option value="">{t('characterEditor.expressionEditor.none')}</option>
            {slots.map((s) => (
              <option key={s.label} value={s.label}>{s.label}</option>
            ))}
          </select>
          <span className={styles.count}>
            {t('characterEditor.expressionEditor.mappedCount', { count: slots.length })}
          </span>
        </div>
      )}

      <div className={styles.controls}>
        <button type="button" className={styles.controlBtn} onClick={() => zipRef.current?.click()}>
          <Upload size={14} /> {t('characterEditor.expressionEditor.importZip')}
        </button>
        <button type="button" className={styles.controlBtn} onClick={openGalleryPicker}>
          <ImageIcon size={14} /> {t('characterEditor.expressionEditor.addFromGallery')}
        </button>
        <button type="button" className={styles.controlBtn} onClick={() => uploadRef.current?.click()}>
          <Plus size={14} /> {t('characterEditor.expressionEditor.uploadImages')}
        </button>
        <button type="button" className={styles.controlBtn} onClick={handleConvertToGroups}>
          <Users size={14} /> {t('characterEditor.expressionEditor.multiCharacterMode')}
        </button>
        <input ref={zipRef} type="file" accept=".zip" hidden onChange={handleZipUpload} />
        <input ref={uploadRef} type="file" accept="image/*" multiple hidden onChange={handleDirectUpload} />
      </div>

      {uploading && <div className={styles.uploading}>{t('characterEditor.expressionEditor.uploading')}</div>}

      {!hasSlots && !uploading && (
        <div className={styles.empty}>
          <Ghost size={40} className={styles.emptyIcon} />
          <div className={styles.emptyTitle}>{t('characterEditor.expressionEditor.emptyTitle')}</div>
          <div className={styles.emptyHint}>{t('characterEditor.expressionEditor.emptyHintSingle')}</div>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.controlBtn} onClick={() => zipRef.current?.click()}>
              <Upload size={14} /> {t('characterEditor.expressionEditor.importZip')}
            </button>
            <button type="button" className={styles.controlBtn} onClick={() => uploadRef.current?.click()}>
              <Plus size={14} /> {t('characterEditor.expressionEditor.uploadImages')}
            </button>
          </div>
        </div>
      )}

      {hasSlots && (
        <div className={styles.grid}>
          {slots.map((slot) => (
            <ExpressionSlotCard
              key={slot.label}
              label={slot.label}
              imageId={slot.imageId}
              onDelete={handleDelete}
              onRename={handleRename}
              onPreview={setLightboxSrc}
            />
          ))}
          <div className={styles.addCard} onClick={() => uploadRef.current?.click()}>
            <Plus size={24} />
          </div>
        </div>
      )}

      {showGalleryPicker && renderGalleryPicker(confirmGalleryPick)}

      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  )
}
