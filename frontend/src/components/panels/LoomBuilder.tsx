import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, useDeferredValue, type ReactNode, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'

import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import {
  GripVertical,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  X,
  Edit2,
  Eye,
  EyeOff,
  Check,
  ArrowLeft,
  Download,
  Upload,
  Copy,
  Layers,
  Hash,
  Lock,
  MoreVertical,
  Search,
  FileText,
  Zap,
  Settings2,
  Braces,
  RotateCcw,
  Wifi,
  Code2,
  AlertTriangle,
  MessageSquare,
  Bot,
  Wrench,
  Dice1,
  StopCircle,
  Maximize2,
  Camera,
  Link,
  Unlink,
} from 'lucide-react'
import clsx from 'clsx'
import ExpandedTextEditor, { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { ModalShell } from '@/components/shared/ModalShell'
import { RangeSlider } from '@/components/shared/RangeSlider'
import { resolveMacros as resolveMacrosApi } from '@/api/macros'
import { useLoomBuilder } from '@/hooks/useLoomBuilder'
import { usePresetProfiles } from '@/hooks/usePresetProfiles'
import { computeGroups, createBlock, createMarkerBlock } from '@/lib/loom/service'
import {
  PROMPT_TEMPLATES,
  PROVIDER_DISPLAY_NAMES,
  INJECTION_TRIGGER_TYPES,
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
} from '@/lib/loom/constants'
import type { PromptBlock, PromptVariableDef, LoomConnectionProfile, SamplerParam, MacroGroup, CategoryGroup, LoomPreset } from '@/lib/loom/types'
import { useLoomOptionLabels } from '@/lib/i18n/loomOptionLabels'
import { PromptVariablesModal } from '@/components/shared/PromptVariablesModal'
import { VariablesEditor } from './PromptVariablesEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import NumberStepper from '@/components/shared/NumberStepper'
import { useStore as __contextMeterStore } from '@/store'
import { groupBreakdownEntries as __groupBreakdownEntries } from '@/lib/prompt-breakdown'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import { Toggle } from '@/components/shared/Toggle'
import { Button } from '@/components/shared/FormComponents'
import { toast } from '@/lib/toast'
import { markLoomRuntimeProfileContext } from '@/lib/loom/runtimeProfile'
import s from './LoomBuilder.module.css'

function useLb() {
  return useTranslation('panels', { keyPrefix: 'loomBuilder' })
}

// ============================================================================
// HELPERS
// ============================================================================

function formatProfileLabel(connectionProfile: LoomConnectionProfile | null) {
  const sourceName = PROVIDER_DISPLAY_NAMES[connectionProfile?.source || '']
    || connectionProfile?.source
    || i18n.t('unknownProvider', { ns: 'panels', keyPrefix: 'loomBuilder' })
  const modelName = connectionProfile?.model?.split('/').pop() || null
  return { sourceName, modelName }
}

const ROLE_BADGES: Record<string, string> = {
  system: s.badgeSystem,
  user: s.badgeUser,
  assistant: s.badgeAssistant,
  user_append: s.badgeUserAppend,
  assistant_append: s.badgeAssistantAppend,
}

const ROLE_DISPLAY_LABELS: Record<string, string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  user_append: 'user+',
  assistant_append: 'asst+',
}

// ============================================================================
// SORTABLE CATEGORY ITEM
// ============================================================================

interface SortableCategoryItemProps {
  block: PromptBlock
  isCollapsed: boolean
  onToggleCollapse: () => void
  onEdit: (block: PromptBlock) => void
  onDelete: (id: string) => void
  onToggle: (id: string) => void
  childCount: number
  dragDisabled?: boolean
}

