import { useStore } from '@/store'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Toggle } from '@/components/shared/Toggle'
import { persistKey } from '@/store/slices/settings'
import { DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS, DEFAULT_QUICK_TOOLBAR_BACKDROP_COLOR, PRODUCTIVITY_DEFAULTS, isMobileViewportOrDevice } from '@/lib/uiProductivityDefaults'
import { ChevronDown, ChevronUp, GripVertical, Plus, Search, Trash2 } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { DESIGN_DEFAULT_IDS, useQuickToolbarActions } from '@/components/quick-toolbar/useQuickToolbarActions'
import { isAutoFitToolbarBounds, isFillTopDockWidth, isOpaqueToolbarBackdrop, isShowNativeSelectMessages, isV2IconOnly, readQuickToolbarPlacement } from '@/components/quick-toolbar/quickToolbarDock'
import { keepDockEnabledWhenFloating } from '@/lib/uiProductivityDefaults'
import { canMoveWithinFiltered, filterActionIds, moveWithinFiltered } from '@/lib/toolbarActionSearch'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import { connectionsApi } from '@/api/connections'
import { getConnectionProfileTagIds } from '@/lib/connectionsPicker'
import { useTokenizerAvailability } from '@/hooks/useTokenCounts'
import { ENTRY_METADATA_VERSION } from '@/lib/lorebookEntryColumns'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { getHomepageCardMetadata, getHomepageVisibleTags } from '@/lib/characterDisplaySettings'
import { readDeviceLandingPageStartTab, writeDeviceLandingPageStartTab } from '@/lib/landingPageStartTab'
import type { Character } from '@/types/api'
import ProductivityFeatureToggles from './ProductivityFeatureToggles'
import styles from './ProductivitySettings.module.css'
import { bindProductivitySetting, normalizeColor, parseProductivityNumber, reorderItems, type ProductivitySettingKey } from './ProductivitySettingsModel'

type Blob = Record<string, any>

const labels: Record<ProductivitySettingKey, string> = {
  quickToolbarSettings: 'Quick Toolbar',
  connectionsPickerSettings: 'Connections Picker',
  loreIndicatorSettings: 'Lore Indicator',
  homepageCharacterLibrarySettings: 'Homepage Character Library',
  characterTabDisplaySettings: 'Character Tab Display',
  portraitDockSettings: 'Portrait Dock',
  lorebookEditorSettings: 'Lorebook Editor',
}

function settingId(key: string, field: string): string {
  return `productivity-${key}-${field}`
}

function Field({ label, id, children, hint, className }: { label: string; id: string; children: ReactNode; hint?: string; className?: string }) {
  return <div className={className ? `${styles.field} ${className}` : styles.field}><label htmlFor={id}>{label}</label>{children}{hint && <small>{hint}</small>}</div>
}

function SelectField({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return <Field id={id} label={label}><select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></Field>
}
const LORE_METADATA_OPTIONS = ['book', 'type', 'tokens', 'trigger', 'score', 'position', 'depth', 'priority']
const LOREBOOK_ENTRY_METADATA_OPTIONS = ['type', 'priority', 'position', 'depth', 'order', 'keys', 'enabled', 'tokens']
const CHARACTER_METADATA_OPTIONS = ['creator', 'tags', 'description', 'lorebooks', 'lastChat']
const LORE_V4_ITEM_LABELS: Record<string, string> = { 'active-count': 'Active-entry count', 'token-estimate': 'Token estimate', passes: 'Recursion passes', constant: 'Constant count', keyword: 'Keyword count', vector: 'Vector count', 'lorebook-names': 'Lorebook names', search: 'Search control', grouping: 'Grouping control' }

function PreciseValueInput({ id, label, value, onChange, min, max, step, suffix, descriptionId, disabled = false }: { id: string; label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string; descriptionId?: string; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const safeValue = Number.isFinite(value) ? value : 0
  const [draft, setDraft] = useState(String(safeValue))
  useEffect(() => {
    if (inputRef.current?.ownerDocument.activeElement === inputRef.current) return
    setDraft(String(safeValue))
  }, [safeValue])

  const commit = () => {
    const next = parseProductivityNumber(draft, { fallback: safeValue, min, max, step })
    setDraft(String(next))
    if (next !== safeValue) onChange(next)
  }

  return <span className={styles.preciseValue}><input ref={inputRef} id={`${id}-value`} type="number" inputMode="decimal" value={draft} min={min} max={max} step={step} disabled={disabled} aria-label={`${label} exact value`} aria-describedby={descriptionId} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(String(safeValue))
      event.currentTarget.blur()
    }
  }} /><span aria-hidden="true">{suffix}</span></span>
}

function NumberField({ id, label, value, onChange, min = 0, max, suffix, disabled = false, className }: { id: string; label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; suffix?: string; disabled?: boolean; className?: string }) {
  const safeValue = Number.isFinite(value) ? value : 0
  return <Field id={id} label={label} className={className}><div className={styles.rangeControl}><input id={id} type="range" value={safeValue} min={min} max={max} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /><PreciseValueInput id={id} label={label} value={safeValue} onChange={onChange} min={min} max={max} step={1} suffix={suffix} disabled={disabled} /></div></Field>
}

function TextField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <Field id={id} label={label}><input id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value)} /></Field>
}

