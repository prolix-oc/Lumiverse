import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Plus, Upload, Image as ImageIcon, Ghost, Trash2, Users } from 'lucide-react'
import { expressionsApi } from '@/api/expressions'
import { characterGalleryApi } from '@/api/character-gallery'
import { imagesApi } from '@/api/images'
import { settingsApi } from '@/api/settings'
import { useStore } from '@/store'
import ExpressionSlotCard from './ExpressionSlotCard'
import ImageLightbox from '@/components/shared/ImageLightbox'
import { Toggle } from '@/components/shared/Toggle'
import type { ExpressionConfig, ExpressionSlot, ExpressionGroups } from '@/types/expressions'
import type { CharacterGalleryItem } from '@/types/api'
import styles from './ExpressionEditorTab.module.css'
import editorStyles from './CharacterEditorPage.module.css'

type DetectionMode = 'auto' | 'council' | 'off'

interface DetectionSettings {
  mode: DetectionMode
  contextWindow: number
}

const DETECTION_DEFAULTS: DetectionSettings = { mode: 'auto', contextWindow: 5 }

interface Props {
  characterId: string
}

export default function ExpressionEditorTab({ characterId }: Props) {
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
  const [sidecarName, setSidecarName] = useState<string | null>(null)
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

  // Load detection settings and sidecar connection name (global, not per-character)
  useEffect(() => {
    settingsApi.get('expressionDetection')
      .then((row) => {
        if (row?.value) setDetection({ ...DETECTION_DEFAULTS, ...(row.value as Partial<DetectionSettings>) })
      })
      .catch(() => {})
    // Fetch sidecar config to display the connection name
    // Try dedicated sidecarSettings first, fall back to legacy council sidecar
    const resolveSidecarName = (profileId: string, model?: string) => {
      const profile = useStore.getState().profiles.find((p) => p.id === profileId)
      const modelName = model || profile?.model || ''
      const label = profile ? `${profile.name} (${profile.provider})` : 'Configured'
      setSidecarName(modelName ? `${label} — ${modelName}` : label)
    }
    settingsApi.get('sidecarSettings')
      .then((row) => {
        const profileId = (row?.value as any)?.connectionProfileId
        if (profileId) {
          resolveSidecarName(profileId, (row?.value as any)?.model)
        } else {
          // Fall back to legacy council sidecar config
          return settingsApi.get('council_settings').then((cs) => {
            const legacy = (cs?.value as any)?.toolsSettings?.sidecar
            if (legacy?.connectionProfileId) resolveSidecarName(legacy.connectionProfileId, legacy.model)
          })
        }
      })
      .catch(() => {
        // sidecarSettings key doesn't exist — try legacy
        settingsApi.get('council_settings')
          .then((cs) => {
            const legacy = (cs?.value as any)?.toolsSettings?.sidecar
            if (legacy?.connectionProfileId) resolveSidecarName(legacy.connectionProfileId, legacy.model)
          })
          .catch(() => {})
      })
  }, [])

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
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''
      const baseName = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_\- ]/g, '').trim()
      const label = baseName || 'expression'
      setUploading(true)
      try {
        const image = await imagesApi.upload(file)
        if (!config) return
        const updated: ExpressionConfig = {
          ...config,
          enabled: true,
          mappings: { ...config.mappings, [label]: image.id },
          defaultExpression: config.defaultExpression || label,
        }
        saveConfig(updated)
      } catch {
        // silent
      } finally {
        setUploading(false)
      }
    },
    [characterId, config, saveConfig]
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
      const file = e.target.files?.[0]
      if (!file || !activeGroup) return
      e.target.value = ''
      const baseName = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_\- ]/g, '').trim()
      const label = baseName || 'expression'
      setUploading(true)
      try {
        const image = await imagesApi.upload(file)
        const updated = await expressionsApi.addGroupLabel(characterId, activeGroup, label, image.id)
        setGroups(updated)
      } catch { /* silent */ }
      finally { setUploading(false) }
    },
    [characterId, activeGroup]
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
          <span className={editorStyles.fieldLabel}>Expression Sprites — Multi-Character</span>
          <span className={editorStyles.fieldHelper}>
            This card contains expressions for {groupNames.filter((n) => n !== '_default').length} characters
            ({totalExpressions} total). The active character is detected automatically from conversation context.
          </span>
        </div>

        {/* Detection settings — shared with single-character mode */}
        <div className={styles.detectionSection}>
          <div className={styles.detectionHeader}>Expression Detection</div>
          <div className={styles.detectionHint}>
            After each message, the system identifies which character is speaking and selects their expression.
          </div>
          <div className={styles.detectionModes}>
            {([
              ['auto', 'Automatic', 'A sidecar LLM call identifies the active character and their expression after each generation.'],
              ['off', 'Off', 'No automatic detection. Expressions only change via <img=""> tags in the response.'],
            ] as const).map(([mode, name, desc]) => (
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
          {detection.mode === 'auto' && sidecarName && (
            <div className={styles.contextRow}>
              <label>Sidecar LLM:</label>
              <span className={styles.modeDesc}>{sidecarName}</span>
            </div>
          )}
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
              {name === '_default' ? 'Default' : name}
              <span className={styles.groupTabCount}>{Object.keys(groups[name]).length}</span>
            </button>
          ))}
          <button
            type="button"
            className={styles.groupTab}
            onClick={() => setShowAddGroup(true)}
            title="Add character"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Add character group form */}
        {showAddGroup && (
          <div className={styles.labelPrompt}>
            <span className={editorStyles.fieldHelper}>Enter a character name for the new expression group:</span>
            <input
              type="text"
              className={styles.labelPromptInput}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="e.g. Alice, Bob..."
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddGroup() }}
            />
            <div className={styles.labelPromptActions}>
              <button type="button" className={styles.labelPromptBtn} onClick={() => { setShowAddGroup(false); setNewGroupName('') }}>
                Cancel
              </button>
              <button type="button" className={styles.labelPromptBtnPrimary} onClick={handleAddGroup} disabled={!newGroupName.trim()}>
                Add Character
              </button>
            </div>
          </div>
        )}

        {/* Active group content */}
        {activeGroup && groups[activeGroup] && (
          <>
            <div className={styles.groupHeader}>
              <span className={styles.count}>{activeGroupSlots.length} expressions</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {groupNames.length === 1 && (
                  <button type="button" className={styles.groupDeleteBtn} onClick={handleConvertToFlat}>
                    Switch to Single-Character
                  </button>
                )}
                <button type="button" className={styles.groupDeleteBtn} onClick={() => handleDeleteGroup(activeGroup)}>
                  <Trash2 size={12} /> Remove group
                </button>
              </div>
            </div>

            <div className={styles.controls}>
              <button type="button" className={styles.controlBtn} onClick={() => groupZipRef.current?.click()}>
                <Upload size={14} /> Import ZIP
              </button>
              <button type="button" className={styles.controlBtn} onClick={openGalleryPicker}>
                <ImageIcon size={14} /> Add from Gallery
              </button>
              <button type="button" className={styles.controlBtn} onClick={() => groupUploadRef.current?.click()}>
                <Plus size={14} /> Upload Image
              </button>
              <input ref={groupZipRef} type="file" accept=".zip" hidden onChange={handleGroupZipUpload} />
              <input ref={groupUploadRef} type="file" accept="image/*" hidden onChange={handleGroupDirectUpload} />
            </div>

            {uploading && <div className={styles.uploading}>Uploading...</div>}

            {activeGroupSlots.length === 0 && !uploading && (
              <div className={styles.empty}>
                <Ghost size={40} className={styles.emptyIcon} />
                <div className={styles.emptyTitle}>No expressions yet</div>
                <div className={styles.emptyHint}>
                  Upload a ZIP of expression images, add from gallery, or upload one by one.
                </div>
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

        {/* Gallery picker overlay (shared) */}
        {showGalleryPicker && (
          <div>
            <span className={editorStyles.fieldLabel}>Select from Gallery</span>
            {galleryItems.length === 0 ? (
              <div className={styles.emptyHint} style={{ padding: '20px 0' }}>
                No gallery images found. Upload images to the Gallery tab first.
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
                        if (!pickerLabel) setPickerLabel(item.caption || 'expression')
                      }}
                    >
                      <img src={characterGalleryApi.smallUrl(item.image_id)} alt={item.caption || ''} className={styles.galleryPickImage} />
                    </div>
                  ))}
                </div>
                {pickerImageId && (
                  <div className={styles.labelPrompt}>
                    <span className={editorStyles.fieldHelper}>Enter an expression label for this image:</span>
                    <input
                      type="text"
                      className={styles.labelPromptInput}
                      value={pickerLabel}
                      onChange={(e) => setPickerLabel(e.target.value)}
                      placeholder="e.g. happy, sad, angry..."
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') handleGroupGalleryPick() }}
                    />
                    <div className={styles.labelPromptActions}>
                      <button type="button" className={styles.labelPromptBtn} onClick={() => { setShowGalleryPicker(false); setPickerImageId(null); setPickerLabel('') }}>
                        Cancel
                      </button>
                      <button type="button" className={styles.labelPromptBtnPrimary} onClick={handleGroupGalleryPick} disabled={!pickerLabel.trim()}>
                        Add Expression
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

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
        <span className={editorStyles.fieldLabel}>Expression Sprites</span>
        <span className={editorStyles.fieldHelper}>
          Map emotion labels to images for visual novel-style expression display during chat.
        </span>
      </div>

      <div className={styles.enableRow}>
        <Toggle.Checkbox
          checked={config?.enabled ?? false}
          onChange={handleToggleEnabled}
          label="Enable expression display"
        />
      </div>

      {hasSlots && (
        <div className={styles.detectionSection}>
          <div className={styles.detectionHeader}>Expression Detection</div>
          <div className={styles.detectionHint}>
            How should the character's expression be chosen after each message?
          </div>
          <div className={styles.detectionModes}>
            {([
              ['auto', 'Automatic', 'A lightweight sidecar LLM call runs after each generation to detect the expression. Works without Council mode.'],
              ['council', 'Council Tool Only', 'Expression detection runs as part of the Council deliberation. Requires Council mode enabled with the Expression Detector tool assigned to a member.'],
              ['off', 'Manual / Off', 'No automatic detection. Expressions only change via the Council tool (if assigned) or stay on the default.'],
            ] as const).map(([mode, name, desc]) => (
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
          {detection.mode === 'auto' && (
            <>
              <div className={styles.contextRow}>
                <label htmlFor="expr-context-window">Messages to analyze:</label>
                <input
                  id="expr-context-window"
                  type="number"
                  className={styles.contextInput}
                  value={detection.contextWindow}
                  min={1}
                  max={20}
                  onChange={(e) => {
                    const val = Math.max(1, Math.min(20, parseInt(e.target.value) || 5))
                    saveDetection({ ...detection, contextWindow: val })
                  }}
                />
              </div>
              <div className={styles.contextRow}>
                <label>Sidecar LLM:</label>
                <span className={styles.modeDesc}>
                  {sidecarName || 'Not configured — set up in the Council panel'}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {hasSlots && (
        <div className={styles.defaultRow}>
          <label htmlFor="expr-default">Default expression:</label>
          <select
            id="expr-default"
            className={styles.defaultSelect}
            value={config?.defaultExpression ?? ''}
            onChange={handleDefaultChange}
          >
            <option value="">None</option>
            {slots.map((s) => (
              <option key={s.label} value={s.label}>{s.label}</option>
            ))}
          </select>
          <span className={styles.count}>{slots.length} mapped</span>
        </div>
      )}

      <div className={styles.controls}>
        <button type="button" className={styles.controlBtn} onClick={() => zipRef.current?.click()}>
          <Upload size={14} /> Import ZIP
        </button>
        <button type="button" className={styles.controlBtn} onClick={openGalleryPicker}>
          <ImageIcon size={14} /> Add from Gallery
        </button>
        <button type="button" className={styles.controlBtn} onClick={() => uploadRef.current?.click()}>
          <Plus size={14} /> Upload Image
        </button>
        <button type="button" className={styles.controlBtn} onClick={handleConvertToGroups}>
          <Users size={14} /> Multi-Character Mode
        </button>
        <input ref={zipRef} type="file" accept=".zip" hidden onChange={handleZipUpload} />
        <input ref={uploadRef} type="file" accept="image/*" hidden onChange={handleDirectUpload} />
      </div>

      {uploading && <div className={styles.uploading}>Uploading...</div>}

      {!hasSlots && !uploading && (
        <div className={styles.empty}>
          <Ghost size={40} className={styles.emptyIcon} />
          <div className={styles.emptyTitle}>No expressions yet</div>
          <div className={styles.emptyHint}>
            Upload a ZIP of expression images (filenames become labels),<br />
            add images from the gallery, or upload them one by one.
          </div>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.controlBtn} onClick={() => zipRef.current?.click()}>
              <Upload size={14} /> Import ZIP
            </button>
            <button type="button" className={styles.controlBtn} onClick={() => uploadRef.current?.click()}>
              <Plus size={14} /> Upload Image
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

      {/* Gallery picker overlay */}
      {showGalleryPicker && (
        <div>
          <span className={editorStyles.fieldLabel}>Select from Gallery</span>
          {galleryItems.length === 0 ? (
            <div className={styles.emptyHint} style={{ padding: '20px 0' }}>
              No gallery images found. Upload images to the Gallery tab first.
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
                      if (!pickerLabel) {
                        setPickerLabel(item.caption || 'expression')
                      }
                    }}
                  >
                    <img
                      src={characterGalleryApi.smallUrl(item.image_id)}
                      alt={item.caption || ''}
                      className={styles.galleryPickImage}
                    />
                  </div>
                ))}
              </div>
              {pickerImageId && (
                <div className={styles.labelPrompt}>
                  <span className={editorStyles.fieldHelper}>Enter an expression label for this image:</span>
                  <input
                    type="text"
                    className={styles.labelPromptInput}
                    value={pickerLabel}
                    onChange={(e) => setPickerLabel(e.target.value)}
                    placeholder="e.g. happy, sad, angry..."
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmGalleryPick() }}
                  />
                  <div className={styles.labelPromptActions}>
                    <button
                      type="button"
                      className={styles.labelPromptBtn}
                      onClick={() => { setShowGalleryPicker(false); setPickerImageId(null); setPickerLabel('') }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.labelPromptBtnPrimary}
                      onClick={confirmGalleryPick}
                      disabled={!pickerLabel.trim()}
                    >
                      Add Expression
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  )
}