function SortableCategoryItem({
  block, isCollapsed, onToggleCollapse, onEdit, onDelete, onToggle, childCount, dragDisabled = false,
}: SortableCategoryItemProps) {
  const { t } = useLb()
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: dragDisabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const isDisabled = !block.enabled
  const displayName = block.name.replace(/^\u2501\s*/, '')

  return (
    <div
      ref={setNodeRef}
      className={clsx(s.item, s.categoryHeader, isDragging && s.itemDragging, isDisabled && s.itemDisabled)}
      style={style}
    >
      <span
        {...attributes}
        {...listeners}
        className={clsx(s.dragHandle, dragDisabled && s.dragHandleDisabled)}
        title={dragDisabled ? t('category.dragDisabledSearch') : t('category.dragReorderCategory')}
      >
        <GripVertical size={14} />
      </span>
      <Button size="icon-sm" variant="ghost" onClick={onToggleCollapse} title={isCollapsed ? t('category.expand') : t('category.collapse')}>
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </Button>
      <div className={s.categoryMeta} onClick={onToggleCollapse}>
        <span className={clsx(s.categoryName, s.truncTooltip)} data-tooltip={displayName}>
          <span className={s.categoryNameText}>{displayName}</span>
        </span>
        <span className={s.categoryMetaBadges}>
          <span className={s.categoryCount}>({childCount})</span>
          {block.categoryMode && (
            <span className={s.groupBadge}>
              {block.categoryMode === 'radio' ? t('category.pickOne') : t('category.multi')}
            </span>
          )}
        </span>
      </div>
      <Button size="icon-sm" variant="ghost" onClick={() => onToggle(block.id)} title={block.enabled ? t('category.disable') : t('category.enable')}>
        {block.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={() => onEdit(block)} title={t('category.rename')}>
        <Edit2 size={14} />
      </Button>
      <Button size="icon-sm" variant="danger-ghost" onClick={() => onDelete(block.id)} title={t('category.deleteCategory')}>
        <Trash2 size={14} />
      </Button>
    </div>
  )
}

// ============================================================================
// SORTABLE BLOCK ITEM
// ============================================================================

interface SortableBlockItemProps {
  block: PromptBlock
  onEdit: (block: PromptBlock) => void
  onDelete: (id: string) => void
  onToggle: (id: string) => void
  indented: boolean
  dragDisabled?: boolean
}

function SortableBlockItem({ block, onEdit, onDelete, onToggle, indented, dragDisabled = false }: SortableBlockItemProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: dragDisabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const isMarker = block.marker && block.marker !== 'category'
  const isDisabled = !block.enabled
  const preview = block.content ? block.content.substring(0, 50) + (block.content.length > 50 ? '...' : '') : ''

  return (
    <div
      ref={setNodeRef}
      className={clsx(s.item, isDragging && s.itemDragging, isMarker && s.marker, indented && s.itemIndented, isDisabled && s.itemDisabled)}
      style={style}
    >
      <span
        {...attributes}
        {...listeners}
        className={clsx(s.dragHandle, dragDisabled && s.dragHandleDisabled)}
        title={dragDisabled ? t('block.dragDisabledSearch') : t('block.dragReorder')}
      >
        <GripVertical size={14} />
      </span>
      <div className={clsx(s.blockContent, s.truncTooltip)} data-tooltip={block.name}>
        <div className={s.blockNameRow}>
          <span className={s.blockName}>
            {isMarker && <Hash size={12} className={s.blockNameIcon} />}
            {block.isLocked && <Lock size={10} className={clsx(s.blockNameIcon, s.blockNameIconMuted)} />}
            <span className={s.blockNameText}>{block.name}</span>
          </span>
          <span className={s.blockMetaRow}>
            {!isMarker && (
              <span className={clsx(s.badge, ROLE_BADGES[block.role] || s.badgeSystem)}>{ROLE_DISPLAY_LABELS[block.role] || block.role}</span>
            )}
            {isMarker && (
              <span className={clsx(s.badge, s.badgeMarker)}>{t('block.marker')}</span>
            )}
            {block.injectionTrigger?.length > 0 && (
              <span className={s.triggerBadgeList}>
                {block.injectionTrigger.map(t => {
                  const meta = INJECTION_TRIGGER_TYPES.find(tt => tt.value === t)
                  return meta ? <span key={t} className={s.triggerBadge}>{meta.shortLabel}</span> : null
                })}
              </span>
            )}
          </span>
        </div>
        {preview && !isMarker && <span className={s.blockPreview}>{preview}</span>}
      </div>
      <Button size="icon-sm" variant="ghost" onClick={() => onToggle(block.id)} title={block.enabled ? t('block.disable') : t('block.enable')}>
        {block.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={() => onEdit(block)} title={tc('actions.edit')}>
        <Edit2 size={14} />
      </Button>
      {!block.isLocked && (
        <Button size="icon-sm" variant="danger-ghost" onClick={() => onDelete(block.id)} title={tc('actions.delete')}>
          <Trash2 size={14} />
        </Button>
      )}
    </div>
  )
}

// ============================================================================
// BLOCK EDITOR
// ============================================================================

interface BlockEditorProps {
  block: PromptBlock
  onSave: (updates: Partial<PromptBlock>) => void
  onBack: () => void
  availableMacros: MacroGroup[]
  refreshMacros?: () => void
  compact: boolean
}

function BlockEditor({ block, onSave, onBack, availableMacros, refreshMacros, compact }: BlockEditorProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const { injectionTriggerTypes, injectionTriggerLabel } = useLoomOptionLabels()
  const [name, setName] = useState(block.name)
  const [role, setRole] = useState<PromptBlock['role']>(block.role || 'system')
  const [content, setContent] = useState(block.content || '')
  const [position, setPosition] = useState<PromptBlock['position']>(block.position || 'pre_history')
  const [depth, setDepth] = useState(block.depth || 0)
  const [isLocked, setIsLocked] = useState(block.isLocked || false)
  const [injectionTrigger, setInjectionTrigger] = useState<string[]>(block.injectionTrigger || [])
  const [categoryMode, setCategoryMode] = useState<PromptBlock['categoryMode']>(block.categoryMode ?? null)
  const [variables, setVariables] = useState<PromptVariableDef[]>(
    Array.isArray(block.variables) ? block.variables : [],
  )
  const [showMacros, setShowMacros] = useState(false)
  const [macroSearch, setMacroSearch] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewDiagnostics, setPreviewDiagnostics] = useState<{ level: string; message: string }[]>([])
  const [showExpandedEditor, setShowExpandedEditor] = useState(false)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeChatId = __contextMeterStore((s) => s.activeChatId)

  // Debounced macro preview resolution
  useEffect(() => {
    if (!showPreview || !content.trim()) {
      setPreviewText('')
      setPreviewDiagnostics([])
      return
    }
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      setPreviewLoading(true)
      // Trim the preview to match the dry run: the assembly strips
      // leading/trailing whitespace from each resolved block, except append
      // roles, where it preserves whitespace for inter-append spacing.
      const isAppend = role === 'user_append' || role === 'assistant_append'
      resolveMacrosApi({ template: content, trim: !isAppend, ...(activeChatId ? { chat_id: activeChatId } : {}) })
        .then((res) => {
          setPreviewText(res.text)
          setPreviewDiagnostics(res.diagnostics)
        })
        .catch(() => {
          setPreviewText(t('blockEditor.previewUnavailable'))
          setPreviewDiagnostics([])
        })
        .finally(() => setPreviewLoading(false))
    }, 500)
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current) }
  }, [content, showPreview, activeChatId, role])

  const handlePositionChange = (newPosition: string) => {
    const pos = newPosition as PromptBlock['position']
    setPosition(pos)
    const isAppend = role === 'user_append' || role === 'assistant_append'
    if (pos === 'post_history' && !isAppend && role === 'system') setRole('user')
    else if (pos === 'pre_history' && role === 'assistant') setRole('system')
  }

  const handleSave = () => {
    const isAppend = role === 'user_append' || role === 'assistant_append'
    const cleanedVariables = variables.filter((v) => v && v.name?.trim().length > 0)
    onSave({
      name, role, content,
      position: isAppend ? 'pre_history' : position,
      depth: (position === 'in_history' || isAppend) ? depth : 0,
      isLocked, injectionTrigger,
      categoryMode: block.marker === 'category' ? categoryMode : null,
      variables: cleanedVariables.length ? cleanedVariables : undefined,
    })
  }

  const toggleTrigger = (value: string) => {
    setInjectionTrigger(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }

  const insertMacroInto = useCallback((syntax: string, taRef: React.RefObject<HTMLTextAreaElement | null>) => {
    const ta = taRef.current
    if (!ta) { setContent(prev => prev + syntax); return }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const newContent = content.substring(0, start) + syntax + content.substring(end)
    setContent(newContent)
    setShowMacros(false)
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = start + syntax.length
    })
  }, [content])

  const insertMacro = (syntax: string) => insertMacroInto(syntax, textareaRef)

  const filteredMacros = useMemo(() => {
    if (!macroSearch.trim()) return availableMacros
    const q = macroSearch.toLowerCase()
    return availableMacros.map(group => ({
      ...group,
      macros: group.macros.filter(m => m.name.toLowerCase().includes(q) || m.syntax.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)),
    })).filter(g => g.macros.length > 0)
  }, [availableMacros, macroSearch])

  return (
    <div className={clsx(s.layout, compact && s.layoutCompact)}>
      {compact && (
        <div className={s.toolbar} style={{ justifyContent: 'space-between' }}>
          <Button size="icon-sm" variant="ghost" onClick={onBack} title={t('blockEditor.backToList')}><ArrowLeft size={18} /></Button>
          <span style={{ fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))', fontWeight: 600 }}>{t('blockEditor.title')}</span>
          <button className={clsx(s.btn, s.btnPrimary, s.btnSmall)} onClick={handleSave} type="button"><Check size={12} /> {t('blockEditor.save')}</button>
        </div>
      )}
      {!compact && (
        <div className={s.header}>
          <Button size="icon-sm" variant="ghost" onClick={onBack} title={t('blockEditor.backToList')}><ArrowLeft size={18} /></Button>
          <h3 className={s.title}>{t('blockEditor.title')}</h3>
          <div style={{ flex: 1 }} />
          <button className={clsx(s.btn, s.btnPrimary)} onClick={handleSave} type="button"><Check size={14} /> {t('blockEditor.save')}</button>
        </div>
      )}
      <div className={s.scrollArea}>
        <div className={s.form}>
          <div className={s.formGroup}>
            <label className={s.label}>{t('blockEditor.name')}</label>
            <input className={s.input} value={name} onChange={e => setName(e.target.value)} placeholder={t('blockEditor.namePlaceholder')} />
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div className={s.formGroup} style={{ flex: 1, minWidth: '120px' }}>
              <label className={s.label}>{t('blockEditor.role')}</label>
              <select className={s.select} value={role} onChange={e => setRole(e.target.value as PromptBlock['role'])}>
                {position !== 'post_history' && <option value="system">{t('blockEditor.roles.system')}</option>}
                <option value="user">{t('blockEditor.roles.user')}</option>
                <option value="assistant">{t('blockEditor.roles.assistant')}</option>
                <option value="user_append">{t('blockEditor.roles.user_append')}</option>
                <option value="assistant_append">{t('blockEditor.roles.assistant_append')}</option>
              </select>
            </div>
            {role !== 'user_append' && role !== 'assistant_append' && (
              <div className={s.formGroup} style={{ flex: 1, minWidth: '140px' }}>
                <label className={s.label}>{t('blockEditor.position')}</label>
                <select className={s.select} value={position} onChange={e => handlePositionChange(e.target.value)}>
                  <option value="pre_history">{t('blockEditor.positions.pre_history')}</option>
                  <option value="post_history">{t('blockEditor.positions.post_history')}</option>
                  <option value="in_history">{t('blockEditor.positions.in_history')}</option>
                </select>
              </div>
            )}
            {(position === 'in_history' || role === 'user_append' || role === 'assistant_append') && (
              <div className={s.formGroup} style={{ width: '100px' }}>
                <label className={s.label}>{t('blockEditor.depth')}</label>
                <NumberStepper value={depth} min={0} onChange={(v) => setDepth(v ?? 0)} />
              </div>
            )}
            {(role === 'user_append' || role === 'assistant_append') && (
              <div className={s.postHistoryNote} style={{ width: '100%' }}>
                {role === 'user_append' ? t('blockEditor.depthHintUser') : t('blockEditor.depthHintAssistant')}
              </div>
            )}
          </div>

          <div className={s.formGroup}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label className={s.label}>{t('blockEditor.content')}</label>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className={clsx(s.btn, s.btnSmall)} onClick={() => { if (!showMacros) refreshMacros?.(); setShowMacros(!showMacros) }} type="button">
                  <Hash size={12} /> {showMacros ? t('blockEditor.hideMacros') : t('blockEditor.insertMacro')}
                </button>
                <button className={clsx(s.btn, s.btnSmall)} onClick={() => setShowExpandedEditor(true)} title={t('blockEditor.expandEditor')} type="button">
                  <Maximize2 size={12} />
                </button>
              </div>
            </div>
            {showMacros && (
              <div className={s.macroPanel}>
                <div className={s.macroSearch}>
                  <div className={s.macroSearchInner}>
                    <Search size={12} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
                    <input className={s.macroSearchInput} placeholder={t('blockEditor.searchMacros')} value={macroSearch} onChange={e => setMacroSearch(e.target.value)} />
                  </div>
                </div>
                {filteredMacros.map(group => (
                  <div key={group.category} className={s.macroGroup}>
                    <div className={s.macroGroupTitle}>{group.category}</div>
                    {group.macros.map(macro => (
                      <div key={macro.syntax} className={s.macroItem} onClick={() => insertMacro(macro.syntax)}>
                        <span className={s.macroSyntax}>{macro.syntax}</span>
                        <span className={s.macroDesc}>{macro.description}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <textarea ref={textareaRef} className={s.textarea} value={content} onChange={e => setContent(e.target.value)} placeholder={t('blockEditor.contentPlaceholder')} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <button className={clsx(s.btn, s.btnSmall, showPreview && s.btnPrimary)} onClick={() => setShowPreview(!showPreview)} type="button">
                <Eye size={12} /> {showPreview ? t('blockEditor.hidePreview') : t('blockEditor.preview')}
              </button>
              {showPreview && previewLoading && <span style={{ fontSize: 'calc(10px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)' }}>{t('blockEditor.resolving')}</span>}
            </div>
            {showPreview && (
              <div className={s.previewPanel}>
                {previewDiagnostics.length > 0 && (
                  <div className={s.previewDiagnostics}>
                    {previewDiagnostics.map((d, i) => (
                      <div key={i} className={d.level === 'error' ? s.previewDiagError : s.previewDiagWarn}>
                        <AlertTriangle size={10} /> {d.message}
                      </div>
                    ))}
                  </div>
                )}
                <pre className={s.previewContent}>{previewLoading ? t('blockEditor.resolving') : (previewText === '' && content ? t('blockEditor.emptyOutput') : previewText || t('blockEditor.noPreview'))}</pre>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Toggle.Checkbox checked={isLocked} onChange={setIsLocked} label={<><Lock size={14} /> {t('blockEditor.lockBlock')}</>} />
          </div>

          {block.marker === 'category' && (
            <div className={s.formGroup}>
              <label className={s.label}>{t('blockEditor.categoryMode')}</label>
              <select
                className={s.select}
                value={categoryMode || ''}
                onChange={e => setCategoryMode((e.target.value || null) as PromptBlock['categoryMode'])}
              >
                <option value="">{t('blockEditor.categoryModeNormal')}</option>
                <option value="checkbox">{t('blockEditor.categoryModeMulti')}</option>
                <option value="radio">{t('blockEditor.categoryModeRadio')}</option>
              </select>
              <span className={s.settingsHint}>
                {t('blockEditor.categoryModeHint')}
              </span>
            </div>
          )}

          <div className={s.formGroup}>
            <label className={s.label}>{t('blockEditor.injectionTriggers')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {injectionTriggerTypes.map(trigger => (
                <label key={trigger.value} className={clsx(s.triggerLabel, injectionTrigger.includes(trigger.value) ? s.triggerLabelActive : s.triggerLabelInactive)}>
                  <input type="checkbox" className={s.triggerCheckbox} checked={injectionTrigger.includes(trigger.value)} onChange={() => toggleTrigger(trigger.value)} />
                  {trigger.label}
                </label>
              ))}
            </div>
            <span className={s.settingsHint}>
              {injectionTrigger.length === 0
                ? t('blockEditor.triggersNone')
                : t('blockEditor.triggersActive', { list: injectionTrigger.map(injectionTriggerLabel).join(', ') })}
            </span>
          </div>

          <VariablesEditor variables={variables} onChange={setVariables} />
        </div>
      </div>
      {showExpandedEditor && (
        <ExpandedTextEditor
          value={content}
          onChange={setContent}
          onClose={() => setShowExpandedEditor(false)}
          title={name || t('blockEditor.title')}
          placeholder={t('blockEditor.contentPlaceholder')}
          macros={availableMacros}
          onRefreshMacros={refreshMacros}
        />
      )}
    </div>
  )
}

// ============================================================================
// PRESET SELECTOR
// ============================================================================

interface PresetSelectorProps {
  registry: Record<string, { name: string; blockCount: number }>
  activePresetId: string | null
  activePresetName: string | null
  onSelect: (id: string | null) => void
  onCreate: (name: string) => void
  onRename: (name: string) => void
  onDuplicate: () => void
  onDelete: () => void
  onImport: (type: string) => void
  onExport: () => void
  onExportLegacy: () => void
}

function PresetSelector({ registry, activePresetId, activePresetName, onSelect, onCreate, onRename, onDuplicate, onDelete, onImport, onExport, onExportLegacy }: PresetSelectorProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const [showMenu, setShowMenu] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameName, setRenameName] = useState('')
  const registryEntries = Object.entries(registry)

  const handleCreate = () => {
    if (!newName.trim()) return
    onCreate(newName.trim())
    setNewName('')
    setShowCreate(false)
  }

  const handleRename = () => {
    if (!renameName.trim()) return
    onRename(renameName.trim())
    setRenameName('')
    setShowRename(false)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
      <select className={s.select} style={{ flex: 1, minWidth: 0 }} value={activePresetId || ''} onChange={e => onSelect(e.target.value || null)}>
        <option value="">{t('preset.selectPlaceholder')}</option>
        {registryEntries.map(([id, entry]) => (
          <option key={id} value={id}>{t('preset.blocksCount', { name: entry.name, count: entry.blockCount })}</option>
        ))}
      </select>

      <div style={{ position: 'relative' }}>
        <Button size="icon-sm" variant="ghost" onClick={() => setShowMenu(!showMenu)} title={t('preset.moreOptions')}>
          <MoreVertical size={16} />
        </Button>
        {showMenu && (
          <div className={s.dropdownMenu} style={{ top: '100%', right: 0, minWidth: '160px' }}>
            <MenuButton icon={<Plus size={14} />} label={t('preset.newPreset')} onClick={() => { setShowCreate(true); setShowMenu(false) }} />
            {activePresetId && (
              <>
                <MenuButton icon={<Edit2 size={14} />} label={t('preset.rename')} onClick={() => { setRenameName(activePresetName || ''); setShowRename(true); setShowMenu(false) }} />
                <MenuButton icon={<Copy size={14} />} label={t('preset.duplicate')} onClick={() => { onDuplicate(); setShowMenu(false) }} />
                <MenuButton icon={<Download size={14} />} label={t('preset.exportLoomJson')} onClick={() => { onExport(); setShowMenu(false) }} />
                <MenuButton icon={<Download size={14} />} label={t('preset.exportLegacy')} onClick={() => { onExportLegacy(); setShowMenu(false) }} />
                <hr className={s.menuDivider} />
                <MenuButton icon={<Trash2 size={14} />} label={tc('actions.delete')} danger onClick={() => { onDelete(); setShowMenu(false) }} />
              </>
            )}
            <hr className={s.menuDivider} />
            <MenuButton icon={<Upload size={14} />} label={t('preset.importLegacy')} onClick={() => { onImport('st'); setShowMenu(false) }} />
            <MenuButton icon={<Upload size={14} />} label={t('preset.importLoomJson')} onClick={() => { onImport('json'); setShowMenu(false) }} />
          </div>
        )}
      </div>

      <ModalShell isOpen={showCreate} onClose={() => setShowCreate(false)} maxWidth="clamp(320px, 90vw, min(420px, var(--lumiverse-content-max-width, 420px)))" className={s.presetNameModal}>
        <div className={s.presetNameHeader}>
          <Plus size={16} />
          <h3 className={s.presetNameTitle}>{t('preset.newTitle')}</h3>
        </div>
        <div className={s.presetNameBody}>
          <input className={s.presetNameInput} placeholder={t('preset.namePlaceholder')} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate()} autoFocus />
          <div className={s.presetNameActions}>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnCancel)} onClick={() => setShowCreate(false)}>{tc('actions.cancel')}</button>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnSubmit)} onClick={handleCreate} disabled={!newName.trim()}>{t('preset.create')}</button>
          </div>
        </div>
      </ModalShell>

      <ModalShell isOpen={showRename} onClose={() => setShowRename(false)} maxWidth="clamp(320px, 90vw, min(420px, var(--lumiverse-content-max-width, 420px)))" className={s.presetNameModal}>
        <div className={s.presetNameHeader}>
          <Edit2 size={16} />
          <h3 className={s.presetNameTitle}>{t('preset.renameTitle')}</h3>
        </div>
        <div className={s.presetNameBody}>
          <input className={s.presetNameInput} placeholder={t('preset.namePlaceholder')} value={renameName} onChange={e => setRenameName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRename()} autoFocus />
          <div className={s.presetNameActions}>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnCancel)} onClick={() => setShowRename(false)}>{tc('actions.cancel')}</button>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnSubmit)} onClick={handleRename} disabled={!renameName.trim()}>{t('preset.renameAction')}</button>
          </div>
        </div>
      </ModalShell>
    </div>
  )
}