function CsvField({ id, label, value, onChange }: { id: string; label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <TextField id={id} label={label} value={(value ?? []).join(', ')} onChange={(next) => onChange(next.split(',').map((item) => item.trim()).filter(Boolean))} />
}

function RangeField({ id, label, value, onChange, min = 0, max = 1, step = 0.01, disabled = false, format, suffix, descriptionId, className }: { id: string; label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; disabled?: boolean; format?: (value: number) => string; suffix?: string; descriptionId?: string; className?: string }) {
  const safeValue = Number.isFinite(value) ? value : min
  const inferredSuffix = suffix ?? (format ? format(safeValue).slice(String(safeValue).length).trim() : undefined)
  return <Field id={id} label={label} className={className}><div className={styles.rangeControl}><input id={id} type="range" value={safeValue} min={min} max={max} step={step} disabled={disabled} aria-describedby={descriptionId} onChange={(event) => onChange(Number(event.target.value))} /><PreciseValueInput id={id} label={label} value={safeValue} onChange={onChange} min={min} max={max} step={step} suffix={inferredSuffix} descriptionId={descriptionId} disabled={disabled} /></div></Field>
}

function SegmentedField({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className={styles.segmentedField}><span>{label}</span><div className={styles.segmented} role="group" aria-label={label}>{options.map(([id, optionLabel]) => <button key={id} type="button" className={value === id ? styles.segmentedActive : undefined} aria-pressed={value === id} disabled={disabled} onClick={() => onChange(id)}>{optionLabel}</button>)}</div></div>
}

function CheckField({ id, label, checked, onChange, hint, disabled = false, className }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string; disabled?: boolean; className?: string }) {
  return <div className={className ? `${styles.checkField} ${className}` : styles.checkField}><label htmlFor={id}><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={label} /><span>{label}</span></label>{hint && <small>{hint}</small>}</div>
}

function MetadataChecklist({ label, options, value, onChange, disabled = false }: { label: string; options: readonly string[]; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  return <fieldset className={styles.metadataGrid} disabled={disabled}><legend>{label}</legend>{options.map((option) => <label key={option}><input type="checkbox" aria-label={option} checked={value.includes(option)} onChange={(event) => onChange(event.target.checked ? [...value, option] : value.filter((item) => item !== option))} />{option}</label>)}</fieldset>
}

function CharacterDisplayControls({ settings, onChange, disabled = false, compactFooterLabel = 'Compact', idPrefix, characterTabLayout = false }: { settings: Blob; onChange: (patch: Blob) => void; disabled?: boolean; compactFooterLabel?: string; idPrefix: string; characterTabLayout?: boolean }) {
  const thumbnails = <><NumberField id={`${idPrefix}-thumbnail-width`} label="Thumbnail width" value={settings.thumbnailWidth} onChange={(thumbnailWidth) => onChange({ thumbnailWidth })} min={100} max={360} suffix="px" disabled={disabled} /><NumberField id={`${idPrefix}-thumbnail-height`} label="Thumbnail height" value={settings.thumbnailHeight} onChange={(thumbnailHeight) => onChange({ thumbnailHeight })} min={120} max={520} suffix="px" disabled={disabled} /></>
  const controls = <><NumberField id={`${idPrefix}-tag-rows`} label="Tag rows" value={settings.tagRows} onChange={(tagRows) => onChange({ tagRows })} min={0} max={5} disabled={disabled} className={characterTabLayout ? styles.characterTagRows : undefined} /><SegmentedField label="Density" value={settings.density} disabled={disabled} options={[['compact', 'Compact'], ['balanced', 'Balanced'], ['large', 'Large'], ['custom', 'Custom']]} onChange={(density) => onChange({ density })} /><SegmentedField label="Footer mode" value={settings.footerMode} disabled={disabled} options={[['compact', compactFooterLabel], ['balanced', 'Balanced'], ['spacious', 'Spacious']]} onChange={(footerMode) => onChange({ footerMode })} /><SegmentedField label="View mode" value={settings.viewMode} disabled={disabled} options={[['grid', 'Grid'], ['single', 'Single'], ['list', 'List']]} onChange={(viewMode) => onChange({ viewMode })} /><SegmentedField label="Default sort" value={settings.defaultSort} disabled={disabled} options={[['recent', 'Recent'], ['most_chats', 'Most chats'], ['name', 'Name'], ['created', 'Created'], ['shuffle', 'Shuffle']]} onChange={(defaultSort) => onChange({ defaultSort })} /><SegmentedField label="Default filter" value={settings.defaultFilter} disabled={disabled} options={[['characters', 'Characters'], ['favorites', 'Favorites'], ['groups', 'Groups']]} onChange={(defaultFilter) => onChange({ defaultFilter })} /><MetadataChecklist label="Visible metadata" options={CHARACTER_METADATA_OPTIONS} value={settings.visibleMetadata ?? []} disabled={disabled} onChange={(visibleMetadata) => onChange({ visibleMetadata })} /></>

  return characterTabLayout ? <div className={styles.characterTabControls} data-productivity-layout="character-tab-controls"><div className={styles.characterThumbnailPair} data-productivity-layout="character-thumbnail-pair">{thumbnails}</div>{controls}</div> : <>{thumbnails}{controls}</>
}

function HomepageCharacterLibraryPreview({ settings, character }: { settings: Blob; character?: Character }) {
  const thumbnailWidth = Number(settings.thumbnailWidth) || DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS.thumbnailWidth
  const thumbnailHeight = Number(settings.thumbnailHeight) || DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS.thumbnailHeight
  const tagRows = Number(settings.tagRows) || 0
  const maxVisibleTags = Number(settings.maxVisibleTags) || DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS.maxVisibleTags
  const cardScale = Math.min(1, 190 / thumbnailWidth, 250 / thumbnailHeight)
  const previewWidth = Math.max(96, Math.round(thumbnailWidth * cardScale))
  const previewHeight = Math.max(120, Math.round(thumbnailHeight * cardScale))
  const panelWidth = Math.max(112, Math.min(210, Math.round((Number(settings.panelWidth) || DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS.panelWidth) * 0.42)))
  const panelImageHeight = Math.max(74, Math.min(150, Math.round((Number(settings.panelImageHeight) || DEFAULT_HOMEPAGE_CHARACTER_LIBRARY_SETTINGS.panelImageHeight) * 0.32)))
  const tagRowsMaxHeight = tagRows > 0 ? tagRows * 18 + Math.max(tagRows - 1, 0) * 3 : 0
  const compactFooterMaxHeight = 38 + tagRowsMaxHeight
  const metadata = character ? getHomepageCardMetadata(character) : { creator: 'Character creator', tags: ['Mystic', 'Strategist', 'Empath'] }
  const { visibleTags, hiddenTagCount } = getHomepageVisibleTags(metadata.tags, maxVisibleTags, tagRows)
  const avatarUrl = character ? getCharacterAvatarLargeUrlById(character.id, character.image_id) : null
  const previewStyle = {
    '--homepage-preview-card-width': `${previewWidth}px`,
    '--homepage-preview-image-height': `${previewHeight}px`,
    '--homepage-preview-panel-width': `${panelWidth}px`,
    '--homepage-preview-panel-image-height': `${panelImageHeight}px`,
    '--homepage-preview-tag-lines': tagRows,
    '--homepage-preview-tags-max-height': `${tagRowsMaxHeight}px`,
    '--homepage-preview-footer-max-height': `${compactFooterMaxHeight}px`,
  } as CSSProperties

  return <div className={styles.homepageLivePreview} aria-label="Homepage character card live preview">
    <div className={styles.homepagePreviewLabel}><span>Live preview</span><span>{thumbnailWidth} x {thumbnailHeight}px</span></div>
    <div className={styles.homepagePreviewCanvas} style={previewStyle}>
      <div className={styles.homepagePreviewGrid} data-density={settings.density}>
        <div className={styles.homepagePreviewCard} data-footer-mode={settings.footerMode} data-name-background={Boolean(settings.showNameBackground)}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <div className={styles.homepagePreviewPlaceholder}>C</div>}
          <div className={styles.homepagePreviewFooter}>
            <strong>{character?.name || 'Character name'}</strong>
            {settings.visibleMetadata?.includes('creator') && metadata.creator && <span>{metadata.creator}</span>}
            {settings.visibleMetadata?.includes('tags') && tagRows > 0 && visibleTags.length > 0 && <div className={styles.homepagePreviewTags}>{visibleTags.map((tag) => <span key={tag}>{tag}</span>)}{hiddenTagCount > 0 && <span>+{hiddenTagCount}</span>}</div>}
          </div>
        </div>
      </div>
      <div className={styles.homepagePreviewPanel} data-pinned={Boolean(settings.panelPinned)}>
        {avatarUrl ? <img className={styles.homepagePreviewPanelImage} src={avatarUrl} alt="" style={{ '--homepage-preview-image-url': `url("${avatarUrl}")` } as CSSProperties} /> : <div className={styles.homepagePreviewPanelImage} />}
        <strong>{character?.name || 'Character name'}</strong>
        <span>{settings.panelPinned ? 'Pinned preview' : 'Unpinned preview'}</span>
      </div>
    </div>
  </div>
}

function ReorderList({ label, items, getLabel, onChange }: { label: string; items: any[]; getLabel: (item: any) => string; onChange: (items: any[]) => void }) {
  return <div className={styles.reorder}><h4>{label}</h4>{items.map((item, index) => <div className={styles.reorderRow} key={item.id ?? `${getLabel(item)}-${index}`}><span>{getLabel(item)}</span><button type="button" disabled={index === 0} onClick={() => onChange(reorderItems(items, index, index - 1))} aria-label={`Move ${getLabel(item)} up`}>↑</button><button type="button" disabled={index === items.length - 1} onClick={() => onChange(reorderItems(items, index, index + 1))} aria-label={`Move ${getLabel(item)} down`}>↓</button></div>)}</div>
}

function SortableActionRow({
  id,
  label,
  visible,
  onToggle,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  id: string
  label: string
  visible: boolean
  onToggle: (id: string) => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (id: string, direction: -1 | 1) => void
}) {
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id, disabled: !visible })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })

  return <div ref={setNodeRef} style={style} className={isDragging ? `${styles.reorderRow} ${styles.reorderRowDragging}` : styles.reorderRow}>
    <button type="button" className={styles.dragHandle} title={visible ? 'Drag to reorder' : 'Enable this icon to reorder it'} aria-label={`Drag ${label}`} disabled={!visible} {...attributes} {...listeners}><GripVertical size={16} /></button>
    <input type="checkbox" aria-label={label} checked={visible} onChange={() => onToggle(id)} />
    <span>{label}</span>
    <button type="button" disabled={!canMoveUp} onClick={() => onMove(id, -1)} aria-label={`Move ${label} up`}><ChevronUp size={14} /></button>
    <button type="button" disabled={!canMoveDown} onClick={() => onMove(id, 1)} aria-label={`Move ${label} down`}><ChevronDown size={14} /></button>
  </div>
}

function CardHeader({ id, title, description, action, cardId }: { id: string; title: string; description: string; action?: ReactNode; cardId: string }) {
  return <div className={styles.cardHeader}><div><h3 id={id}>{title}</h3><p>{description}</p></div><div className={styles.cardHeaderAction} data-spindle-mount="settings_card_actions" data-spindle-scope={`settings-card-actions:productivity:${cardId}`} {...(action ? { 'data-productivity-card-header-action': '' } : {})}>{action}</div></div>
}