function PresetCoverHeader({ preset }: { preset: LoomPreset }) {
  const { t } = useLb()
  const coverUrl = preset.coverUrl?.trim()
  if (!coverUrl) return null

  const description = preset.description?.trim()

  return (
    <section className={s.presetCoverHeader} aria-label={t('preset.coverAria', { name: preset.name })}>
      <img className={s.presetCoverImage} src={coverUrl} alt="" aria-hidden="true" />
      <div className={s.presetCoverContent}>
        <div className={s.presetCoverBadgeRow}>
          <span className={s.presetCoverBadge}>{t('preset.lumihubBadge')}</span>
          {preset.presetVersion && (
            <span className={s.presetCoverBadge}>{t('preset.version', { version: preset.presetVersion })}</span>
          )}
          <span className={s.presetCoverBadge}>{t('preset.blocks', { count: preset.blocks.length })}</span>
        </div>
        <h2 className={s.presetCoverTitle}>{preset.name}</h2>
        {description && <p className={s.presetCoverDescription}>{description}</p>}
      </div>
    </section>
  )
}

// ============================================================================
// MENU BUTTON
// ============================================================================

function MenuButton({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={clsx(s.menuButton, danger && s.menuButtonDanger)} onClick={onClick} type="button">
      {icon}
      {label}
    </button>
  )
}

// ============================================================================
// SAMPLER SLIDER
// ============================================================================

interface SamplerSliderProps {
  param: SamplerParam
  value: number | null | undefined
  onChange: (key: string, value: number | null) => void
}

function isSamplerParamSet(param: SamplerParam, value: number | null | undefined) {
  if (value === null || value === undefined) return false
  if (param.optIn && value === param.defaultHint) return false
  return true
}

function SamplerSlider({ param, value, onChange }: SamplerSliderProps) {
  const { t } = useLb()
  const isSet = isSamplerParamSet(param, value)
  const hasIncludeToggle = !!param.includeToggle
  const isIncluded = hasIncludeToggle ? isSet : true

  const [localInput, setLocalInput] = useState(isSet ? String(value) : '')
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputEditingRef = useRef(false)

  useEffect(() => {
    if (!inputEditingRef.current) setLocalInput(isSet ? String(value) : '')
  }, [value, isSet])

  useEffect(() => () => { if (inputTimerRef.current) clearTimeout(inputTimerRef.current) }, [])

  const formatForInput = useCallback((val: number) => {
    if (param.type === 'int') return String(Math.round(val))
    const decimals = (String(param.step).split('.')[1] || '').length
    return val.toFixed(decimals)
  }, [param.type, param.step])

  const commitInput = useCallback((raw: string) => {
    inputEditingRef.current = false
    if (raw === '') { onChange(param.key, null); return }
    const num = param.type === 'int' ? parseInt(raw) : parseFloat(raw)
    if (!isNaN(num)) onChange(param.key, Math.min(param.max, Math.max(param.min, num)))
  }, [param, onChange])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    inputEditingRef.current = true
    setLocalInput(raw)
    if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
    inputTimerRef.current = setTimeout(() => commitInput(raw), 1000)
  }, [commitInput])

  const handleInputBlur = useCallback(() => {
    if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
    commitInput(localInput)
  }, [localInput, commitInput])

  const handleToggleIncluded = useCallback((checked: boolean) => {
    if (!hasIncludeToggle) return
    if (!checked) {
      onChange(param.key, null)
      return
    }

    const nextValue = value ?? param.defaultHint
    onChange(param.key, nextValue)
  }, [hasIncludeToggle, onChange, param.defaultHint, param.key, value])

  // RangeSlider commit → propagate to parent. onDragValue mirrors the live
  // drag value into the number input so the field tracks the thumb in real
  // time; on cancel without commit (null), the useEffect above will resync
  // localInput from the unchanged value prop.
  const handleSliderCommit = useCallback((val: number) => {
    onChange(param.key, val)
  }, [onChange, param.key])

  const handleSliderDragValue = useCallback((val: number | null) => {
    if (val === null) {
      setLocalInput(isSet ? String(value) : '')
    } else {
      setLocalInput(formatForInput(val))
    }
  }, [formatForInput, isSet, value])

  const sliderValue = isSet ? value! : param.defaultHint

  return (
    <div className={s.sliderRow}>
      <div className={s.sliderHeader}>
        {hasIncludeToggle ? (
          <Toggle.Checkbox
            checked={isIncluded}
            onChange={handleToggleIncluded}
            label={<span className={clsx(s.sliderLabel, isSet ? s.sliderLabelSet : s.sliderLabelUnset)}>{param.label}</span>}
            className={s.sliderToggle}
          />
        ) : (
          <span className={clsx(s.sliderLabel, isSet ? s.sliderLabelSet : s.sliderLabelUnset)}>{param.label}</span>
        )}
        <input
          type="number"
          value={isIncluded ? localInput : ''}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          className={clsx(s.sliderInput, isSet ? s.sliderInputSet : s.sliderInputUnset)}
          min={param.min}
          max={param.max}
          step={param.step}
          placeholder={String(param.defaultHint)}
          disabled={!isIncluded}
        />
      </div>
      <div
        onDoubleClick={() => onChange(param.key, null)}
        title={t('sampler.doubleClickReset')}
        style={{ opacity: !isIncluded ? 0.2 : isSet ? 1 : 0.4 }}
      >
        <RangeSlider
          min={param.min}
          max={param.max}
          step={param.step}
          integer={param.type === 'int'}
          value={sliderValue}
          disabled={!isIncluded}
          onCommit={handleSliderCommit}
          onDragValue={handleSliderDragValue}
        />
      </div>
    </div>
  )
}

// ============================================================================
// GENERATION SETTINGS
// ============================================================================

interface GenerationSettingsProps {
  samplerOverrides: any
  customBody: any
  connectionProfile: LoomConnectionProfile | null
  samplerParams: SamplerParam[]
  onSaveSamplers: (overrides: any) => void
  onSaveCustomBody: (body: any) => void
  onRefreshProfile: () => void
}