export default function ProductivitySettings() {
  const store = useStore((state) => state)
  const [toolbarQuery, setToolbarQuery] = useState('')
  const userId = (store as { user?: { id?: string } | null }).user?.id ?? null
  const hasLumiverseSuite = ((store as { extensions?: unknown[] }).extensions ?? []).some((extension) => {
    const candidate = extension as { identifier?: unknown; enabled?: unknown; has_frontend?: unknown }
    return candidate.identifier === 'lumiverse_suite' && candidate.enabled === true && candidate.has_frontend === true
  })
  const [landingStartTab, setLandingStartTab] = useState(() => readDeviceLandingPageStartTab(userId))
  useEffect(() => {
    setLandingStartTab(readDeviceLandingPageStartTab(userId))
  }, [userId])
  const getBlob = (key: ProductivitySettingKey): Blob => (store as any)[key] ?? PRODUCTIVITY_DEFAULTS[key]
  const update = (key: ProductivitySettingKey, patch: Blob) => {
    const current = (useStore.getState() as any)[key] ?? PRODUCTIVITY_DEFAULTS[key]
    const next = bindProductivitySetting(current, patch)
    useStore.setState({ [key]: next } as any)
    persistKey(key, next, 'user-interaction')
  }
  const renderColor = (key: ProductivitySettingKey, field: string, label: string, fallback: string) => {
    const id = settingId(key, field)
    const parts = field.split('.')
    let current: any = getBlob(key)
    for (const part of parts) current = current?.[part]
    const value = normalizeColor(current ?? fallback, fallback)
    const onChange = (color: string) => {
      if (parts.length === 3) {
        const [parent, child, leaf] = parts
        const parentValue = getBlob(key)[parent] ?? {}
        update(key, { [parent]: { ...parentValue, [child]: { ...parentValue[child], [leaf]: color } } })
      } else update(key, { [field]: color })
    }
    return <Field id={id} label={label}><input id={id} type="color" value={value} onChange={(event) => onChange(normalizeColor(event.target.value, fallback))} aria-label={label} /></Field>
  }

  const quick = getBlob('quickToolbarSettings')
  const connections = getBlob('connectionsPickerSettings')
  const lore = getBlob('loreIndicatorSettings')
  const homepage = getBlob('homepageCharacterLibrarySettings')
  const character = getBlob('characterTabDisplaySettings')
  const portrait = getBlob('portraitDockSettings')
  const lorebook = getBlob('lorebookEditorSettings')
  const halfEditorMode = lorebook.halfEditorMode ?? PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.halfEditorMode
  const fullEditorLaunchMode = lorebook.fullEditorLaunchMode ?? PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.fullEditorLaunchMode
  const tokenCountMode = lorebook.tokenCountMode ?? PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.tokenCountMode
  const tokenizerAvailability = useTokenizerAvailability()
  const characters = useStore((state) => state.characters) ?? []
  const profiles = useStore((state) => state.profiles)
  const updateProfile = useStore((state) => state.updateProfile)
  const { actionById, visibleIds, orderedIds, reorderActions, toggleAction } = useQuickToolbarActions()
  const toolbarIds = useMemo(() => {
    const ids: string[] = []
    for (const id of [...orderedIds, ...(quick.iconOrder ?? []), ...(quick.visibleTabIds ?? []), ...DESIGN_DEFAULT_IDS]) {
      if (!ids.includes(id) && actionById.has(id)) ids.push(id)
    }
    return ids
  }, [actionById, orderedIds, quick.iconOrder, quick.visibleTabIds])
  const filteredToolbarIds = useMemo(() => filterActionIds(toolbarIds, actionById, toolbarQuery), [actionById, toolbarIds, toolbarQuery])
  const filteredVisibleIds = useMemo(() => filterActionIds(orderedIds, actionById, toolbarQuery), [actionById, orderedIds, toolbarQuery])
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const moveToolbar = (id: string, direction: -1 | 1) => {
    const next = moveWithinFiltered(orderedIds, filteredVisibleIds, id, direction)
    if (next !== orderedIds) reorderActions(next)
  }
  const handleToolbarDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = orderedIds.indexOf(String(active.id))
    const to = orderedIds.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    reorderActions(arrayMove(orderedIds, from, to))
  }
  const removeTag = (id: string) => {
    update('connectionsPickerSettings', {
      profileTags: connections.profileTags.filter((tag: Blob) => tag.id !== id),
      visibleTagIds: connections.visibleTagIds.filter((tagId: string) => tagId !== id),
    })
    profiles.forEach((profile) => {
      const tagIds = getConnectionProfileTagIds(profile)
      if (!tagIds.includes(id)) return
      const metadata = { ...profile.metadata, tagIds: tagIds.filter((tagId) => tagId !== id) }
      updateProfile(profile.id, { metadata })
      void connectionsApi.update(profile.id, { metadata })
    })
  }
  const resetLoreVariant = () => {
    const defaults = PRODUCTIVITY_DEFAULTS.loreIndicatorSettings
    if (lore.variant === 'v2-compact') update('loreIndicatorSettings', { v2ActivationMode: defaults.v2ActivationMode, v2BookDisplay: defaults.v2BookDisplay, visibleMetadata: defaults.visibleMetadata, iconSize: defaults.iconSize, textSize: defaults.textSize })
    else if (lore.variant === 'v4-bottom-strip') update('loreIndicatorSettings', { v4Items: defaults.v4Items, v4Spacing: defaults.v4Spacing, v4GroupBy: defaults.v4GroupBy, v4BookPreviewCount: defaults.v4BookPreviewCount, iconSize: defaults.iconSize, textSize: defaults.textSize })
    else update('loreIndicatorSettings', { v5Keybind: defaults.v5Keybind, v5ShowShortcutHints: defaults.v5ShowShortcutHints, visibleMetadata: defaults.visibleMetadata })
  }
  const resetHomepageLayout = () => update('homepageCharacterLibrarySettings', {
    thumbnailWidth: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.thumbnailWidth,
    thumbnailHeight: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.thumbnailHeight,
    tagRows: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.tagRows,
    density: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.density,
    footerMode: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.footerMode,
    viewMode: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.viewMode,
    defaultSort: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.defaultSort,
    defaultFilter: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.defaultFilter,
    visibleMetadata: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.visibleMetadata,
    maxVisibleTags: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.maxVisibleTags,
    showNameBackground: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.showNameBackground,
    panelWidth: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.panelWidth,
    panelImageHeight: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.panelImageHeight,
    panelPinned: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.panelPinned,
    lastSelectedCharacterId: PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings.lastSelectedCharacterId,
  })
  const resetCharacterTabLayout = () => update('characterTabDisplaySettings', {
    thumbnailWidth: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.thumbnailWidth,
    thumbnailHeight: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.thumbnailHeight,
    tagRows: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.tagRows,
    density: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.density,
    footerMode: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.footerMode,
    viewMode: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.viewMode,
    defaultSort: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.defaultSort,
    defaultFilter: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.defaultFilter,
    visibleMetadata: PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings.visibleMetadata,
  })
  const resetPortraitLayout = () => update('portraitDockSettings', {
    rect: PRODUCTIVITY_DEFAULTS.portraitDockSettings.rect,
    pinned: PRODUCTIVITY_DEFAULTS.portraitDockSettings.pinned,
    aspectRatioLocked: PRODUCTIVITY_DEFAULTS.portraitDockSettings.aspectRatioLocked,
    dockSide: PRODUCTIVITY_DEFAULTS.portraitDockSettings.dockSide,
    open: PRODUCTIVITY_DEFAULTS.portraitDockSettings.open,
    lastPortrait: PRODUCTIVITY_DEFAULTS.portraitDockSettings.lastPortrait,
  })
  const resetLorebookLayout = () => update('lorebookEditorSettings', {
    halfEditorMode: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.halfEditorMode,
    halfRect: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.halfRect,
    minChatWidth: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.minChatWidth,
    minEditorPaneWidth: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.minEditorPaneWidth,
    booksPaneWidth: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.booksPaneWidth,
    entriesPaneWidth: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.entriesPaneWidth,
    inspectorPaneWidth: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.inspectorPaneWidth,
    rowDensity: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.rowDensity,
    visibleEntryMetadata: PRODUCTIVITY_DEFAULTS.lorebookEditorSettings.visibleEntryMetadata,
  })

  return <section className={styles.panel}>
    <ProductivityFeatureToggles />

    <section className={styles.card} aria-labelledby="productivity-quick-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:quick"><CardHeader id="productivity-quick-title" cardId="quick" title={labels.quickToolbarSettings} description="Choose a confirmed variant and persist its layout." action={<Toggle.Switch checked={quick.enabled !== false} onChange={(enabled) => update('quickToolbarSettings', { enabled })} aria-label="Enable Quick Toolbar" title="Enable Quick Toolbar" />} /><div className={styles.cardBody}>
      <div className={styles.quickToolbarControls} data-productivity-layout="quick-toolbar-controls">
        <SegmentedField label="Variant" value={quick.variant} options={[['v1-free', 'V1 Free'], ['v2-settings-adjacent', 'V2 Adjacent']]} onChange={(variant) => update('quickToolbarSettings', { variant })} />
        <SegmentedField label="Placement" value={readQuickToolbarPlacement(quick)} options={[['floating', 'Floating'], ['chat_top_dock', 'Chat top dock']]} onChange={(quickToolbarPlacement) => update('quickToolbarSettings', { quickToolbarPlacement })} />
        {readQuickToolbarPlacement(quick) === 'floating' && <CheckField className={styles.quickToolbarCheck} id="quick-keep-dock-enabled-when-floating" label="Keep chat top dock enabled while floating" checked={keepDockEnabledWhenFloating(quick)} onChange={(keepDockEnabledWhenFloating) => update('quickToolbarSettings', { hideInChatTopDock: !keepDockEnabledWhenFloating })} hint="Keep the original chat dock host available while the toolbar floats." />}
        <CheckField
          className={styles.quickToolbarCheck}
          id="quick-fill-top-dock-width"
          label={readQuickToolbarPlacement(quick) === 'chat_top_dock' ? 'Fill chat top bar width' : 'Fill the entire top of the screen'}
          checked={isFillTopDockWidth(quick)}
          onChange={(fillTopDockWidth) => update('quickToolbarSettings', { fillTopDockWidth })}
          hint={readQuickToolbarPlacement(quick) === 'chat_top_dock'
            ? 'Stretch across remaining chat top bar'
            : 'Stretch across window top'}
        />
        {readQuickToolbarPlacement(quick) === 'chat_top_dock' && (
          <CheckField className={styles.quickToolbarCheck} id="quick-show-native-select-messages" label="Show select-messages on chat top bar" checked={isShowNativeSelectMessages(quick)} onChange={(showNativeSelectMessages) => update('quickToolbarSettings', { showNativeSelectMessages })} hint="Keep the native ListChecks button on the chat top bar." />
        )}
        <CheckField className={styles.quickToolbarCheck} id="quick-opaque-toolbar-backdrop" label="Opaque toolbar backdrop" checked={isOpaqueToolbarBackdrop(quick)} onChange={(opaqueToolbarBackdrop) => update('quickToolbarSettings', { opaqueToolbarBackdrop })} hint="Paint a solid plate behind the Quick Toolbar so chat text does not show through." />
        <Field id="quick-toolbar-backdrop-color" label="Toolbar backdrop color"><input id="quick-toolbar-backdrop-color" type="color" value={normalizeColor(quick.backdropColor, DEFAULT_QUICK_TOOLBAR_BACKDROP_COLOR)} onChange={(event) => update('quickToolbarSettings', { backdropColor: normalizeColor(event.target.value, DEFAULT_QUICK_TOOLBAR_BACKDROP_COLOR) })} aria-label="Toolbar backdrop color" /></Field>
        <CheckField className={styles.quickToolbarCheck} id="quick-auto-fit-bounds" label="Auto-fit toolbar bounds to content" checked={isAutoFitToolbarBounds(quick)} onChange={(autoFitBounds) => update('quickToolbarSettings', { autoFitBounds })} />
        <div className={styles.quickToolbarSliderPair} data-productivity-layout="quick-toolbar-slider-pair">
          <NumberField id="quick-icon-size" label="Icon size" value={quick.variant === 'v2-settings-adjacent' ? quick.v2IconSize : quick.iconSize} onChange={(value) => update('quickToolbarSettings', quick.variant === 'v2-settings-adjacent' ? { v2IconSize: value } : { iconSize: value })} min={16} max={36} suffix="px" />
          <NumberField id="quick-label-size" label="Label size" value={quick.variant === 'v2-settings-adjacent' ? quick.v2LabelTextSize : quick.labelTextSize} onChange={(value) => update('quickToolbarSettings', quick.variant === 'v2-settings-adjacent' ? { v2LabelTextSize: value } : { labelTextSize: value })} min={9} max={18} suffix="px" />
        </div>
        <div className={styles.quickToolbarSliderPair} data-productivity-layout="quick-toolbar-slider-pair">
          <NumberField id="quick-card-width" label="Card width" value={quick.cardWidth ?? 0} onChange={(cardWidth) => update('quickToolbarSettings', { cardWidth })} min={0} max={360} suffix="px" />
          <NumberField id="quick-card-padding" label="Card padding" value={quick.cardPadding ?? 8} onChange={(cardPadding) => update('quickToolbarSettings', { cardPadding })} min={2} max={32} suffix="px" />
        </div>
        <div className={styles.quickToolbarSliderPair} data-productivity-layout="quick-toolbar-slider-pair">
          <NumberField id="quick-card-max-width" label="Card max width" value={quick.cardMaxWidth ?? 190} onChange={(cardMaxWidth) => update('quickToolbarSettings', { cardMaxWidth })} min={60} max={500} suffix="px" />
          <NumberField id="quick-card-gap" label="Card icon gap" value={quick.cardGap ?? 8} onChange={(cardGap) => update('quickToolbarSettings', { cardGap })} min={2} max={24} suffix="px" />
        </div>
        <div className={styles.quickToolbarSliderPair} data-productivity-layout="quick-toolbar-slider-pair">
          <RangeField id="quick-scale" label="Scale" value={Math.round(quick.scale * 100)} onChange={(scale) => update('quickToolbarSettings', { scale: scale / 100 })} min={60} max={160} step={1} disabled={quick.variant === 'v2-settings-adjacent'} descriptionId={quick.variant === 'v2-settings-adjacent' ? 'quick-scale-v2-hint' : undefined} format={(value) => `${value}%`} className={quick.variant === 'v2-settings-adjacent' ? styles.quickToolbarDisabledField : undefined} />
          <RangeField id="quick-opacity" label="Opacity" value={Math.round(quick.opacity * 100)} onChange={(opacity) => update('quickToolbarSettings', { opacity: opacity / 100 })} min={30} max={100} step={1} format={(value) => `${value}%`} />
        </div>
        {quick.variant === 'v2-settings-adjacent' && <small id="quick-scale-v2-hint" className={styles.quickToolbarPairHint}>V2 never scales - it is anchored in the chat dock. Use Icon size and Label size instead.</small>}
        {quick.variant === 'v2-settings-adjacent' ? <><SegmentedField label="Card density" value={quick.v2Density ?? 'comfortable'} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} onChange={(v2Density) => update('quickToolbarSettings', { v2Density })} /><CheckField className={styles.quickToolbarCheck} id="quick-labels" label="Show labels" checked={!isV2IconOnly(quick) && quick.v2LabelVisible !== false} onChange={(v2LabelVisible) => update('quickToolbarSettings', { v2LabelVisible })} /><CheckField className={styles.quickToolbarCheck} id="quick-v2-icon-only" label="Icon-only" checked={isV2IconOnly(quick)} onChange={(v2IconOnly) => update('quickToolbarSettings', { v2IconOnly, v2LabelVisible: v2IconOnly ? false : true })} /><CheckField className={styles.quickToolbarCheck} id="quick-v2-hide-when-overlaid" label="Hide when overlaid" checked={quick.hideWhenOverlaid ?? isMobileViewportOrDevice()} onChange={(hideWhenOverlaid) => update('quickToolbarSettings', { hideWhenOverlaid })} hint="When unset, this follows the mobile default." /><CheckField className={styles.quickToolbarCheck} id="quick-v2-modal-restore" label="Restore tab over full-screen dialogs" checked={quick.modalRestoreHandle === true} onChange={(modalRestoreHandle) => update('quickToolbarSettings', { modalRestoreHandle })} hint="The quick toolbar hides itself while a full-screen editor or dialog is open. Turn this on to leave a small tab at the screen edge that brings it back without closing the dialog." /></> : <><RangeField id="quick-rotation" label="Rotation" value={quick.rotationDeg} onChange={(rotationDeg) => update('quickToolbarSettings', { rotationDeg })} min={-180} max={180} step={1} format={(value) => `${value} degrees`} /><CheckField id="quick-labels" label="Show labels" checked={Boolean(quick.labelVisible)} onChange={(labelVisible) => update('quickToolbarSettings', { labelVisible })} /><CheckField id="quick-snap" label="Snap to edge" checked={Boolean(quick.snapToEdge)} onChange={(snapToEdge) => update('quickToolbarSettings', { snapToEdge })} /><CheckField id="quick-resize-handles" label="Show resize handles" checked={quick.resizeHandlesEnabled !== false} onChange={(resizeHandlesEnabled) => update('quickToolbarSettings', { resizeHandlesEnabled })} /><CheckField id="quick-vertical-orientation" label="Vertical orientation" checked={quick.orientation === 'vertical'} onChange={(vertical) => update('quickToolbarSettings', { orientation: vertical ? 'vertical' : 'horizontal' })} /><CheckField id="quick-hide-when-overlaid" label="Hide when overlaid" checked={quick.hideWhenOverlaid ?? isMobileViewportOrDevice()} onChange={(hideWhenOverlaid) => update('quickToolbarSettings', { hideWhenOverlaid })} hint="When unset, this follows the mobile default." /><CheckField id="quick-modal-restore" label="Restore tab over full-screen dialogs" checked={quick.modalRestoreHandle === true} onChange={(modalRestoreHandle) => update('quickToolbarSettings', { modalRestoreHandle })} hint="The quick toolbar hides itself while a full-screen editor or dialog is open. Turn this on to leave a small tab at the screen edge that brings it back without closing the dialog." /></>}
        <div className={styles.reorder}><h4>Visible icons and order</h4><label className={styles.searchField}><Search size={14} /><input value={toolbarQuery} onChange={(event) => setToolbarQuery(event.target.value)} placeholder="Search icons..." aria-label="Search icons" /></label><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleToolbarDragEnd}><SortableContext items={filteredVisibleIds} strategy={verticalListSortingStrategy}>{filteredToolbarIds.map((id) => { const action = actionById.get(id); if (!action) return null; const visible = visibleIds.includes(id); return <SortableActionRow key={id} id={id} label={action.label} visible={visible} onToggle={toggleAction} canMoveUp={canMoveWithinFiltered(orderedIds, filteredVisibleIds, id, -1)} canMoveDown={canMoveWithinFiltered(orderedIds, filteredVisibleIds, id, 1)} onMove={moveToolbar} /> })}</SortableContext></DndContext>{filteredToolbarIds.length === 0 && <div className={styles.cardMeta}>No icons match &ldquo;{toolbarQuery.trim()}&rdquo;.</div>}</div>
      </div>
      <button type="button" className={styles.resetButton} onClick={() => update('quickToolbarSettings', PRODUCTIVITY_DEFAULTS.quickToolbarSettings)}>Reset all toolbar settings</button>
    </div></section>

    <section className={styles.card} aria-labelledby="productivity-connections-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:connections"><CardHeader id="productivity-connections-title" cardId="connections" title={labels.connectionsPickerSettings} description="Configure launcher, layouts, model metadata, and profile tags." action={<Toggle.Switch checked={connections.enabled !== false} onChange={(enabled) => update('connectionsPickerSettings', { enabled })} aria-label="Enable Connections Picker" title="Enable Connections Picker" />} /><div className={styles.cardBody}>
      <SegmentedField label="Variant" value={connections.variant} options={[['provider-tags', 'A Tags'], ['split', 'B Split'], ['full', 'C Full']]} onChange={(variant) => update('connectionsPickerSettings', { variant })} />
      <RangeField id="connections-rect-width" label="Menu width" value={connections.rect?.width ?? 860} onChange={(width) => update('connectionsPickerSettings', { rect: { ...connections.rect, width } })} min={360} max={1600} step={1} format={(value) => `${value}px`} />
      <RangeField id="connections-rect-height" label="Menu height" value={connections.rect?.height ?? 300} onChange={(height) => update('connectionsPickerSettings', { rect: { ...connections.rect, height } })} min={220} max={940} step={1} format={(value) => `${value}px`} />
      <RangeField id="connections-rect-x" label="Menu X" value={connections.rect?.x ?? 0} onChange={(x) => update('connectionsPickerSettings', { rect: { ...connections.rect, x }, positionInitialized: true })} min={0} max={1600} step={1} format={(value) => `${value}px`} />
      <RangeField id="connections-rect-y" label="Menu Y" value={connections.rect?.y ?? 0} onChange={(y) => update('connectionsPickerSettings', { rect: { ...connections.rect, y }, positionInitialized: true })} min={0} max={1000} step={1} format={(value) => `${value}px`} />
      <RangeField id="connections-opacity" label="Menu opacity" value={Math.round(connections.opacity * 100)} onChange={(opacity) => update('connectionsPickerSettings', { opacity: opacity / 100 })} min={30} max={100} step={1} format={(value) => `${value}%`} />
      <NumberField id="connections-launcher-size" label="Launcher icon" value={connections.launcherIconSize} onChange={(launcherIconSize) => update('connectionsPickerSettings', { launcherIconSize })} min={14} max={32} suffix="px" />
      <NumberField id="connections-thumbnail-size" label="Thumbnail size" value={connections.thumbnailSize} onChange={(thumbnailSize) => update('connectionsPickerSettings', { thumbnailSize })} min={20} max={56} suffix="px" />
      <NumberField id="connections-section-spacing" label="Section spacing" value={connections.sectionSpacing} onChange={(sectionSpacing) => update('connectionsPickerSettings', { sectionSpacing })} min={4} max={28} suffix="px" />
      <NumberField id="connections-profile-column" label="Profile column" value={connections.columnWidths?.profiles ?? 180} onChange={(profiles) => update('connectionsPickerSettings', { columnWidths: { ...connections.columnWidths, profiles } })} min={140} max={420} suffix="px" />
      <NumberField id="connections-model-column" label="Model column" value={connections.columnWidths?.models ?? 220} onChange={(models) => update('connectionsPickerSettings', { columnWidths: { ...connections.columnWidths, models } })} min={180} max={520} suffix="px" />
      <SegmentedField label="Density" value={connections.density} options={[['compact', 'Compact'], ['balanced', 'Balanced'], ['spacious', 'Spacious'], ['custom', 'Custom']]} onChange={(density) => update('connectionsPickerSettings', { density })} />
      <SegmentedField label="Model layout" value={connections.modelLayout === 'list' ? 'list' : 'grid'} options={[['grid', 'Grid'], ['list', 'List']]} onChange={(modelLayout) => update('connectionsPickerSettings', { modelLayout })} />
      {connections.density === 'custom' && <><RangeField id="connections-row-padding" label="Row padding" value={connections.rowPadding} onChange={(rowPadding) => update('connectionsPickerSettings', { rowPadding })} min={4} max={20} step={1} /><RangeField id="connections-row-gap" label="Row gap" value={connections.rowGap} onChange={(rowGap) => update('connectionsPickerSettings', { rowGap })} min={2} max={20} step={1} /></>}
      <CheckField id="connections-launcher" label="Show chat launcher" checked={connections.launcherEnabled !== false} onChange={(launcherEnabled) => update('connectionsPickerSettings', { launcherEnabled })} />
      <CheckField id="connections-showFavorites" label="Show favorites" checked={Boolean(connections.showFavorites)} onChange={(value) => update('connectionsPickerSettings', { showFavorites: value })} />
      <CheckField id="connections-showRecent" label="Show recent" checked={Boolean(connections.showRecent)} onChange={(value) => update('connectionsPickerSettings', { showRecent: value })} />
      <CheckField id="connections-showSearch" label="Show search" checked={Boolean(connections.showSearch)} onChange={(value) => update('connectionsPickerSettings', { showSearch: value })} />
      <CheckField id="connections-showModelMetadata" label="Show model metadata" checked={Boolean(connections.showModelMetadata)} onChange={(value) => update('connectionsPickerSettings', { showModelMetadata: value })} />
      <div className={styles.tagList}>
        <div className={styles.listHeader}>
          <div><h4>Provider/profile tags</h4><small>Profiles can have multiple tags. Assign them in each connection form.</small></div>
          <button type="button" onClick={() => {
            const id = `tag-${Date.now()}`
            update('connectionsPickerSettings', {
              profileTags: [...(connections.profileTags ?? []), { id, name: 'New tag', color: '#64748B', order: (connections.profileTags ?? []).length }],
              visibleTagIds: [...new Set([...(connections.visibleTagIds ?? []), id])],
            })
          }}><Plus size={14} aria-hidden="true" /> Add tag</button>
        </div>
        {[...(connections.profileTags ?? [])].sort((left: any, right: any) => left.order - right.order).map((tag: any, index: number, tags: any[]) => {
          const visible = (connections.visibleTagIds ?? []).length === 0 || connections.visibleTagIds.includes(tag.id)
          const setTag = (patch: Blob) => update('connectionsPickerSettings', {
            profileTags: connections.profileTags.map((entry: any) => entry.id === tag.id ? { ...entry, ...patch } : entry),
          })
          return <div className={styles.tagRow} key={tag.id}>
            <input type="checkbox" aria-label={`Show tag ${tag.name}`} checked={visible} onChange={(event) => update('connectionsPickerSettings', {
              visibleTagIds: event.target.checked
                ? [...new Set([...(connections.visibleTagIds ?? []), tag.id])]
                : ((connections.visibleTagIds ?? []).length === 0
                  ? connections.profileTags.map((entry: any) => entry.id).filter((id: string) => id !== tag.id)
                  : connections.visibleTagIds.filter((id: string) => id !== tag.id)),
            })} />
            <input type="color" value={normalizeColor(tag.color)} aria-label={`Colour for ${tag.name}`} onChange={(event) => setTag({ color: normalizeColor(event.target.value) })} />
            <input value={tag.name} onChange={(event) => setTag({ name: event.target.value })} aria-label={`Name for ${tag.name}`} />
            <button type="button" disabled={index === 0} onClick={() => update('connectionsPickerSettings', { profileTags: reorderItems(tags, index, index - 1).map((entry: any, order) => ({ ...entry, order })) })} aria-label={`Move ${tag.name} up`}><ChevronUp size={14} /></button>
            <button type="button" disabled={index === tags.length - 1} onClick={() => update('connectionsPickerSettings', { profileTags: reorderItems(tags, index, index + 1).map((entry: any, order) => ({ ...entry, order })) })} aria-label={`Move ${tag.name} down`}><ChevronDown size={14} /></button>
            <button type="button" onClick={() => removeTag(tag.id)} aria-label={`Delete ${tag.name}`}><Trash2 size={14} /></button>
          </div>
        })}
      </div>
      <div className={styles.presetRow}>
        <button type="button" className={styles.resetButton} onClick={() => update('connectionsPickerSettings', { ...PRODUCTIVITY_DEFAULTS.connectionsPickerSettings, profileTags: connections.profileTags, visibleTagIds: connections.visibleTagIds })}>Reset current picker layout</button>
        <button type="button" className={styles.resetButton} onClick={() => update('connectionsPickerSettings', PRODUCTIVITY_DEFAULTS.connectionsPickerSettings)}>Reset all picker settings</button>
      </div>
    </div></section>

    <section className={styles.card} aria-labelledby="productivity-lore-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:lore"><CardHeader id="productivity-lore-title" cardId="lore" title={labels.loreIndicatorSettings} description="Configure compact, bottom-strip, and command-palette lore activity views." action={<Toggle.Switch checked={lore.enabled !== false} onChange={(enabled) => update('loreIndicatorSettings', { enabled })} aria-label="Enable Lore Indicator" title="Enable Lore Indicator" />} /><div className={styles.cardBody}>
      <SegmentedField label="Variant" value={lore.variant} options={[['v2-compact', 'V2 Compact'], ['v4-bottom-strip', 'V4 Strip'], ['v5-command-palette', 'V5 Palette']]} onChange={(variant) => update('loreIndicatorSettings', { variant })} />
      <SegmentedField label="Click launch target" value={lore.editorLaunchTarget ?? 'native'} options={[['native', 'Native drawer'], ['half', 'Half screen'], ['full', 'Full workspace']]} onChange={(editorLaunchTarget) => update('loreIndicatorSettings', { editorLaunchTarget })} />
      {lore.variant === 'v2-compact' && <><SegmentedField label="Activation" value={lore.v2ActivationMode} options={[['hover', 'Hover'], ['click', 'Click']]} onChange={(v2ActivationMode) => update('loreIndicatorSettings', { v2ActivationMode })} /><SegmentedField label="Book labels" value={lore.v2BookDisplay} options={[['grouped', 'Grouped'], ['first-only', 'First only'], ['markers', 'Markers']]} onChange={(v2BookDisplay) => update('loreIndicatorSettings', { v2BookDisplay })} /></>}
      {lore.variant === 'v4-bottom-strip' && <SegmentedField label="Group entries by" value={lore.v4GroupBy ?? 'lorebook'} options={[['lorebook', 'Lorebook'], ['type', 'Activation type'], ['none', 'No grouping']]} onChange={(v4GroupBy) => update('loreIndicatorSettings', { v4GroupBy })} />}
      {lore.variant === 'v5-command-palette' && <><div className={styles.inlineInputRow}><TextField id="lore-keybind" label="Keyboard shortcut" value={lore.v5Keybind} onChange={(v5Keybind) => update('loreIndicatorSettings', { v5Keybind })} /><button type="button" onClick={() => update('loreIndicatorSettings', { v5Keybind: '' })}>Clear</button></div><CheckField id="lore-shortcut-hints" label="Show keyboard hints" checked={lore.v5ShowShortcutHints !== false} onChange={(v5ShowShortcutHints) => update('loreIndicatorSettings', { v5ShowShortcutHints })} /></>}
      <NumberField id="lore-icon-size" label="Icon size" value={lore.iconSize} onChange={(iconSize) => update('loreIndicatorSettings', { iconSize })} min={12} max={32} />
      <NumberField id="lore-text-size" label="Text size" value={lore.textSize} onChange={(textSize) => update('loreIndicatorSettings', { textSize })} min={9} max={20} />
      <MetadataChecklist label="Visible metadata" options={LORE_METADATA_OPTIONS} value={lore.visibleMetadata} onChange={(visibleMetadata) => update('loreIndicatorSettings', { visibleMetadata })} />
      {lore.variant === 'v4-bottom-strip' && <><RangeField id="lore-spacing" label="Item spacing" value={lore.v4Spacing} onChange={(v4Spacing) => update('loreIndicatorSettings', { v4Spacing })} min={0} max={28} step={1} /><RangeField id="lore-preview-count" label="Entries per group" value={lore.v4BookPreviewCount ?? 4} onChange={(v4BookPreviewCount) => update('loreIndicatorSettings', { v4BookPreviewCount })} min={1} max={25} step={1} /></>}
      <div className={styles.colors}><h4>Entry type appearance</h4>{(['constant', 'keyword', 'vector'] as const).map((type) => <div className={styles.appearanceRow} key={type}>{renderColor('loreIndicatorSettings', `entryTypeAppearance.${type}.color`, type, lore.entryTypeAppearance?.[type]?.color ?? '#8B5CF6')}<TextField id={`lore-${type}-icon`} label={`${type} icon`} value={lore.entryTypeAppearance?.[type]?.icon ?? ''} onChange={(icon) => update('loreIndicatorSettings', { entryTypeAppearance: { ...lore.entryTypeAppearance, [type]: { ...lore.entryTypeAppearance?.[type], icon } } })} /></div>)}</div>
      {lore.variant === 'v4-bottom-strip' && <div className={styles.reorder}><h4>Bottom-strip items</h4>{[...(lore.v4Items ?? [])].sort((left: any, right: any) => left.order - right.order).map((item: any, index: number, items: any[]) => { const updateItem = (patch: Blob) => update('loreIndicatorSettings', { v4Items: lore.v4Items.map((entry: any) => entry.id === item.id ? { ...entry, ...patch } : entry) }); const label = LORE_V4_ITEM_LABELS[item.id] ?? item.id; return <div className={`${styles.loreStripRow}${item.removed ? ` ${styles.productivityRowMuted}` : ''}`} key={item.id}><input type="checkbox" aria-label={`Show ${label} in Activated Lore strip`} disabled={item.removed} checked={item.visible && !item.removed} onChange={(event) => updateItem({ visible: event.target.checked })} /><span>{label}</span><select aria-label={`Display ${label} in Activated Lore strip`} disabled={item.removed} value={item.mode} onChange={(event) => updateItem({ mode: event.target.value })}><option value="icon">Icon only</option><option value="iconText">Icon + text</option></select><button type="button" disabled={index === 0} onClick={() => update('loreIndicatorSettings', { v4Items: reorderItems(items, index, index - 1).map((entry: any, order) => ({ ...entry, order })) })} aria-label={`Move ${label} up`}><ChevronUp size={14} /></button><button type="button" disabled={index === items.length - 1} onClick={() => update('loreIndicatorSettings', { v4Items: reorderItems(items, index, index + 1).map((entry: any, order) => ({ ...entry, order })) })} aria-label={`Move ${label} down`}><ChevronDown size={14} /></button><button type="button" onClick={() => updateItem({ removed: !item.removed, visible: item.removed ? true : item.visible })} aria-label={`${item.removed ? 'Restore' : 'Remove'} ${label}`}>{item.removed ? <Plus size={14} /> : <Trash2 size={14} />}</button></div> })}</div>}
      <div className={styles.presetRow}><button type="button" className={styles.resetButton} onClick={resetLoreVariant}>Reset current variant</button><button type="button" className={styles.resetButton} onClick={() => update('loreIndicatorSettings', PRODUCTIVITY_DEFAULTS.loreIndicatorSettings)}>Reset all Lore Indicator settings</button></div>
    </div></section>

    <section id="homepage-character-library-settings" className={styles.card} aria-labelledby="productivity-home-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:homepage"><CardHeader id="productivity-home-title" cardId="homepage" title={labels.homepageCharacterLibrarySettings} description="Control homepage cards, filters, view defaults, and selected-character panel." action={<Toggle.Switch checked={homepage.enabled !== false} onChange={(enabled) => update('homepageCharacterLibrarySettings', { enabled })} aria-label="Enable homepage library" title="Enable homepage library" />} /><div className={styles.cardBody}>
      <HomepageCharacterLibraryPreview settings={homepage} character={characters.find((character) => character.id === homepage.lastSelectedCharacterId) ?? characters[0]} />
      {hasLumiverseSuite && homepage.enabled !== false && <SegmentedField label="Landing page start view" value={landingStartTab} options={[['characters', 'Characters'], ['chats', 'Chats']]} onChange={(value) => {
        if (value !== 'characters' && value !== 'chats') return
        setLandingStartTab(value)
        writeDeviceLandingPageStartTab(userId, value)
      }} />}
      <CharacterDisplayControls settings={homepage} onChange={(patch) => update('homepageCharacterLibrarySettings', patch)} compactFooterLabel="Compact glass" idPrefix="home" />
      <NumberField id="home-max-tags" label="Maximum visible tags" value={homepage.maxVisibleTags} onChange={(maxVisibleTags) => update('homepageCharacterLibrarySettings', { maxVisibleTags })} min={1} max={20} />
      <NumberField id="home-panel-width" label="Preview panel width" value={homepage.panelWidth} onChange={(panelWidth) => update('homepageCharacterLibrarySettings', { panelWidth })} min={360} max={720} suffix="px" />
      <NumberField id="home-image-height" label="Preview image height" value={homepage.panelImageHeight} onChange={(panelImageHeight) => update('homepageCharacterLibrarySettings', { panelImageHeight })} min={180} max={560} suffix="px" />
      <Field id="home-last-character" label="Last selected character"><select id="home-last-character" aria-label="Last selected character" value={homepage.lastSelectedCharacterId ?? ''} onChange={(event) => update('homepageCharacterLibrarySettings', { lastSelectedCharacterId: event.target.value || null })}><option value="">None</option>{characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></Field>
      <CheckField id="home-name-background" label="Show card-name background" checked={Boolean(homepage.showNameBackground)} onChange={(showNameBackground) => update('homepageCharacterLibrarySettings', { showNameBackground })} hint="Adds a dark backing behind names in compact glass mode." />
      <CheckField id="home-pinned" label="Pin selected-character panel" checked={Boolean(homepage.panelPinned)} onChange={(panelPinned) => update('homepageCharacterLibrarySettings', { panelPinned })} />
      <div className={styles.presetRow}><button type="button" className={styles.resetButton} onClick={resetHomepageLayout}>Reset homepage layout</button><button type="button" className={styles.resetButton} onClick={() => update('homepageCharacterLibrarySettings', PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings)}>Reset all homepage library settings</button></div>
    </div></section>

    <section className={styles.card} aria-labelledby="productivity-character-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:character"><CardHeader id="productivity-character-title" cardId="character" title={labels.characterTabDisplaySettings} description="Share homepage card preferences or keep independent drawer-tab overrides." action={<Toggle.Switch checked={character.useHomepageSettings !== false} onChange={(useHomepageSettings) => update('characterTabDisplaySettings', { useHomepageSettings })} aria-label="Use homepage character display settings" title="Use homepage character display settings" />} /><div className={styles.cardBody}>
      <CheckField className={styles.characterInheritance} id="character-home-settings" label="Use homepage character display settings" checked={character.useHomepageSettings !== false} onChange={(useHomepageSettings) => update('characterTabDisplaySettings', { useHomepageSettings })} />
      <div className={`${styles.characterControlsShell}${character.useHomepageSettings !== false ? ` ${styles.disabledSettingsGroup}` : ''}`}><CharacterDisplayControls settings={character} onChange={(patch) => update('characterTabDisplaySettings', patch)} disabled={character.useHomepageSettings !== false} idPrefix="character" characterTabLayout /></div>
      <div className={styles.presetRow}><button type="button" className={styles.resetButton} onClick={resetCharacterTabLayout}>Reset Character Tab layout</button><button type="button" className={styles.resetButton} onClick={() => update('characterTabDisplaySettings', PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings)}>Reset all Character Tab settings</button></div>
    </div></section>

    <section className={styles.card} aria-labelledby="productivity-portrait-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:portrait"><CardHeader id="productivity-portrait-title" cardId="portrait" title={labels.portraitDockSettings} description="Configure opening behavior, persistent layout, dock state, and hover controls." action={<Toggle.Switch checked={portrait.enabled !== false} onChange={(enabled) => update('portraitDockSettings', { enabled })} aria-label="Enable portrait dock" title="Enable portrait dock" />} /><div className={styles.cardBody}>
      <CheckField id="portrait-original" label="Open at original size" checked={Boolean(portrait.openAtOriginalSize)} onChange={(openAtOriginalSize) => update('portraitDockSettings', { openAtOriginalSize })} />
      <CheckField id="portrait-remember" label="Remember size and position" checked={Boolean(portrait.rememberSizePosition)} onChange={(rememberSizePosition) => update('portraitDockSettings', { rememberSizePosition })} />
      <SegmentedField label="Default dock side" value={portrait.defaultDockSide} options={[['left', 'Left'], ['right', 'Right']]} onChange={(defaultDockSide) => update('portraitDockSettings', { defaultDockSide })} />
      <SegmentedField label="Current dock side" value={portrait.dockSide} options={[['left', 'Left'], ['right', 'Right'], ['floating', 'Floating']]} onChange={(dockSide) => update('portraitDockSettings', { dockSide })} />
      <CheckField id="portrait-snap" label="Snap to edge" checked={Boolean(portrait.snapToEdge)} onChange={(snapToEdge) => update('portraitDockSettings', { snapToEdge })} />
      <CheckField id="portrait-hover" label="Hover controls" checked={Boolean(portrait.hoverControls)} onChange={(hoverControls) => update('portraitDockSettings', { hoverControls })} />
      <CheckField id="portrait-pinned" label="Pin portrait" checked={Boolean(portrait.pinned)} onChange={(pinned) => update('portraitDockSettings', { pinned })} />
      <CheckField id="portrait-aspect" label="Lock aspect ratio" checked={Boolean(portrait.aspectRatioLocked)} onChange={(aspectRatioLocked) => update('portraitDockSettings', { aspectRatioLocked })} />
      <NumberField id="portrait-hover-size" label="Hover control size" value={portrait.hoverControlSize} onChange={(hoverControlSize) => update('portraitDockSettings', { hoverControlSize })} min={16} max={64} />
      <NumberField id="portrait-min-width" label="Minimum width" value={portrait.minWidth} onChange={(minWidth) => update('portraitDockSettings', { minWidth })} min={100} max={1000} />
      <NumberField id="portrait-max-width" label="Maximum width" value={portrait.maxWidth} onChange={(maxWidth) => update('portraitDockSettings', { maxWidth })} min={200} max={1600} />
      <CheckField id="portrait-default-aspect" label="Lock aspect ratio by default" checked={Boolean(portrait.defaultAspectRatioLock)} onChange={(defaultAspectRatioLock) => update('portraitDockSettings', { defaultAspectRatioLock })} />
      <NumberField id="portrait-min-height" label="Minimum height" value={portrait.minHeight} onChange={(minHeight) => update('portraitDockSettings', { minHeight })} min={100} max={1200} />
      <NumberField id="portrait-max-height" label="Maximum height" value={portrait.maxHeight} onChange={(maxHeight) => update('portraitDockSettings', { maxHeight })} min={200} max={1600} />
      <NumberField id="portrait-width" label="Remembered width" value={portrait.rect?.width ?? 360} onChange={(width) => update('portraitDockSettings', { rect: { ...portrait.rect, width } })} min={100} max={1600} />
      <NumberField id="portrait-height" label="Remembered height" value={portrait.rect?.height ?? 520} onChange={(height) => update('portraitDockSettings', { rect: { ...portrait.rect, height } })} min={100} max={1600} />
      <NumberField id="portrait-x" label="Current X" value={portrait.rect?.x ?? 0} onChange={(x) => update('portraitDockSettings', { rect: { ...portrait.rect, x } })} min={0} max={1600} />
      <NumberField id="portrait-y" label="Current Y" value={portrait.rect?.y ?? 0} onChange={(y) => update('portraitDockSettings', { rect: { ...portrait.rect, y } })} min={0} max={1000} />
      <div className={styles.runtimeStateRow}><span>Last portrait: {portrait.lastPortrait?.displayName ?? 'No saved portrait'}</span><button type="button" disabled={!portrait.lastPortrait} onClick={() => update('portraitDockSettings', { lastPortrait: null })}>Clear saved portrait</button></div>
      <div className={styles.presetRow}><button type="button" className={styles.resetButton} onClick={resetPortraitLayout}>Reset current portrait layout</button><button type="button" className={styles.resetButton} onClick={() => update('portraitDockSettings', PRODUCTIVITY_DEFAULTS.portraitDockSettings)}>Reset all Portrait Dock settings</button></div>
    </div></section>

    <section className={styles.card} aria-labelledby="productivity-lorebook-title" data-spindle-mount="settings_section" data-spindle-scope="settings-section:productivity:lorebook"><CardHeader id="productivity-lorebook-title" cardId="lorebook" title={labels.lorebookEditorSettings} description="Configure full-page and half-screen launch behavior, pane sizes, and entry density." /><div className={`${styles.cardBody} ${styles.lorebookCardBody}`}>
      <div className={styles.lorebookFullWidth} data-lorebook-section="segments"><SegmentedField label="Default editor" value={lorebook.defaultVariant} options={[['full', 'A Full page'], ['half', 'B Half screen']]} onChange={(defaultVariant) => update('lorebookEditorSettings', { defaultVariant })} /><SegmentedField label="Trigger display" value={lorebook.triggerDisplay} options={[['words', 'Words'], ['icons', 'Icons']]} onChange={(triggerDisplay) => update('lorebookEditorSettings', { triggerDisplay })} /></div>
      <div className={styles.lorebookFullWidth} data-lorebook-section="full-launch"><SegmentedField label="Full editor launch" value={fullEditorLaunchMode} options={[['windowed', 'Windowed'], ['fullscreen', 'Full screen']]} onChange={(fullEditorLaunchMode) => update('lorebookEditorSettings', { fullEditorLaunchMode })} /><div className={styles.cardMeta}>Choose whether the Full-Screen Lorebook Editor Quick Toolbar action opens in its smaller desktop window or fills the viewport. Phones always use full screen.</div></div>
      <div className={styles.lorebookFullWidth} data-lorebook-section="features"><div className={styles.lorebookFeatureRow}><CheckField id="lorebook-half-button" label="Show half-screen editor button" checked={lorebook.halfButtonEnabled !== false} onChange={(halfButtonEnabled) => update('lorebookEditorSettings', { halfButtonEnabled })} /><CheckField id="lorebook-indicator-action" label="Show Lore Indicator editor action" checked={lorebook.loreIndicatorActionEnabled !== false} onChange={(loreIndicatorActionEnabled) => update('lorebookEditorSettings', { loreIndicatorActionEnabled })} /><CheckField id="lorebook-simultaneous" label="Allow simultaneous editors" checked={lorebook.allowSimultaneousEditors !== false} onChange={(allowSimultaneousEditors) => update('lorebookEditorSettings', { allowSimultaneousEditors })} /></div></div>
      <div className={styles.lorebookFullWidth} data-lorebook-section="half-layout"><SegmentedField label="Half-screen layout" value={halfEditorMode} options={[['docked', 'Docked'], ['floating', 'Floating']]} onChange={(halfEditorMode) => update('lorebookEditorSettings', { halfEditorMode })} /><div className={styles.cardMeta}>{halfEditorMode === 'floating' ? 'Free panel: drag it anywhere and resize it from any edge or corner. All four size and position values below apply.' : 'Docked to the right of the chat, full height. Only the width applies - the height and position values are for floating mode.'}</div></div>
      <div className={styles.lorebookPaneRows} data-lorebook-section="pane-sizes"><div className={styles.lorebookPaneRow}><NumberField id="lorebook-half-width" label="Half-screen width" value={lorebook.halfRect.width} onChange={(width) => update('lorebookEditorSettings', { halfRect: { ...lorebook.halfRect, width } })} min={420} max={1400} suffix="px" /><NumberField id="lorebook-books-pane" label="Books pane" value={lorebook.booksPaneWidth} onChange={(booksPaneWidth) => update('lorebookEditorSettings', { booksPaneWidth })} min={160} max={520} suffix="px" /></div><div className={styles.lorebookPaneRow}><NumberField id="lorebook-entries-pane" label="Entries pane" value={lorebook.entriesPaneWidth} onChange={(entriesPaneWidth) => update('lorebookEditorSettings', { entriesPaneWidth })} min={220} max={720} suffix="px" /><NumberField id="lorebook-inspector-pane" label="Inspector pane" value={lorebook.inspectorPaneWidth} onChange={(inspectorPaneWidth) => update('lorebookEditorSettings', { inspectorPaneWidth })} min={300} max={960} suffix="px" /></div><div className={styles.lorebookPaneRow}><NumberField id="lorebook-chat-width" label="Protected chat width" value={lorebook.minChatWidth} onChange={(minChatWidth) => update('lorebookEditorSettings', { minChatWidth })} min={240} max={900} suffix="px" /><NumberField id="lorebook-pane-width" label="Minimum editor width" value={lorebook.minEditorPaneWidth} onChange={(minEditorPaneWidth) => update('lorebookEditorSettings', { minEditorPaneWidth })} min={280} max={900} suffix="px" /></div></div>
      {halfEditorMode === 'floating' && <div className={styles.lorebookFullWidth} data-lorebook-section="floating-rectangle"><div className={styles.lorebookFloatingRectangle}><NumberField id="lorebook-half-height" label="Half-screen height" value={lorebook.halfRect.height} onChange={(height) => update('lorebookEditorSettings', { halfRect: { ...lorebook.halfRect, height } })} min={360} max={1000} suffix="px" /><NumberField id="lorebook-half-x" label="Half-screen X" value={lorebook.halfRect.x} onChange={(x) => update('lorebookEditorSettings', { halfRect: { ...lorebook.halfRect, x } })} min={0} max={1600} suffix="px" /><NumberField id="lorebook-half-y" label="Half-screen Y" value={lorebook.halfRect.y} onChange={(y) => update('lorebookEditorSettings', { halfRect: { ...lorebook.halfRect, y } })} min={0} max={1000} suffix="px" /></div></div>}
      <div className={styles.lorebookFullWidth} data-lorebook-section="density"><div className={styles.cardMeta}>The docked editor can never take the protected chat width, however far you drag it. Below the two values combined the row cannot hold both, so the editor covers it outright instead of leaving a sliver. The minimum editor width is also the full editor's floor.</div><SegmentedField label="Entry row density" value={lorebook.rowDensity} options={[['compact', 'Compact'], ['balanced', 'Balanced'], ['spacious', 'Spacious']]} onChange={(rowDensity) => update('lorebookEditorSettings', { rowDensity })} /></div>
      <div className={styles.lorebookCounting} data-lorebook-section="counting"><SegmentedField label="Count tokens" value={tokenCountMode} options={[['live', 'Always on'], ['delayed', 'After a delay'], ['manual', 'Only on request']]} onChange={(tokenCountMode) => update('lorebookEditorSettings', { tokenCountMode })} /><div className={styles.cardMeta}>{tokenCountMode === 'live' ? 'Recounts as you type.' : tokenCountMode === 'delayed' ? 'Counts once per opened entry. Opening one counts it straight away; the delay below only decides how long an edit must settle before the count is redone and saved. Use the button to recount after edits.' : 'Never counts automatically - press Count tokens in the entry editor.'}</div>{tokenCountMode === 'delayed' && <NumberField id="lorebook-token-delay" label="Settle time before an edit is recounted" value={lorebook.tokenCountDelayMs ?? 500} onChange={(tokenCountDelayMs) => update('lorebookEditorSettings', { tokenCountDelayMs })} min={0} max={5000} suffix="ms" />}<div className={styles.cardMeta}>Background counts are never saved back to the lorebook. Count tokens above decides when the entry you have open is counted and written; the two options below decide what is worked out ahead of time and kept only for this session.</div><div className={styles.lorebookCountingChecks}><CheckField id="lorebook-prefetch-hover" label="Count ahead when hovering an entry" checked={lorebook.tokenPrefetchHover !== false} onChange={(tokenPrefetchHover) => update('lorebookEditorSettings', { tokenPrefetchHover })} /><CheckField id="lorebook-count-all" label="Count every entry in the open lorebook" checked={lorebook.tokenCountAllEntries === true} disabled={tokenizerAvailability.status !== 'available'} onChange={(tokenCountAllEntries) => update('lorebookEditorSettings', { tokenCountAllEntries })} /></div>{tokenizerAvailability.status !== 'available' && <div className={styles.cardMeta}>{tokenizerAvailability.status === 'no-model' ? 'Counting every entry needs a connection profile with a model selected - without one there is no tokenizer to count with, and every exact number would really be a length estimate.' : tokenizerAvailability.status === 'checking' ? 'Checking which tokenizer handles this model...' : `No tokenizer pattern matches ${tokenizerAvailability.model}. Add one under Tokenizers to get exact counts; until then the list shows ~ estimates.`}</div>}{lorebook.tokenPrefetchHover !== false && <NumberField id="lorebook-prefetch-delay" label="Hover delay before counting" value={lorebook.tokenPrefetchHoverDelayMs ?? 220} onChange={(tokenPrefetchHoverDelayMs) => update('lorebookEditorSettings', { tokenPrefetchHoverDelayMs })} min={0} max={1000} suffix="ms" />}</div>
      <div className={styles.lorebookMetadata} data-lorebook-section="metadata"><MetadataChecklist label="Visible entry metadata" options={LOREBOOK_ENTRY_METADATA_OPTIONS} value={lorebook.visibleEntryMetadata} onChange={(visibleEntryMetadata) => update('lorebookEditorSettings', { visibleEntryMetadata, entryMetadataVersion: ENTRY_METADATA_VERSION })} /></div>
      <div className={styles.lorebookResets} data-lorebook-section="resets"><div className={styles.presetRow}><button type="button" className={styles.resetButton} onClick={resetLorebookLayout}>Reset current editor layout</button><button type="button" className={styles.resetButton} onClick={() => update('lorebookEditorSettings', PRODUCTIVITY_DEFAULTS.lorebookEditorSettings)}>Reset all Lorebook Editor settings</button></div></div>
    </div></section>
  </section>
}