function GenerationSettings({ samplerOverrides, customBody, connectionProfile, samplerParams, onSaveSamplers, onSaveCustomBody, onRefreshProfile }: GenerationSettingsProps) {
  const { t } = useLb()
  const [isExpanded, setIsExpanded] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [localJson, setLocalJson] = useState(customBody?.rawJson || '{}')

  const prevJsonRef = useRef(customBody?.rawJson)
  if (customBody?.rawJson !== prevJsonRef.current) {
    prevJsonRef.current = customBody?.rawJson
    setLocalJson(customBody?.rawJson || '{}')
    setJsonError(null)
  }

  const overrides = samplerOverrides || {}
  const body = customBody || {}
  const supported = connectionProfile?.supportedParams || new Set<string>()

  const visibleParams = samplerParams.filter(p => supported.has(p.key))
  const activeCount = visibleParams.filter(p => {
    const v = overrides[p.key]
    return isSamplerParamSet(p, v)
  }).length

  const handleChangeParam = (key: string, value: number | null) => {
    onSaveSamplers({ ...overrides, enabled: true, [key]: value })
  }

  const handleResetSamplers = () => onSaveSamplers({ ...DEFAULT_SAMPLER_OVERRIDES })

  const handleToggleCustomBody = () => onSaveCustomBody({ ...body, enabled: !body.enabled })

  const handleJsonChange = (raw: string) => {
    setLocalJson(raw)
    try {
      JSON.parse(raw)
      setJsonError(null)
      onSaveCustomBody({ ...body, rawJson: raw })
    } catch (e: any) {
      setJsonError(e.message)
    }
  }

  const isActive = overrides.enabled || body.enabled

  return (
    <div className={s.accordionSection}>
      <div
        className={clsx(s.accordionHeader, isActive && s.accordionHeaderActive)}
        onClick={() => { setIsExpanded(!isExpanded); if (!isExpanded) onRefreshProfile() }}
      >
        <Settings2 size={12} style={{ color: isActive ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>{t('settings.samplers')}</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
        {body.enabled && <Code2 size={10} style={{ color: 'var(--lumiverse-primary)', flexShrink: 0 }} />}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={clsx(s.accordionBody, s.accordionBodyGen)}>
          <div className={s.samplerHeader}>
            <span className={s.samplerLabel}>{t('settings.samplers')}</span>
            <button className={s.resetBtn} onClick={handleResetSamplers} title={t('settings.resetAll')} type="button">
              <RotateCcw size={8} /> {t('settings.reset')}
            </button>
          </div>
          {visibleParams.map(param => (
            <SamplerSlider key={param.key} param={param} value={overrides[param.key]} onChange={handleChangeParam} />
          ))}
          {visibleParams.length === 0 && (
            <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', padding: '8px 0', textAlign: 'center' }}>
              {t('settings.noSamplers')}
            </div>
          )}
          <hr className={s.menuDivider} style={{ margin: '8px 0 4px' }} />
          <div style={{ padding: '2px 0 4px' }}>
            <Toggle.Checkbox
              checked={overrides.streaming !== false}
              onChange={(v) => onSaveSamplers({ ...overrides, enabled: true, streaming: v })}
              label={t('settings.streamResponse')}
              hint={t('settings.streamHint')}
            />
          </div>
          <hr className={s.menuDivider} style={{ margin: '4px 0 4px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0 4px' }}>
            <span className={s.samplerLabel}>{t('settings.customBody')}</span>
            <Toggle.Checkbox checked={!!body.enabled} onChange={handleToggleCustomBody} label={t('settings.enabled')} />
          </div>
          <div style={body.enabled ? {} : { opacity: 0.35, pointerEvents: 'none' as const }}>
            <textarea
              className={s.customBodyTextarea}
              value={localJson}
              onChange={e => handleJsonChange(e.target.value)}
              placeholder={'{\n  "thinking": { "type": "enabled" }\n}'}
              spellCheck={false}
            />
            {jsonError && <div className={s.jsonError}><AlertTriangle size={10} /> {jsonError}</div>}
            <div className={s.settingsHint} style={{ marginTop: '3px' }}>{t('settings.customBodyHint')}</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// PROMPT BEHAVIOR SETTINGS
// ============================================================================

function PromptBehaviorSettings({ promptBehavior, onSave }: { promptBehavior: any; onSave: (updates: Record<string, any>) => void }) {
  const { t } = useLb()
  const [isExpanded, setIsExpanded] = useState(false)
  const behavior = promptBehavior || {}
  const defaults = DEFAULT_PROMPT_BEHAVIOR

  const activeCount = Object.keys(defaults).filter(key => {
    const current = behavior[key] ?? defaults[key as keyof typeof defaults]
    return current !== defaults[key as keyof typeof defaults]
  }).length

  const handleChange = (key: string, value: string) => onSave({ [key]: value })
  const handleRestore = (key: string) => onSave({ [key]: defaults[key as keyof typeof defaults] })

  const renderField = ({ fieldKey, label, hint, multiline }: { fieldKey: string; label: string; hint?: string; multiline?: boolean }) => {
    const value = behavior[fieldKey] ?? defaults[fieldKey as keyof typeof defaults]
    const isDefault = value === defaults[fieldKey as keyof typeof defaults]
    return (
      <div className={s.settingsField}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className={clsx(s.settingsFieldLabel, isDefault ? s.settingsFieldLabelDefault : s.settingsFieldLabelModified)}>{label}</span>
          {!isDefault && (
            <button className={s.resetBtn} onClick={() => handleRestore(fieldKey)} title={t('settings.restoreDefault')} type="button">
              <RotateCcw size={7} /> {t('sampler.default')}
            </button>
          )}
        </div>
        <ExpandableTextarea
          className={s.settingsTextarea}
          value={value}
          onChange={next => handleChange(fieldKey, next)}
          title={t('settings.promptBehaviorTitle', { label })}
          rows={multiline ? 4 : 2}
          spellCheck={false}
        />
        {hint && <span className={s.settingsHint}>{hint}</span>}
      </div>
    )
  }

  return (
    <div className={s.accordionSection}>
      <div className={clsx(s.accordionHeader, activeCount > 0 && s.accordionHeaderActive)} onClick={() => setIsExpanded(!isExpanded)}>
        <MessageSquare size={12} style={{ color: activeCount > 0 ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>{t('settings.promptBehavior')}</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={s.accordionBody}>
          {renderField({ fieldKey: 'continueNudge', label: t('settings.continueNudge'), hint: t('settings.continueNudgeHint'), multiline: true })}
          {renderField({ fieldKey: 'emptySendNudge', label: t('settings.emptySendNudge'), hint: t('settings.emptySendNudgeHint'), multiline: true })}
          {renderField({ fieldKey: 'impersonationPrompt', label: t('settings.impersonationPrompt'), hint: t('settings.impersonationPromptHint'), multiline: true })}
          {renderField({ fieldKey: 'groupNudge', label: t('settings.groupNudge'), hint: t('settings.groupNudgeHint'), multiline: true })}
          {renderField({ fieldKey: 'newChatPrompt', label: t('settings.newChatPrompt'), hint: t('settings.newChatPromptHint') })}
          {renderField({ fieldKey: 'newGroupChatPrompt', label: t('settings.newGroupChatPrompt'), hint: t('settings.newGroupChatPromptHint') })}
          {renderField({ fieldKey: 'sendIfEmpty', label: t('settings.sendIfEmpty'), hint: t('settings.sendIfEmptyHint') })}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// COMPLETION SETTINGS
// ============================================================================

function CompletionSettingsPanel({ completionSettings, onSave }: { completionSettings: any; onSave: (updates: Record<string, any>) => void }) {
  const { t } = useLb()
  const { continuePostfixOptions } = useLoomOptionLabels()
  const [isExpanded, setIsExpanded] = useState(false)
  const settings = completionSettings || {}
  const defaults = DEFAULT_COMPLETION_SETTINGS
  const visibleKeys = Object.keys(defaults).filter(key => key !== 'namesBehavior')

  const activeCount = visibleKeys.filter(key => {
    const current = settings[key] ?? defaults[key as keyof typeof defaults]
    return current !== defaults[key as keyof typeof defaults]
  }).length

  const handleChange = (key: string, value: any) => onSave({ [key]: value })

  return (
    <div className={s.accordionSection}>
      <div className={clsx(s.accordionHeader, activeCount > 0 && s.accordionHeaderActive)} onClick={() => setIsExpanded(!isExpanded)}>
        <Bot size={12} style={{ color: activeCount > 0 ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>{t('settings.completion')}</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={s.accordionBody}>
          <div className={s.settingsField}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.assistantPrefill')}</span>
            <textarea className={s.settingsTextarea} style={{ minHeight: '40px' }} value={settings.assistantPrefill ?? defaults.assistantPrefill} onChange={e => handleChange('assistantPrefill', e.target.value)} placeholder={t('settings.assistantPrefillPlaceholder')} spellCheck={false} />
            <span className={s.settingsHint}>{t('settings.assistantPrefillHint')}</span>
          </div>
          <div className={s.settingsField}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.impersonationPrefill')}</span>
            <textarea className={s.settingsTextarea} style={{ minHeight: '40px' }} value={settings.assistantImpersonation ?? defaults.assistantImpersonation} onChange={e => handleChange('assistantImpersonation', e.target.value)} placeholder={t('settings.impersonationPrefillPlaceholder')} spellCheck={false} />
            <span className={s.settingsHint}>{t('settings.impersonationPrefillHint')}</span>
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <Toggle.Checkbox checked={!!(settings.continuePrefill ?? defaults.continuePrefill)} onChange={v => handleChange('continuePrefill', v)} label={t('settings.continuePrefill')} />
            <Toggle.Checkbox checked={!!(settings.squashSystemMessages ?? defaults.squashSystemMessages)} onChange={v => handleChange('squashSystemMessages', v)} label={t('settings.squashSystem')} />
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div className={s.settingsField} style={{ flex: '1 1 140px' }}>
              <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.continuePostfix')}</span>
              <select className={s.settingsInput} style={{ cursor: 'pointer' }} value={settings.continuePostfix ?? defaults.continuePostfix} onChange={e => handleChange('continuePostfix', e.target.value)}>
                {continuePostfixOptions.map(opt => <option key={opt.value || 'none'} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
          </div>
          <hr className={s.menuDivider} />
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <Toggle.Checkbox checked={!!(settings.useSystemPrompt ?? defaults.useSystemPrompt)} onChange={v => handleChange('useSystemPrompt', v)} label={t('settings.useSystemPrompt')} />
            <Toggle.Checkbox checked={!!(settings.enableWebSearch ?? defaults.enableWebSearch)} onChange={v => handleChange('enableWebSearch', v)} label={t('settings.enableWebSearch')} />
            <Toggle.Checkbox checked={!!(settings.sendInlineMedia ?? defaults.sendInlineMedia)} onChange={v => handleChange('sendInlineMedia', v)} label={t('settings.sendInlineMedia')} />
            <Toggle.Checkbox checked={!!(settings.enableFunctionCalling ?? defaults.enableFunctionCalling)} onChange={v => handleChange('enableFunctionCalling', v)} label={t('settings.enableFunctionCalling')} />
            <Toggle.Checkbox checked={!!(settings.includeUsage ?? defaults.includeUsage)} onChange={v => handleChange('includeUsage', v)} label={t('settings.includeUsage')} />
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// ADVANCED SETTINGS
// ============================================================================

function AdvancedSettingsPanel({
  advancedSettings,
  completionSettings,
  onSave,
  onSaveCompletion,
}: {
  advancedSettings: any
  completionSettings: any
  onSave: (updates: Record<string, any>) => void
  onSaveCompletion: (updates: Record<string, any>) => void
}) {
  const { t } = useLb()
  const { namesBehaviorOptions } = useLoomOptionLabels()
  const [isExpanded, setIsExpanded] = useState(false)
  const [stopInput, setStopInput] = useState('')
  const settings = advancedSettings || {}
  const defaults = DEFAULT_ADVANCED_SETTINGS
  const completion = completionSettings || {}
  const completionDefaults = DEFAULT_COMPLETION_SETTINGS

  const seed = settings.seed ?? defaults.seed
  const stopStrings: string[] = settings.customStopStrings ?? defaults.customStopStrings
  const collapseMessages: boolean = settings.collapseMessages ?? defaults.collapseMessages
  const namesBehavior = completion.namesBehavior ?? completionDefaults.namesBehavior

  const isActive = seed >= 0 || stopStrings.length > 0 || collapseMessages || namesBehavior !== completionDefaults.namesBehavior

  const handleSeedChange = (value: string) => {
    const num = parseInt(value)
    onSave({ seed: isNaN(num) ? -1 : num })
  }

  const handleAddStopString = () => {
    const trimmed = stopInput.trim()
    if (!trimmed || stopStrings.includes(trimmed)) return
    onSave({ customStopStrings: [...stopStrings, trimmed] })
    setStopInput('')
  }

  const handleRemoveStopString = (index: number) => {
    onSave({ customStopStrings: stopStrings.filter((_, i) => i !== index) })
  }

  return (
    <div className={s.accordionSection}>
      <div className={clsx(s.accordionHeader, isActive && s.accordionHeaderActive)} onClick={() => setIsExpanded(!isExpanded)}>
        <Wrench size={12} style={{ color: isActive ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>{t('settings.advanced')}</span>
        {isActive && <span className={s.accordionBadge}>{(seed >= 0 ? 1 : 0) + (stopStrings.length > 0 ? 1 : 0) + (collapseMessages ? 1 : 0) + (namesBehavior !== completionDefaults.namesBehavior ? 1 : 0)}</span>}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={s.accordionBody}>
          <div className={s.settingsField} style={{ flex: '1 1 140px' }}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.namesInMessages')}</span>
            <select className={s.settingsInput} style={{ cursor: 'pointer' }} value={namesBehavior} onChange={e => onSaveCompletion({ namesBehavior: parseInt(e.target.value) })}>
              {namesBehaviorOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <span className={s.settingsHint}>{t('settings.namesHint')}</span>
          </div>
          <div className={s.settingsField}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.seed')}</span>
              <button className={s.resetBtn} onClick={() => onSave({ seed: -1 })} title={t('settings.seedRandom')} type="button">
                <Dice1 size={7} /> {t('settings.random')}
              </button>
            </div>
            <NumberStepper value={seed} min={-1} onChange={(v) => handleSeedChange(String(v ?? -1))} placeholder={t('settings.seedPlaceholder')} />
            <span className={s.settingsHint}>{t('settings.seedHint')}</span>
          </div>
          <div className={s.settingsField}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.customStopStrings')}</span>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input className={s.settingsInput} style={{ flex: 1 }} value={stopInput} onChange={e => setStopInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStopString() } }} placeholder={t('settings.stopPlaceholder')} />
              <button className={s.btn} style={{ padding: '4px 8px', fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))' }} onClick={handleAddStopString} type="button">
                <Plus size={10} />
              </button>
            </div>
            {stopStrings.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                {stopStrings.map((str, i) => (
                  <span key={i} className={s.stopStringTag}>
                    {JSON.stringify(str)}
                    <button className={s.stopStringRemove} onClick={() => handleRemoveStopString(i)} type="button"><X size={10} /></button>
                  </span>
                ))}
              </div>
            )}
            <span className={s.settingsHint}>{t('settings.stopHint')}</span>
          </div>
          <div className={s.settingsField}>
            <Toggle.Checkbox checked={collapseMessages} onChange={v => onSave({ collapseMessages: v })} label={t('settings.collapseMessages')} hint={t('settings.collapseHint')} />
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// CONTEXT METER
// ============================================================================

function ContextMeter() {
  const { t } = useLb()
  const breakdownCache = __contextMeterStore((s) => s.breakdownCache)
  const activeChatId = __contextMeterStore((s) => s.activeChatId)
  const messages = __contextMeterStore((s) => s.messages)
  const openModal = __contextMeterStore((s) => s.openModal)

  // Find latest message breakdown for the active chat
  const latestBreakdown = useMemo(() => {
    if (!activeChatId || !messages.length) return null
    // Walk messages from newest to find one with cached breakdown
    for (let i = messages.length - 1; i >= 0; i--) {
      const bd = breakdownCache[messages[i].id]
      if (bd) return { messageId: messages[i].id, data: bd }
    }
    return null
  }, [breakdownCache, activeChatId, messages])

  if (!latestBreakdown) {
    return (
      <div className={s.contextMeter}>
        <span>{t('context.na')}</span>
      </div>
    )
  }

  const { data, messageId } = latestBreakdown
  const groups = __groupBreakdownEntries(data.entries)
  const total = data.totalTokens
  const max = data.maxContext || 0
  const pct = max > 0 ? ((total / max) * 100).toFixed(1) : null

  return (
    <div
      className={s.contextMeter}
      style={{ cursor: 'pointer' }}
      onClick={() => openModal('promptItemizer', { messageId })}
      title={t('context.breakdownTitle')}
    >
      <div className={s.contextBar}>
        {groups.map((g) => {
          const segPct = total > 0 ? (g.tokens / total) * 100 : 0
          if (segPct < 1) return null
          return (
            <div
              key={g.id}
              className={s.contextBarSegment}
              style={{ width: `${segPct}%`, background: g.color }}
            />
          )
        })}
      </div>
      <span className={s.contextLabel}>
        {total.toLocaleString()}{max > 0 ? ` / ${max.toLocaleString()} (${pct}%)` : t('tokens')}
      </span>
    </div>
  )
}

// ============================================================================
// MAIN LOOM BUILDER COMPONENT
// ============================================================================

interface LoomBuilderProps {
  compact?: boolean
}

export default function LoomBuilder({
 compact = true }: LoomBuilderProps) {
  const { t: lb } = useLb()
  const { t: tc } = useTranslation('common')
  const { addableMarkers, markerLabel, markerSectionLabel } = useLoomOptionLabels()
  const {
    registry,
    activePresetId,
    activePreset,
    isLoading,
    availableMacros,
    refreshMacros,
    connectionProfile,
    refreshConnectionProfile,
    SAMPLER_PARAMS: samplerParams,
    createPreset,
    selectPreset,
    saveBlocks,
    deletePreset,
    duplicatePreset,
    renamePreset,
    addBlock,
    removeBlock,
    updateBlock,
    toggleBlock,
    saveSamplerOverrides,
    saveCustomBody,
    savePromptBehavior,
    saveCompletionSettings,
    saveAdvancedSettings,
    savePromptVariableValues,
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  } = useLoomBuilder()

  const presetProfiles = usePresetProfiles(activePresetId, activePreset?.blocks)
  const addToast = __contextMeterStore((s) => s.addToast)
  const activePresetRef = useRef(activePreset)
  const suppressNextProfileApplyRef = useRef<string | null>(null)

  const getProfileContextKey = useCallback(() => (
    `${activePresetRef.current?.id ?? 'none'}:${presetProfiles.activeChatId ?? 'none'}:${presetProfiles.activeCharacterId ?? 'none'}:${presetProfiles.activeProfileId ?? 'none'}`
  ), [presetProfiles.activeChatId, presetProfiles.activeCharacterId, presetProfiles.activeProfileId])

  const captureDefaults = useCallback(() => {
    suppressNextProfileApplyRef.current = getProfileContextKey()
    void presetProfiles.captureDefaults()
  }, [getProfileContextKey, presetProfiles])

  const reapplyDefaults = useCallback(() => {
    const binding = presetProfiles.defaults
    if (!binding || !activePreset?.blocks?.length) return

    const updatedBlocks = activePreset.blocks.map(b =>
      b.id in binding.block_states ? { ...b, enabled: binding.block_states[b.id] } : b
    )

    const changed = updatedBlocks.some((b, i) => b.enabled !== activePreset.blocks[i].enabled)
    if (changed) {
      saveBlocks(updatedBlocks)
      addToast({ type: 'success', message: lb('profiles.reapplied') })
    } else {
      addToast({ type: 'info', message: lb('profiles.alreadyDefault') })
    }
  }, [presetProfiles.defaults, activePreset, saveBlocks, addToast])

  // Apply the resolved preset profile binding to the active preset's blocks
  // whenever the chat/character context changes and the hook confirms its
  // binding state is fresh for that new context (isResolved). Keying off
  // activeChatId + activeCharacterId — not just the binding reference —
  // guarantees the effect re-runs on every chat switch, even when two
  // characters happen to share structurally-identical block states.
  //
  // activePreset is read through a ref so user-driven block toggles (which
  // mutate activePreset) don't re-fire this effect and fight the toggle by
  // re-applying the binding.
  const lastProfileContextRef = useRef<string | null>(null)
  activePresetRef.current = activePreset

  useEffect(() => {
    if (!presetProfiles.isResolved) return

    const contextKey = `${activePresetRef.current?.id ?? 'none'}:${presetProfiles.activeChatId ?? 'none'}:${presetProfiles.activeCharacterId ?? 'none'}:${presetProfiles.activeProfileId ?? 'none'}`
    const contextChanged = lastProfileContextRef.current !== contextKey

    if (
      presetProfiles.resolvedPresetId
      && presetProfiles.resolvedPresetId !== activePresetRef.current?.id
      && (contextChanged || !activePresetRef.current?.id)
    ) {
      presetProfiles.selectResolvedPreset()
      return
    }

    const binding = presetProfiles.activeBinding
    const currentBlocks = activePresetRef.current?.blocks
    if (!binding || !currentBlocks?.length) return

    if (!contextChanged) return
    if (suppressNextProfileApplyRef.current === contextKey) {
      suppressNextProfileApplyRef.current = null
      lastProfileContextRef.current = contextKey
      markLoomRuntimeProfileContext(activePresetRef.current?.id, presetProfiles.activeChatId, presetProfiles.activeCharacterId, presetProfiles.activeProfileId)
      return
    }
    lastProfileContextRef.current = contextKey
    markLoomRuntimeProfileContext(activePresetRef.current?.id, presetProfiles.activeChatId, presetProfiles.activeCharacterId, presetProfiles.activeProfileId)

    const updatedBlocks = currentBlocks.map(b =>
      b.id in binding.block_states ? { ...b, enabled: binding.block_states[b.id] } : b
    )

    const changed = updatedBlocks.some((b, i) => b.enabled !== currentBlocks[i].enabled)
    if (changed) {
      saveBlocks(updatedBlocks)
    }
  }, [
    presetProfiles.isResolved,
    presetProfiles.resolvedPresetId,
    presetProfiles.selectResolvedPreset,
    presetProfiles.activeBinding,
    presetProfiles.activeSource,
    presetProfiles.activeChatId,
    presetProfiles.activeCharacterId,
    presetProfiles.activeProfileId,
    activePreset?.id,
    saveBlocks,
  ])

  const [view, setView] = useState<'list' | 'edit'>('list')
  const [editingBlock, setEditingBlock] = useState<PromptBlock | null>(null)
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const [markerMenuOpen, setMarkerMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmDeletePreset, setConfirmDeletePreset] = useState(false)
  const [showLegacyExportConfirm, setShowLegacyExportConfirm] = useState(false)
  const [showPromptVariablesModal, setShowPromptVariablesModal] = useState(false)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const configurableVariableCount = useMemo(() => {
    return (activePreset?.blocks ?? []).reduce((count, b) => {
      if (!b.enabled || !Array.isArray(b.variables)) return count
      return count + b.variables.filter((v) => v && v.name).length
    }, 0)
  }, [activePreset?.blocks])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTypeRef = useRef<string>('json')
  const lastCollapsedPresetRef = useRef<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const trimmedSearchQuery = searchQuery.trim()
  const deferredTrimmedSearchQuery = deferredSearchQuery.trim()
  const isSearchVisible = isSearchOpen || trimmedSearchQuery.length > 0

  // Track scroll position so we can restore it after state-driven re-renders
  // (block saves, toggles, reorders) and after returning from the block editor.
  const handleScrollCapture = useCallback(() => {
    if (scrollAreaRef.current) scrollTopRef.current = scrollAreaRef.current.scrollTop
  }, [])

  // Restore scroll position after the DOM updates from block/preset changes or
  // switching back from the block-edit view. useLayoutEffect fires before paint
  // so the user never sees a scroll jump.
  useLayoutEffect(() => {
    if (scrollAreaRef.current && scrollTopRef.current > 0) {
      scrollAreaRef.current.scrollTop = scrollTopRef.current
    }
  }, [activePreset?.blocks, view])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const groups = useMemo(() => computeGroups(activePreset?.blocks), [activePreset?.blocks])

  const searchTokens = useMemo(
    () => deferredTrimmedSearchQuery.toLowerCase().split(/\s+/).filter(Boolean),
    [deferredTrimmedSearchQuery],
  )

  const searchableBlockText = useMemo(() => {
    const entries = (activePreset?.blocks ?? [])
      .filter((block) => block.marker !== 'category')
      .map((block) => [block.id, `${block.name}\n${block.content || ''}`.toLowerCase()] as const)
    return new Map(entries)
  }, [activePreset?.blocks])

  const isSearchActive = searchTokens.length > 0

  const displayedGroups = useMemo<CategoryGroup[]>(() => {
    if (!isSearchActive) return groups

    return groups
      .map((group) => ({
        ...group,
        children: group.children.filter((block) => {
          const searchableText = searchableBlockText.get(block.id) ?? ''
          return searchTokens.every((token) => searchableText.includes(token))
        }),
      }))
      .filter((group) => group.children.length > 0)
  }, [groups, isSearchActive, searchableBlockText, searchTokens])

  const searchMatchCount = useMemo(
    () => displayedGroups.reduce((count, group) => count + group.children.length, 0),
    [displayedGroups],
  )

  useEffect(() => {
    if (activePreset?.blocks && activePresetId && activePresetId !== lastCollapsedPresetRef.current) {
      lastCollapsedPresetRef.current = activePresetId
      const categoryIds = activePreset.blocks.filter(b => b.marker === 'category').map(b => b.id)
      setCollapsedCategories(new Set(categoryIds))
    }
  }, [activePresetId, activePreset])

  useEffect(() => {
    setIsSearchOpen(false)
    setSearchQuery('')
  }, [activePresetId])

  useEffect(() => {
    if (!isSearchVisible) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isSearchVisible])

  const visibleBlockIds = useMemo(() => {
    const ids: string[] = []
    for (const group of displayedGroups) {
      if (group.categoryBlock) {
        ids.push(group.categoryBlock.id)
        if (isSearchActive || !collapsedCategories.has(group.categoryBlock.id)) {
          for (const child of group.children) ids.push(child.id)
        }
      } else {
        for (const child of group.children) ids.push(child.id)
      }
    }
    return ids
  }, [displayedGroups, collapsedCategories, isSearchActive])

  const toggleCollapse = useCallback((categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }, [])

  const toggleSearch = useCallback(() => {
    if (isSearchVisible) {
      setSearchQuery('')
      setIsSearchOpen(false)
      return
    }
    setIsSearchOpen(true)
  }, [isSearchVisible])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }, [])

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (trimmedSearchQuery.length > 0) {
      setSearchQuery('')
      return
    }
    setIsSearchOpen(false)
  }, [trimmedSearchQuery])

  const handleDragEnd = useCallback((event: any) => {
    const { active, over } = event
    if (!over || active.id === over.id || !activePreset) return

    const blocks = activePreset.blocks
    const draggedBlock = blocks.find(b => b.id === active.id)
    if (!draggedBlock) return

    if (draggedBlock.marker === 'category') {
      const catIdx = blocks.findIndex(b => b.id === active.id)
      let endIdx = blocks.length
      for (let i = catIdx + 1; i < blocks.length; i++) {
        if (blocks[i].marker === 'category') { endIdx = i; break }
      }
      const group = blocks.slice(catIdx, endIdx)
      const remaining = [...blocks.slice(0, catIdx), ...blocks.slice(endIdx)]
      const overIdx = remaining.findIndex(b => b.id === over.id)
      if (overIdx === -1) return
      remaining.splice(overIdx, 0, ...group)
      saveBlocks(remaining)
    } else {
      const oldIndex = blocks.findIndex(b => b.id === active.id)
      const newIndex = blocks.findIndex(b => b.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      saveBlocks(arrayMove(blocks, oldIndex, newIndex))
    }
  }, [activePreset, saveBlocks])

  const handleEdit = useCallback((block: PromptBlock) => {
    setEditingBlock(block)
    setView('edit')
  }, [])

  const handleEditSave = useCallback((updates: Partial<PromptBlock>) => {
    if (editingBlock) updateBlock(editingBlock.id, updates)
    setView('list')
    setEditingBlock(null)
  }, [editingBlock, updateBlock])

  const handleAddTemplate = useCallback((template: { name: string; content: string; role: string }) => {
    addBlock(createBlock({ name: template.name, content: template.content, role: template.role as PromptBlock['role'] }))
    setPromptMenuOpen(false)
  }, [addBlock])

  const handleAddCategory = useCallback(() => {
    addBlock(createMarkerBlock('category', lb('actions.newCategory')))
  }, [addBlock])

  const handleAddMarker = useCallback((type: string) => {
    addBlock(createMarkerBlock(type))
    setMarkerMenuOpen(false)
  }, [addBlock])

  const handleDelete = useCallback((blockId: string) => {
    setConfirmDelete(blockId)
  }, [])

  const confirmDeleteBlock = useCallback(() => {
    if (confirmDelete) {
      removeBlock(confirmDelete)
      setConfirmDelete(null)
    }
  }, [confirmDelete, removeBlock])

  const handleRenamePreset = useCallback(async (newName: string) => {
    if (!activePresetId) return
    await renamePreset(activePresetId, newName)
  }, [activePresetId, renamePreset])

  const handleDuplicatePreset = useCallback(async () => {
    if (!activePreset || !activePresetId) return
    await duplicatePreset(activePresetId, `${activePreset.name}${lb('preset.copySuffix')}`)
  }, [activePreset, activePresetId, duplicatePreset])

  const handleDeletePreset = useCallback(async () => {
    if (!activePresetId) return
    setConfirmDeletePreset(false)
    await deletePreset(activePresetId)
  }, [activePresetId, deletePreset])

  const handleExport = useCallback(async () => {
    try {
      const data = await exportInternal()
      if (!data) return
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${data.name || 'loom-preset'}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || lb('toast.exportFailed'))
    }
  }, [exportInternal])

  const handleExportLegacy = useCallback(() => {
    const data = exportLegacy()
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(data as any).name || 'preset'}.json`
    a.click()
    URL.revokeObjectURL(url)
    setShowLegacyExportConfirm(false)
  }, [exportLegacy])

  const handleImport = useCallback((type: string) => {
    importTypeRef.current = type
    fileInputRef.current?.click()
  }, [])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      if (importTypeRef.current === 'st') {
        await importFromST(json, file.name)
      } else {
        await importFromFile(json, file.name)
      }
    } catch (err) {
      console.error('[LoomBuilder] Import failed:', err)
    }
    e.target.value = ''
  }, [importFromFile, importFromST])

  // Edit view
  if (view === 'edit' && editingBlock) {
    return (
      <BlockEditor
        block={editingBlock}
        onSave={handleEditSave}
        onBack={() => { setView('list'); setEditingBlock(null) }}
        availableMacros={availableMacros}
        refreshMacros={refreshMacros}
        compact={compact}
      />
    )
  }

  // List view
  return (
    <PanelFadeIn>
      <div className={clsx(s.layout, compact && s.layoutCompact)}>
        {/* Preset Selector */}
        <div className={s.toolbar}>
          <PresetSelector
            registry={registry}
            activePresetId={activePresetId}
            activePresetName={activePreset?.name ?? null}
            onSelect={selectPreset}
            onCreate={createPreset}
            onRename={handleRenamePreset}
            onDuplicate={handleDuplicatePreset}
            onDelete={() => setConfirmDeletePreset(true)}
            onImport={handleImport}
            onExport={handleExport}
            onExportLegacy={() => setShowLegacyExportConfirm(true)}
          />
          <button
            type="button"
            className={clsx(s.btn, s.searchToggle, isSearchVisible && s.searchToggleActive)}
            onClick={toggleSearch}
            disabled={!activePreset}
            title={isSearchVisible ? lb('search.closeTitle') : lb('search.openTitle')}
          >
            <Search size={14} />
            {isSearchVisible ? lb('search.close') : lb('search.search')}
          </button>
          {activePreset && isSearchVisible && (
            <div className={s.searchBarRow}>
              <div className={s.searchField}>
                <Search size={14} className={s.searchIcon} />
                <input
                  ref={searchInputRef}
                  className={s.searchInput}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={lb('search.placeholder')}
                  inputMode="search"
                  enterKeyHint="search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {trimmedSearchQuery.length > 0 && (
                  <button type="button" className={s.searchClear} onClick={clearSearch} title={lb('search.clearTitle')}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className={s.searchMeta}>
                {isSearchActive
                  ? lb('search.matches', { count: searchMatchCount })
                  : lb('search.hint')}
              </div>
            </div>
          )}
        </div>

      {activePreset && <PresetCoverHeader preset={activePreset} />}

      {/* Connection profile */}
      {activePreset && connectionProfile && (() => {
        const { sourceName, modelName } = formatProfileLabel(connectionProfile)
        return (
          <div className={s.connectionProfile} title={connectionProfile.model ? `${sourceName} \u2022 ${connectionProfile.model}` : sourceName}>
            <Wifi size={10} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0, opacity: 0.7 }} />
            <span className={s.connectionSource}>{sourceName}</span>
            {modelName && (
              <>
                <span className={s.connectionDot}>{'\u2022'}</span>
                <span className={s.connectionModel}>{modelName}</span>
              </>
            )}
          </div>
        )
      })()}

      {/* Preset Profile Bindings */}
      {activePreset && (
        <div className={s.profileBar}>
          <span className={s.profileLabel}>{lb('profiles.label')}</span>
          <div className={s.profileBtnGroup}>
            {/* Capture / clear defaults */}
            {!presetProfiles.hasDefaults ? (
              <button
                className={s.profileBtn}
                onClick={captureDefaults}
                disabled={presetProfiles.isLoading}
                title={lb('profiles.captureTitle')}
                type="button"
              >
                <Camera size={10} /> {lb('profiles.capture')}
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={reapplyDefaults}
                disabled={presetProfiles.isLoading}
                title={lb('profiles.reapplyTitle')}
                type="button"
              >
                <RotateCcw size={10} /> {lb('profiles.default')}
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.clearDefaults() }}
                  title={lb('profiles.clearDefaultsTitle')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            )}

            {/* Bind / unbind character — hidden in group chats (chat-only) */}
            {presetProfiles.characterBindingEnabled && (!presetProfiles.hasCharacterBinding ? (
              <button
                className={s.profileBtn}
                onClick={presetProfiles.bindToCharacter}
                disabled={!presetProfiles.hasDefaults || presetProfiles.isLoading || !activePreset || !presetProfiles.activeCharacterId}
                title={
                  !presetProfiles.activeCharacterId ? lb('profiles.noCharacter')
                    : !presetProfiles.hasDefaults ? lb('profiles.captureFirst')
                      : lb('profiles.bindCharacter')
                }
                type="button"
              >
                <Link size={10} /> {lb('profiles.character')}
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={presetProfiles.bindToCharacter}
                disabled={presetProfiles.isLoading || !presetProfiles.activeCharacterId}
                title={lb('profiles.rebindCharacter')}
                type="button"
              >
                <RotateCcw size={10} /> {lb('profiles.character')}
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.unbindCharacter() }}
                  title={lb('profiles.removeCharacter')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            ))}

            {/* Bind / unbind chat */}
            {!presetProfiles.hasChatBinding ? (
              <button
                className={s.profileBtn}
                onClick={presetProfiles.bindToChat}
                disabled={!presetProfiles.hasDefaults || presetProfiles.isLoading || !activePreset || !presetProfiles.activeChatId}
                title={
                  !presetProfiles.activeChatId ? lb('profiles.noChat')
                    : !presetProfiles.hasDefaults ? lb('profiles.captureFirst')
                      : lb('profiles.bindChat')
                }
                type="button"
              >
                <Link size={10} /> {lb('profiles.chat')}
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={presetProfiles.bindToChat}
                disabled={presetProfiles.isLoading || !presetProfiles.activeChatId}
                title={lb('profiles.rebindChat')}
                type="button"
              >
                <RotateCcw size={10} /> {lb('profiles.chat')}
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.unbindChat() }}
                  title={lb('profiles.removeChat')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            )}

            {/* Bind / unbind connection profile */}
            {!presetProfiles.hasConnectionBinding ? (
              <button
                className={s.profileBtn}
                onClick={presetProfiles.bindToConnection}
                disabled={!presetProfiles.hasDefaults || presetProfiles.isLoading || !activePreset || !presetProfiles.activeProfileId}
                title={
                  !presetProfiles.activeProfileId ? lb('profiles.noConnection')
                    : !presetProfiles.hasDefaults ? lb('profiles.captureFirst')
                      : lb('profiles.bindConnection')
                }
                type="button"
              >
                <Link size={10} /> {lb('profiles.conn')}
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={presetProfiles.bindToConnection}
                disabled={presetProfiles.isLoading || !presetProfiles.activeProfileId}
                title={lb('profiles.rebindConnection')}
                type="button"
              >
                <RotateCcw size={10} /> {lb('profiles.conn')}
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.unbindConnection() }}
                  title={lb('profiles.removeConnection')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            )}
          </div>

          {/* Active source indicator */}
          {presetProfiles.activeSource !== 'none' && (
            <span className={s.profileSourceBadge}>
              {presetProfiles.activeSource === 'chat' ? lb('profiles.sourceChat') :
               presetProfiles.activeSource === 'character' ? lb('profiles.sourceCharacter') :
               presetProfiles.activeSource === 'connection' ? lb('profiles.sourceConnection') : lb('profiles.sourceDefault')}
            </span>
          )}
        </div>
      )}

      {/* Scrollable content: settings + block list */}
      <div className={s.scrollArea} ref={scrollAreaRef} onScroll={handleScrollCapture}>
        {/* Settings accordion sections */}
        {activePreset && (
          <GenerationSettings
            samplerOverrides={activePreset.samplerOverrides}
            customBody={activePreset.customBody}
            connectionProfile={connectionProfile}
            samplerParams={samplerParams}
            onSaveSamplers={saveSamplerOverrides}
            onSaveCustomBody={saveCustomBody}
            onRefreshProfile={refreshConnectionProfile}
          />
        )}
        {activePreset && <PromptBehaviorSettings promptBehavior={activePreset.promptBehavior} onSave={savePromptBehavior} />}
        {activePreset && <CompletionSettingsPanel completionSettings={activePreset.completionSettings} onSave={saveCompletionSettings} />}
        {activePreset && <AdvancedSettingsPanel advancedSettings={activePreset.advancedSettings} completionSettings={activePreset.completionSettings} onSave={saveAdvancedSettings} onSaveCompletion={saveCompletionSettings} />}
        {activePreset && <ContextMeter />}

        {activePreset && configurableVariableCount > 0 && (
          <div className={s.variablesAction}>
            <button
              type="button"
              className={clsx(s.btn, s.variablesBtn)}
              onClick={() => setShowPromptVariablesModal(true)}
            >
              <Braces size={14} />
              <span>{lb('actions.configureVariables')}</span>
              <span className={s.accordionBadge}>{configurableVariableCount}</span>
            </button>
          </div>
        )}

        {/* Block list or empty state */}
        <div className={s.blockList}>
          {isLoading ? (
            <div className={s.emptyState}>{lb('empty.loading')}</div>
          ) : !activePreset ? (
            <div className={s.emptyState}>
              <Layers size={40} style={{ opacity: 0.3 }} />
              <div style={{ fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))', fontWeight: 500 }}>{lb('empty.noPresetTitle')}</div>
              <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))' }}>{lb('empty.noPresetHint')}</div>
            </div>
          ) : activePreset.blocks.length === 0 ? (
            <div className={s.emptyState}>
              <div style={{ fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))' }}>{lb('empty.noBlocksTitle')}</div>
              <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))' }}>{lb('empty.noBlocksHint')}</div>
            </div>
          ) : isSearchActive && searchMatchCount === 0 ? (
            <div className={s.emptyState}>
              <Search size={32} style={{ opacity: 0.3 }} />
              <div style={{ fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))', fontWeight: 500 }}>{lb('empty.noSearchTitle')}</div>
              <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))' }}>{lb('empty.noSearchHint')}</div>
              <button type="button" className={s.btn} onClick={clearSearch}>{lb('empty.clearSearch')}</button>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visibleBlockIds} strategy={verticalListSortingStrategy}>
                {displayedGroups.map(group => (
                  <Fragment key={group.categoryBlock?.id || 'ungrouped'}>
                    {group.categoryBlock && (
                      <SortableCategoryItem
                        block={group.categoryBlock}
                        isCollapsed={isSearchActive ? false : collapsedCategories.has(group.categoryBlock.id)}
                        onToggleCollapse={isSearchActive ? () => {} : () => toggleCollapse(group.categoryBlock!.id)}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onToggle={toggleBlock}
                        childCount={group.children.length}
                        dragDisabled={isSearchActive}
                      />
                    )}
                    {(!group.categoryBlock || isSearchActive || !collapsedCategories.has(group.categoryBlock.id)) &&
                      group.children.map(block => (
                        <SortableBlockItem
                          key={block.id}
                          block={block}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onToggle={toggleBlock}
                          indented={!!group.categoryBlock}
                          dragDisabled={isSearchActive}
                        />
                      ))
                    }
                  </Fragment>
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {/* Action bar */}
      {activePreset && (
        <div className={s.actionBar}>
          <div style={{ position: 'relative' }}>
            <button className={clsx(s.btn, s.btnPrimary)} onClick={() => { setPromptMenuOpen(!promptMenuOpen); setMarkerMenuOpen(false) }} type="button">
              <Plus size={14} /> {lb('actions.addPrompt')} <ChevronDown size={12} />
            </button>
            {promptMenuOpen && (
              <div className={s.dropdownMenu} style={{ bottom: '100%', left: 0, marginBottom: '4px' }}>
                {PROMPT_TEMPLATES.map((item, i) => {
                  if ('section' in item && item.section) {
                    return (
                      <div key={item.section}>
                        {i > 0 && <hr className={s.menuDivider} />}
                        <div className={s.sectionLabel}>{item.section}</div>
                      </div>
                    )
                  }
                  if ('name' in item && item.name) {
                    return (
                      <MenuButton
                        key={item.name}
                        icon={item.content ? <Zap size={14} style={{ opacity: 0.5 }} /> : <FileText size={14} style={{ opacity: 0.5 }} />}
                        label={item.name}
                        onClick={() => handleAddTemplate(item as { name: string; content: string; role: string })}
                      />
                    )
                  }
                  return null
                })}
              </div>
            )}
          </div>

          <button className={s.btn} onClick={handleAddCategory} type="button">
            <ChevronRight size={14} /> {lb('actions.addCategory')}
          </button>

          <div style={{ position: 'relative' }}>
            <button className={s.btn} onClick={() => { setMarkerMenuOpen(!markerMenuOpen); setPromptMenuOpen(false) }} type="button">
              <Hash size={14} /> {lb('actions.addMarker')} <ChevronDown size={12} />
            </button>
            {markerMenuOpen && (
              <div className={s.dropdownMenu} style={{ bottom: '100%', left: 0, marginBottom: '4px', minWidth: '200px' }}>
                {addableMarkers.map((item, i) => {
                  if (typeof item === 'object' && 'section' in item) {
                    return (
                      <div key={item.section}>
                        {i > 0 && <hr className={s.menuDivider} />}
                        <div className={s.sectionLabel}>{markerSectionLabel(item.section)}</div>
                      </div>
                    )
                  }
                  return (
                    <MenuButton
                      key={item as string}
                      icon={<Hash size={14} />}
                      label={markerLabel(item as string)}
                      onClick={() => handleAddMarker(item as string)}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Hidden file input for import */}
      <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileSelect} />

      {/* Confirm legacy export */}
        <ConfirmationModal
          isOpen={showLegacyExportConfirm}
          title={lb('confirm.legacyExportTitle')}
          message={lb('confirm.legacyExportMessage')}
          variant="warning"
          confirmText={lb('confirm.exportAnyway')}
          onConfirm={handleExportLegacy}
          onCancel={() => setShowLegacyExportConfirm(false)}
        />

      {/* Confirm delete dialog */}
        <ConfirmationModal
          isOpen={!!confirmDelete}
          title={lb('confirm.deleteBlockTitle')}
          message={lb('confirm.deleteBlockMessage')}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={confirmDeleteBlock}
          onCancel={() => setConfirmDelete(null)}
        />

      {/* Confirm preset delete dialog */}
        <ConfirmationModal
          isOpen={confirmDeletePreset}
          title={lb('confirm.deletePresetTitle')}
          message={lb('confirm.deletePresetMessage', { name: activePreset?.name })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { void handleDeletePreset() }}
          onCancel={() => setConfirmDeletePreset(false)}
        />

        {activePreset && (
          <PromptVariablesModal
            isOpen={showPromptVariablesModal}
            blocks={activePreset.blocks}
            values={activePreset.promptVariables ?? {}}
            onSave={savePromptVariableValues}
            onClose={() => setShowPromptVariablesModal(false)}
          />
        )}
      </div>
    </PanelFadeIn>
  )
}
