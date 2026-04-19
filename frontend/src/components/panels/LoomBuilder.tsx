import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, type ReactNode, Fragment } from 'react'
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
import { CSS } from '@dnd-kit/utilities'
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
import ExpandedTextEditor from '@/components/shared/ExpandedTextEditor'
import { ModalShell } from '@/components/shared/ModalShell'
import { resolveMacros as resolveMacrosApi } from '@/api/macros'
import { useLoomBuilder } from '@/hooks/useLoomBuilder'
import { usePresetProfiles } from '@/hooks/usePresetProfiles'
import { computeGroups, createBlock, createMarkerBlock } from '@/lib/loom/service'
import {
  MARKER_NAMES,
  PROMPT_TEMPLATES,
  ADDABLE_MARKERS,
  INJECTION_TRIGGER_TYPES,
  PROVIDER_DISPLAY_NAMES,
  CONTINUE_POSTFIX_OPTIONS,
  NAMES_BEHAVIOR_OPTIONS,
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
} from '@/lib/loom/constants'
import type { PromptBlock, LoomConnectionProfile, SamplerParam, MacroGroup } from '@/lib/loom/types'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import NumberStepper from '@/components/shared/NumberStepper'
import { useStore as __contextMeterStore } from '@/store'
import { groupBreakdownEntries as __groupBreakdownEntries } from '@/lib/prompt-breakdown'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import { Toggle } from '@/components/shared/Toggle'
import { Button } from '@/components/shared/FormComponents'
import s from './LoomBuilder.module.css'

// ============================================================================
// HELPERS
// ============================================================================

function formatProfileLabel(connectionProfile: LoomConnectionProfile | null) {
  const sourceName = PROVIDER_DISPLAY_NAMES[connectionProfile?.source || '']
    || connectionProfile?.source
    || 'Unknown'
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
}

function SortableCategoryItem({
  block, isCollapsed, onToggleCollapse, onEdit, onDelete, onToggle, childCount,
}: SortableCategoryItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const isDisabled = !block.enabled
  const displayName = block.name.replace(/^\u2501\s*/, '')

  return (
    <div
      ref={setNodeRef}
      className={clsx(s.item, s.categoryHeader, isDragging && s.itemDragging, isDisabled && s.itemDisabled)}
      style={style}
    >
      <span {...attributes} {...listeners} className={s.dragHandle} title="Drag to reorder (moves all items in this category)">
        <GripVertical size={14} />
      </span>
      <Button size="icon-sm" variant="ghost" onClick={onToggleCollapse} title={isCollapsed ? 'Expand category' : 'Collapse category'}>
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </Button>
      <div className={s.categoryMeta} onClick={onToggleCollapse}>
        <span className={clsx(s.categoryName, s.truncTooltip)} data-tooltip={displayName}>{displayName}</span>
        <span className={s.categoryCount}>({childCount})</span>
        {block.categoryMode && (
          <span className={s.groupBadge}>
            {block.categoryMode === 'radio' ? 'pick one' : 'multi'}
          </span>
        )}
      </div>
      <Button size="icon-sm" variant="ghost" onClick={() => onToggle(block.id)} title={block.enabled ? 'Disable category' : 'Enable category'}>
        {block.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={() => onEdit(block)} title="Rename">
        <Edit2 size={14} />
      </Button>
      <Button size="icon-sm" variant="danger-ghost" onClick={() => onDelete(block.id)} title="Delete category">
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
}

function SortableBlockItem({ block, onEdit, onDelete, onToggle, indented }: SortableBlockItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const isMarker = block.marker && block.marker !== 'category'
  const isDisabled = !block.enabled
  const preview = block.content ? block.content.substring(0, 50) + (block.content.length > 50 ? '...' : '') : ''

  return (
    <div
      ref={setNodeRef}
      className={clsx(s.item, isDragging && s.itemDragging, isMarker && s.marker, indented && s.itemIndented, isDisabled && s.itemDisabled)}
      style={style}
    >
      <span {...attributes} {...listeners} className={s.dragHandle} title="Drag to reorder">
        <GripVertical size={14} />
      </span>
      <div className={clsx(s.blockContent, s.truncTooltip)} data-tooltip={block.name}>
        <div className={s.blockNameRow}>
          <span className={s.blockName}>
            {isMarker && <Hash size={12} style={{ marginRight: '4px', opacity: 0.6 }} />}
            {block.isLocked && <Lock size={10} style={{ marginRight: '4px', opacity: 0.4 }} />}
            {block.name}
          </span>
          {!isMarker && (
            <span className={clsx(s.badge, ROLE_BADGES[block.role] || s.badgeSystem)}>{ROLE_DISPLAY_LABELS[block.role] || block.role}</span>
          )}
          {isMarker && (
            <span className={clsx(s.badge, s.badgeMarker)}>marker</span>
          )}
          {block.injectionTrigger?.length > 0 && (
            <span style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
              {block.injectionTrigger.map(t => {
                const meta = INJECTION_TRIGGER_TYPES.find(tt => tt.value === t)
                return meta ? <span key={t} className={s.triggerBadge}>{meta.shortLabel}</span> : null
              })}
            </span>
          )}
        </div>
        {preview && !isMarker && <span className={s.blockPreview}>{preview}</span>}
      </div>
      <Button size="icon-sm" variant="ghost" onClick={() => onToggle(block.id)} title={block.enabled ? 'Disable' : 'Enable'}>
        {block.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={() => onEdit(block)} title="Edit">
        <Edit2 size={14} />
      </Button>
      {!block.isLocked && (
        <Button size="icon-sm" variant="danger-ghost" onClick={() => onDelete(block.id)} title="Delete">
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
  const [name, setName] = useState(block.name)
  const [role, setRole] = useState<PromptBlock['role']>(block.role || 'system')
  const [content, setContent] = useState(block.content || '')
  const [position, setPosition] = useState<PromptBlock['position']>(block.position || 'pre_history')
  const [depth, setDepth] = useState(block.depth || 0)
  const [isLocked, setIsLocked] = useState(block.isLocked || false)
  const [injectionTrigger, setInjectionTrigger] = useState<string[]>(block.injectionTrigger || [])
  const [categoryMode, setCategoryMode] = useState<PromptBlock['categoryMode']>(block.categoryMode ?? null)
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
      resolveMacrosApi({ template: content, ...(activeChatId ? { chat_id: activeChatId } : {}) })
        .then((res) => {
          setPreviewText(res.text)
          setPreviewDiagnostics(res.diagnostics)
        })
        .catch(() => {
          setPreviewText('[Preview unavailable]')
          setPreviewDiagnostics([])
        })
        .finally(() => setPreviewLoading(false))
    }, 500)
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current) }
  }, [content, showPreview, activeChatId])

  const handlePositionChange = (newPosition: string) => {
    const pos = newPosition as PromptBlock['position']
    setPosition(pos)
    const isAppend = role === 'user_append' || role === 'assistant_append'
    if (pos === 'post_history' && !isAppend && role === 'system') setRole('user')
    else if (pos === 'pre_history' && role === 'assistant') setRole('system')
  }

  const handleSave = () => {
    const isAppend = role === 'user_append' || role === 'assistant_append'
    onSave({
      name, role, content,
      position: isAppend ? 'pre_history' : position,
      depth: (position === 'in_history' || isAppend) ? depth : 0,
      isLocked, injectionTrigger,
      categoryMode: block.marker === 'category' ? categoryMode : null,
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
          <Button size="icon-sm" variant="ghost" onClick={onBack} title="Back to list"><ArrowLeft size={18} /></Button>
          <span style={{ fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))', fontWeight: 600 }}>Edit Block</span>
          <button className={clsx(s.btn, s.btnPrimary, s.btnSmall)} onClick={handleSave} type="button"><Check size={12} /> Save</button>
        </div>
      )}
      {!compact && (
        <div className={s.header}>
          <Button size="icon-sm" variant="ghost" onClick={onBack} title="Back to list"><ArrowLeft size={18} /></Button>
          <h3 className={s.title}>Edit Block</h3>
          <div style={{ flex: 1 }} />
          <button className={clsx(s.btn, s.btnPrimary)} onClick={handleSave} type="button"><Check size={14} /> Save</button>
        </div>
      )}
      <div className={s.scrollArea}>
        <div className={s.form}>
          <div className={s.formGroup}>
            <label className={s.label}>Name</label>
            <input className={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Block name" />
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div className={s.formGroup} style={{ flex: 1, minWidth: '120px' }}>
              <label className={s.label}>Role</label>
              <select className={s.select} value={role} onChange={e => setRole(e.target.value as PromptBlock['role'])}>
                {position !== 'post_history' && <option value="system">System</option>}
                <option value="user">User</option>
                <option value="assistant">Assistant</option>
                <option value="user_append">User Append</option>
                <option value="assistant_append">Assistant Append</option>
              </select>
            </div>
            {role !== 'user_append' && role !== 'assistant_append' && (
              <div className={s.formGroup} style={{ flex: 1, minWidth: '140px' }}>
                <label className={s.label}>Position</label>
                <select className={s.select} value={position} onChange={e => handlePositionChange(e.target.value)}>
                  <option value="pre_history">Before Chat History</option>
                  <option value="post_history">After Chat History</option>
                  <option value="in_history">Within Chat History</option>
                </select>
              </div>
            )}
            {(position === 'in_history' || role === 'user_append' || role === 'assistant_append') && (
              <div className={s.formGroup} style={{ width: '100px' }}>
                <label className={s.label}>Depth</label>
                <NumberStepper value={depth} min={0} onChange={(v) => setDepth(v ?? 0)} />
              </div>
            )}
            {(role === 'user_append' || role === 'assistant_append') && (
              <div className={s.postHistoryNote} style={{ width: '100%' }}>
                0 = last {role === 'user_append' ? 'user' : 'assistant'} message, 1 = second-to-last, etc.
              </div>
            )}
          </div>

          <div className={s.formGroup}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label className={s.label}>Content</label>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className={clsx(s.btn, s.btnSmall)} onClick={() => { if (!showMacros) refreshMacros?.(); setShowMacros(!showMacros) }} type="button">
                  <Hash size={12} /> {showMacros ? 'Hide Macros' : 'Insert Macro'}
                </button>
                <button className={clsx(s.btn, s.btnSmall)} onClick={() => setShowExpandedEditor(true)} title="Expand editor" type="button">
                  <Maximize2 size={12} />
                </button>
              </div>
            </div>
            {showMacros && (
              <div className={s.macroPanel}>
                <div className={s.macroSearch}>
                  <div className={s.macroSearchInner}>
                    <Search size={12} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
                    <input className={s.macroSearchInput} placeholder="Search macros..." value={macroSearch} onChange={e => setMacroSearch(e.target.value)} />
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
            <textarea ref={textareaRef} className={s.textarea} value={content} onChange={e => setContent(e.target.value)} placeholder="Enter prompt content... Use {{macros}} for dynamic content." />
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <button className={clsx(s.btn, s.btnSmall, showPreview && s.btnPrimary)} onClick={() => setShowPreview(!showPreview)} type="button">
                <Eye size={12} /> {showPreview ? 'Hide Preview' : 'Preview'}
              </button>
              {showPreview && previewLoading && <span style={{ fontSize: 'calc(10px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)' }}>Resolving...</span>}
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
                <pre className={s.previewContent}>{previewLoading ? 'Resolving...' : (previewText === '' && content ? '(Empty Output)' : previewText || 'No content to preview')}</pre>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Toggle.Checkbox checked={isLocked} onChange={setIsLocked} label={<><Lock size={14} /> Lock block (prevent accidental edits)</>} />
          </div>

          {block.marker === 'category' && (
            <div className={s.formGroup}>
              <label className={s.label}>Category Mode</label>
              <select
                className={s.select}
                value={categoryMode || ''}
                onChange={e => setCategoryMode((e.target.value || null) as PromptBlock['categoryMode'])}
              >
                <option value="">Normal toggles</option>
                <option value="checkbox">Multi-select</option>
                <option value="radio">Pick one</option>
              </select>
              <span className={s.settingsHint}>
                Applies to the blocks inside this category. Ungrouped blocks and categories left on normal toggles behave exactly as they do now.
              </span>
            </div>
          )}

          <div className={s.formGroup}>
            <label className={s.label}>Injection Triggers</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {INJECTION_TRIGGER_TYPES.map(trigger => (
                <label key={trigger.value} className={clsx(s.triggerLabel, injectionTrigger.includes(trigger.value) ? s.triggerLabelActive : s.triggerLabelInactive)}>
                  <input type="checkbox" className={s.triggerCheckbox} checked={injectionTrigger.includes(trigger.value)} onChange={() => toggleTrigger(trigger.value)} />
                  {trigger.label}
                </label>
              ))}
            </div>
            <span className={s.settingsHint}>
              {injectionTrigger.length === 0
                ? 'No triggers selected \u2014 block fires on all generation types'
                : `Block only fires on: ${injectionTrigger.join(', ')}`}
            </span>
          </div>
        </div>
      </div>
      {showExpandedEditor && (
        <ExpandedTextEditor
          value={content}
          onChange={setContent}
          onClose={() => setShowExpandedEditor(false)}
          title={name || 'Edit Block'}
          placeholder="Enter prompt content... Use {{macros}} for dynamic content."
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
        <option value="">-- Select Preset --</option>
        {registryEntries.map(([id, entry]) => (
          <option key={id} value={id}>{entry.name} ({entry.blockCount} blocks)</option>
        ))}
      </select>

      <div style={{ position: 'relative' }}>
        <Button size="icon-sm" variant="ghost" onClick={() => setShowMenu(!showMenu)} title="More options">
          <MoreVertical size={16} />
        </Button>
        {showMenu && (
          <div className={s.dropdownMenu} style={{ top: '100%', right: 0, minWidth: '160px' }}>
            <MenuButton icon={<Plus size={14} />} label="New Preset" onClick={() => { setShowCreate(true); setShowMenu(false) }} />
            {activePresetId && (
              <>
                <MenuButton icon={<Edit2 size={14} />} label="Rename" onClick={() => { setRenameName(activePresetName || ''); setShowRename(true); setShowMenu(false) }} />
                <MenuButton icon={<Copy size={14} />} label="Duplicate" onClick={() => { onDuplicate(); setShowMenu(false) }} />
                <MenuButton icon={<Download size={14} />} label="Export Loom JSON" onClick={() => { onExport(); setShowMenu(false) }} />
                <MenuButton icon={<Download size={14} />} label="Export Legacy Preset" onClick={() => { onExportLegacy(); setShowMenu(false) }} />
                <hr className={s.menuDivider} />
                <MenuButton icon={<Trash2 size={14} />} label="Delete" danger onClick={() => { onDelete(); setShowMenu(false) }} />
              </>
            )}
            <hr className={s.menuDivider} />
            <MenuButton icon={<Upload size={14} />} label="Import Legacy Preset" onClick={() => { onImport('st'); setShowMenu(false) }} />
            <MenuButton icon={<Upload size={14} />} label="Import Loom JSON" onClick={() => { onImport('json'); setShowMenu(false) }} />
          </div>
        )}
      </div>

      <ModalShell isOpen={showCreate} onClose={() => setShowCreate(false)} maxWidth="clamp(320px, 90vw, min(420px, var(--lumiverse-content-max-width, 420px)))" className={s.presetNameModal}>
        <div className={s.presetNameHeader}>
          <Plus size={16} />
          <h3 className={s.presetNameTitle}>New Loom Preset</h3>
        </div>
        <div className={s.presetNameBody}>
          <input className={s.presetNameInput} placeholder="Preset name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate()} autoFocus />
          <div className={s.presetNameActions}>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnCancel)} onClick={() => setShowCreate(false)}>Cancel</button>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnSubmit)} onClick={handleCreate} disabled={!newName.trim()}>Create</button>
          </div>
        </div>
      </ModalShell>

      <ModalShell isOpen={showRename} onClose={() => setShowRename(false)} maxWidth="clamp(320px, 90vw, min(420px, var(--lumiverse-content-max-width, 420px)))" className={s.presetNameModal}>
        <div className={s.presetNameHeader}>
          <Edit2 size={16} />
          <h3 className={s.presetNameTitle}>Rename Preset</h3>
        </div>
        <div className={s.presetNameBody}>
          <input className={s.presetNameInput} placeholder="Preset name" value={renameName} onChange={e => setRenameName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRename()} autoFocus />
          <div className={s.presetNameActions}>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnCancel)} onClick={() => setShowRename(false)}>Cancel</button>
            <button type="button" className={clsx(s.presetNameBtn, s.presetNameBtnSubmit)} onClick={handleRename} disabled={!renameName.trim()}>Rename</button>
          </div>
        </div>
      </ModalShell>
    </div>
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

function SamplerSlider({ param, value, onChange }: SamplerSliderProps) {
  const isSet = value !== null && value !== undefined
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragValueRef = useRef<number | null>(null)

  const [localValue, setLocalValue] = useState<number | null>(null)
  const currentValue = localValue !== null ? localValue : (isSet ? value! : param.defaultHint)

  const [localInput, setLocalInput] = useState(isSet ? String(value) : '')
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputEditingRef = useRef(false)

  useEffect(() => {
    if (!inputEditingRef.current) setLocalInput(isSet ? String(value) : '')
  }, [value, isSet])

  useEffect(() => () => { if (inputTimerRef.current) clearTimeout(inputTimerRef.current) }, [])

  const snap = useCallback((raw: number) => {
    const clamped = Math.min(param.max, Math.max(param.min, raw))
    const stepped = Math.round((clamped - param.min) / param.step) * param.step + param.min
    const decimals = (String(param.step).split('.')[1] || '').length
    return param.type === 'int' ? Math.round(stepped) : parseFloat(stepped.toFixed(decimals))
  }, [param.min, param.max, param.step, param.type])

  const posToValue = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return currentValue
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return snap(param.min + ratio * (param.max - param.min))
  }, [param.min, param.max, currentValue, snap])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    trackRef.current?.setPointerCapture(e.pointerId)
    const val = posToValue(e.clientX)
    dragValueRef.current = val
    setLocalValue(val)
  }, [posToValue])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const val = posToValue(e.clientX)
    dragValueRef.current = val
    setLocalValue(val)
  }, [posToValue])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    trackRef.current?.releasePointerCapture(e.pointerId)
    const final = dragValueRef.current
    dragValueRef.current = null
    setLocalValue(null)
    if (final !== null) onChange(param.key, final)
  }, [param.key, onChange])

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

  const pct = ((currentValue - param.min) / (param.max - param.min)) * 100

  return (
    <div className={s.sliderRow}>
      <div className={s.sliderHeader}>
        <span className={clsx(s.sliderLabel, isSet ? s.sliderLabelSet : s.sliderLabelUnset)}>{param.label}</span>
        <input
          type="number"
          value={localInput}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          className={clsx(s.sliderInput, isSet ? s.sliderInputSet : s.sliderInputUnset)}
          min={param.min}
          max={param.max}
          step={param.step}
          placeholder={String(param.defaultHint)}
        />
      </div>
      <div
        ref={trackRef}
        className={s.sliderTrack}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={() => onChange(param.key, null)}
        title="Double-click to reset"
        style={{ opacity: isSet ? 1 : 0.4 }}
      >
        <div className={s.sliderFill} style={{ width: `${pct}%` }} />
        <div className={s.sliderThumb} style={{ left: `${pct}%` }} />
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
    return v !== null && v !== undefined
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
        <span className={s.accordionTitle}>Generation</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
        {body.enabled && <Code2 size={10} style={{ color: 'var(--lumiverse-primary)', flexShrink: 0 }} />}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={clsx(s.accordionBody, s.accordionBodyGen)}>
          <div className={s.samplerHeader}>
            <span className={s.samplerLabel}>Samplers</span>
            <button className={s.resetBtn} onClick={handleResetSamplers} title="Reset all sampler overrides to defaults" type="button">
              <RotateCcw size={8} /> Reset
            </button>
          </div>
          {visibleParams.map(param => (
            <SamplerSlider key={param.key} param={param} value={overrides[param.key]} onChange={handleChangeParam} />
          ))}
          {visibleParams.length === 0 && (
            <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', padding: '8px 0', textAlign: 'center' }}>
              No sampler overrides available for this provider.
            </div>
          )}
          <hr className={s.menuDivider} style={{ margin: '8px 0 4px' }} />
          <div style={{ padding: '2px 0 4px' }}>
            <Toggle.Checkbox
              checked={overrides.streaming !== false}
              onChange={(v) => onSaveSamplers({ ...overrides, enabled: true, streaming: v })}
              label="Stream response"
              hint="Disable to receive the full response at once instead of token-by-token"
            />
          </div>
          <hr className={s.menuDivider} style={{ margin: '4px 0 4px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0 4px' }}>
            <span className={s.samplerLabel}>Custom Body</span>
            <Toggle.Checkbox checked={!!body.enabled} onChange={handleToggleCustomBody} label="Enabled" />
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
            <div className={s.settingsHint} style={{ marginTop: '3px' }}>Keys are spread onto the request body.</div>
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
  const [isExpanded, setIsExpanded] = useState(false)
  const behavior = promptBehavior || {}
  const defaults = DEFAULT_PROMPT_BEHAVIOR

  const activeCount = Object.keys(defaults).filter(key => {
    const current = behavior[key] ?? defaults[key as keyof typeof defaults]
    return current !== defaults[key as keyof typeof defaults]
  }).length

  const handleChange = (key: string, value: string) => onSave({ [key]: value })
  const handleRestore = (key: string) => onSave({ [key]: defaults[key as keyof typeof defaults] })

  const Field = ({ fieldKey, label, hint, multiline }: { fieldKey: string; label: string; hint?: string; multiline?: boolean }) => {
    const value = behavior[fieldKey] ?? defaults[fieldKey as keyof typeof defaults]
    const isDefault = value === defaults[fieldKey as keyof typeof defaults]
    return (
      <div className={s.settingsField}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className={clsx(s.settingsFieldLabel, isDefault ? s.settingsFieldLabelDefault : s.settingsFieldLabelModified)}>{label}</span>
          {!isDefault && (
            <button className={s.resetBtn} onClick={() => handleRestore(fieldKey)} title="Restore default" type="button">
              <RotateCcw size={7} /> Default
            </button>
          )}
        </div>
        {multiline ? (
          <textarea className={s.settingsTextarea} value={value} onChange={e => handleChange(fieldKey, e.target.value)} spellCheck={false} />
        ) : (
          <input className={s.settingsInput} value={value} onChange={e => handleChange(fieldKey, e.target.value)} />
        )}
        {hint && <span className={s.settingsHint}>{hint}</span>}
      </div>
    )
  }

  return (
    <div className={s.accordionSection}>
      <div className={clsx(s.accordionHeader, activeCount > 0 && s.accordionHeaderActive)} onClick={() => setIsExpanded(!isExpanded)}>
        <MessageSquare size={12} style={{ color: activeCount > 0 ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>Prompt Behavior</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={s.accordionBody}>
          <Field fieldKey="continueNudge" label="Continue Nudge" hint="Injected when continuing a response" multiline />
          <Field fieldKey="impersonationPrompt" label="Impersonation Prompt" hint="Injected when impersonating the user" multiline />
          <Field fieldKey="groupNudge" label="Group Nudge" hint="Injected in group chats" multiline />
          <Field fieldKey="newChatPrompt" label="New Chat Separator" hint="Inserted at conversation start" />
          <Field fieldKey="newGroupChatPrompt" label="New Group Chat Separator" hint="Inserted at group conversation start" />
          <Field fieldKey="sendIfEmpty" label="Send If Empty" hint="Sent as user message when input is empty" />
        </div>
      )}
    </div>
  )
}

// ============================================================================
// COMPLETION SETTINGS
// ============================================================================

function CompletionSettingsPanel({ completionSettings, onSave }: { completionSettings: any; onSave: (updates: Record<string, any>) => void }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const settings = completionSettings || {}
  const defaults = DEFAULT_COMPLETION_SETTINGS

  const activeCount = Object.keys(defaults).filter(key => {
    const current = settings[key] ?? defaults[key as keyof typeof defaults]
    return current !== defaults[key as keyof typeof defaults]
  }).length

  const handleChange = (key: string, value: any) => onSave({ [key]: value })

  return (
    <div className={s.accordionSection}>
      <div className={clsx(s.accordionHeader, activeCount > 0 && s.accordionHeaderActive)} onClick={() => setIsExpanded(!isExpanded)}>
        <Bot size={12} style={{ color: activeCount > 0 ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>Completion</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={s.accordionBody}>
          <div className={s.settingsField}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>Assistant Prefill</span>
            <textarea className={s.settingsTextarea} style={{ minHeight: '40px' }} value={settings.assistantPrefill ?? defaults.assistantPrefill} onChange={e => handleChange('assistantPrefill', e.target.value)} placeholder="Claude only — prepended to response" spellCheck={false} />
            <span className={s.settingsHint}>Claude only — prepended to assistant response</span>
          </div>
          <div className={s.settingsField}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>Impersonation Prefill</span>
            <textarea className={s.settingsTextarea} style={{ minHeight: '40px' }} value={settings.assistantImpersonation ?? defaults.assistantImpersonation} onChange={e => handleChange('assistantImpersonation', e.target.value)} placeholder="Claude only — prefill when impersonating" spellCheck={false} />
            <span className={s.settingsHint}>Claude only — prefill when impersonating</span>
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <Toggle.Checkbox checked={!!(settings.continuePrefill ?? defaults.continuePrefill)} onChange={v => handleChange('continuePrefill', v)} label="Continue Prefill" />
            <Toggle.Checkbox checked={!!(settings.squashSystemMessages ?? defaults.squashSystemMessages)} onChange={v => handleChange('squashSystemMessages', v)} label="Squash System Messages" />
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div className={s.settingsField} style={{ flex: '1 1 140px' }}>
              <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>Continue Postfix</span>
              <select className={s.settingsInput} style={{ cursor: 'pointer' }} value={settings.continuePostfix ?? defaults.continuePostfix} onChange={e => handleChange('continuePostfix', e.target.value)}>
                {CONTINUE_POSTFIX_OPTIONS.map(opt => <option key={opt.label} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div className={s.settingsField} style={{ flex: '1 1 140px' }}>
              <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>Names in Messages</span>
              <select className={s.settingsInput} style={{ cursor: 'pointer' }} value={settings.namesBehavior ?? defaults.namesBehavior} onChange={e => handleChange('namesBehavior', parseInt(e.target.value))}>
                {NAMES_BEHAVIOR_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
          </div>
          <hr className={s.menuDivider} />
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <Toggle.Checkbox checked={!!(settings.useSystemPrompt ?? defaults.useSystemPrompt)} onChange={v => handleChange('useSystemPrompt', v)} label="Use System Prompt" />
            <Toggle.Checkbox checked={!!(settings.enableWebSearch ?? defaults.enableWebSearch)} onChange={v => handleChange('enableWebSearch', v)} label="Enable Web Search" />
            <Toggle.Checkbox checked={!!(settings.sendInlineMedia ?? defaults.sendInlineMedia)} onChange={v => handleChange('sendInlineMedia', v)} label="Send Inline Media" />
            <Toggle.Checkbox checked={!!(settings.enableFunctionCalling ?? defaults.enableFunctionCalling)} onChange={v => handleChange('enableFunctionCalling', v)} label="Enable Function Calling" />
            <Toggle.Checkbox checked={!!(settings.includeUsage ?? defaults.includeUsage)} onChange={v => handleChange('includeUsage', v)} label="Include Usage" />
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// ADVANCED SETTINGS
// ============================================================================

function AdvancedSettingsPanel({ advancedSettings, onSave }: { advancedSettings: any; onSave: (updates: Record<string, any>) => void }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [stopInput, setStopInput] = useState('')
  const settings = advancedSettings || {}
  const defaults = DEFAULT_ADVANCED_SETTINGS

  const seed = settings.seed ?? defaults.seed
  const stopStrings: string[] = settings.customStopStrings ?? defaults.customStopStrings
  const collapseMessages: boolean = settings.collapseMessages ?? defaults.collapseMessages

  const isActive = seed >= 0 || stopStrings.length > 0 || collapseMessages

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
        <span className={s.accordionTitle}>Advanced</span>
        {isActive && <span className={s.accordionBadge}>{(seed >= 0 ? 1 : 0) + (stopStrings.length > 0 ? 1 : 0) + (collapseMessages ? 1 : 0)}</span>}
        {isExpanded ? <ChevronDown size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />}
      </div>
      {isExpanded && (
        <div className={s.accordionBody}>
          <div className={s.settingsField}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>Seed</span>
              <button className={s.resetBtn} onClick={() => onSave({ seed: -1 })} title="Set to random (-1)" type="button">
                <Dice1 size={7} /> Random
              </button>
            </div>
            <NumberStepper value={seed} min={-1} onChange={(v) => handleSeedChange(String(v ?? -1))} placeholder="-1 (random)" />
            <span className={s.settingsHint}>-1 = random seed</span>
          </div>
          <div className={s.settingsField}>
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>Custom Stop Strings</span>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input className={s.settingsInput} style={{ flex: 1 }} value={stopInput} onChange={e => setStopInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStopString() } }} placeholder="Type and press Enter" />
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
            <span className={s.settingsHint}>Appended to the request stop sequences</span>
          </div>
          <div className={s.settingsField}>
            <Toggle.Checkbox checked={collapseMessages} onChange={v => onSave({ collapseMessages: v })} label="Collapse into single user message" hint="Merges all prompt blocks and chat history into one user message. Use with &quot;Names in Messages: In Content&quot; for turn separation." />
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
        <span>Context: N/A</span>
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
      title="Click to view full prompt breakdown"
    >
      <div className={s.contextBar}>
        {groups.map((g) => {
          const segPct = total > 0 ? (g.tokens / total) * 100 : 0
          if (segPct < 1) return null
          return (
            <div
              key={g.label}
              className={s.contextBarSegment}
              style={{ width: `${segPct}%`, background: g.color }}
            />
          )
        })}
      </div>
      <span className={s.contextLabel}>
        {total.toLocaleString()}{max > 0 ? ` / ${max.toLocaleString()} (${pct}%)` : ' tokens'}
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

export default function LoomBuilder({ compact = true }: LoomBuilderProps) {
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
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  } = useLoomBuilder()

  const presetProfiles = usePresetProfiles(activePresetId, activePreset?.blocks)
  const addToast = __contextMeterStore((s) => s.addToast)

  const reapplyDefaults = useCallback(() => {
    const binding = presetProfiles.defaults
    if (!binding || !activePreset?.blocks?.length) return

    const updatedBlocks = activePreset.blocks.map(b =>
      b.id in binding.block_states ? { ...b, enabled: binding.block_states[b.id] } : b
    )

    const changed = updatedBlocks.some((b, i) => b.enabled !== activePreset.blocks[i].enabled)
    if (changed) {
      saveBlocks(updatedBlocks)
      addToast({ type: 'success', message: 'Default profile reapplied' })
    } else {
      addToast({ type: 'info', message: 'Block states already match defaults' })
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
  const activePresetRef = useRef(activePreset)
  activePresetRef.current = activePreset

  useEffect(() => {
    if (!presetProfiles.isResolved) return
    const binding = presetProfiles.activeBinding
    const currentBlocks = activePresetRef.current?.blocks
    if (!binding || !currentBlocks?.length) return

    const updatedBlocks = currentBlocks.map(b =>
      b.id in binding.block_states ? { ...b, enabled: binding.block_states[b.id] } : b
    )

    const changed = updatedBlocks.some((b, i) => b.enabled !== currentBlocks[i].enabled)
    if (changed) {
      saveBlocks(updatedBlocks)
    }
  }, [
    presetProfiles.isResolved,
    presetProfiles.activeBinding,
    presetProfiles.activeChatId,
    presetProfiles.activeCharacterId,
    activePreset?.id,
    saveBlocks,
  ])

  const [view, setView] = useState<'list' | 'edit'>('list')
  const [editingBlock, setEditingBlock] = useState<PromptBlock | null>(null)
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const [markerMenuOpen, setMarkerMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [showLegacyExportConfirm, setShowLegacyExportConfirm] = useState(false)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTypeRef = useRef<string>('json')
  const lastCollapsedPresetRef = useRef<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)

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

  useEffect(() => {
    if (activePreset?.blocks && activePresetId && activePresetId !== lastCollapsedPresetRef.current) {
      lastCollapsedPresetRef.current = activePresetId
      const categoryIds = activePreset.blocks.filter(b => b.marker === 'category').map(b => b.id)
      setCollapsedCategories(new Set(categoryIds))
    }
  }, [activePresetId, activePreset])

  const visibleBlockIds = useMemo(() => {
    const ids: string[] = []
    for (const group of groups) {
      if (group.categoryBlock) {
        ids.push(group.categoryBlock.id)
        if (!collapsedCategories.has(group.categoryBlock.id)) {
          for (const child of group.children) ids.push(child.id)
        }
      } else {
        for (const child of group.children) ids.push(child.id)
      }
    }
    return ids
  }, [groups, collapsedCategories])

  const toggleCollapse = useCallback((categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }, [])

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
    addBlock(createMarkerBlock('category', 'New Category'))
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
    await duplicatePreset(activePresetId, `${activePreset.name} (Copy)`)
  }, [activePreset, activePresetId, duplicatePreset])

  const handleDeletePreset = useCallback(async () => {
    if (!activePresetId) return
    await deletePreset(activePresetId)
  }, [activePresetId, deletePreset])

  const handleExport = useCallback(() => {
    const data = exportInternal()
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.name || 'loom-preset'}.json`
    a.click()
    URL.revokeObjectURL(url)
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
        await importFromFile(json)
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
          onDelete={handleDeletePreset}
          onImport={handleImport}
          onExport={handleExport}
          onExportLegacy={() => setShowLegacyExportConfirm(true)}
        />
      </div>

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
          <span className={s.profileLabel}>Profiles</span>
          <div className={s.profileBtnGroup}>
            {/* Capture / clear defaults */}
            {!presetProfiles.hasDefaults ? (
              <button
                className={s.profileBtn}
                onClick={presetProfiles.captureDefaults}
                disabled={presetProfiles.isLoading}
                title="Capture current block states as defaults"
                type="button"
              >
                <Camera size={10} /> Capture Defaults
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={reapplyDefaults}
                disabled={presetProfiles.isLoading}
                title="Reapply default block states"
                type="button"
              >
                <RotateCcw size={10} /> Defaults
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.clearDefaults() }}
                  title="Clear default block states"
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
                  !presetProfiles.activeCharacterId ? 'No active character — open a chat first'
                    : !presetProfiles.hasDefaults ? 'Capture defaults first'
                      : 'Bind current block states to this character'
                }
                type="button"
              >
                <Link size={10} /> Character
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={presetProfiles.bindToCharacter}
                disabled={presetProfiles.isLoading || !presetProfiles.activeCharacterId}
                title="Rebind current block states to this character"
                type="button"
              >
                <RotateCcw size={10} /> Character
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.unbindCharacter() }}
                  title="Remove character binding"
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
                  !presetProfiles.activeChatId ? 'No active chat — open a chat first'
                    : !presetProfiles.hasDefaults ? 'Capture defaults first'
                      : 'Bind current block states to this chat'
                }
                type="button"
              >
                <Link size={10} /> Chat
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={presetProfiles.bindToChat}
                disabled={presetProfiles.isLoading || !presetProfiles.activeChatId}
                title="Rebind current block states to this chat"
                type="button"
              >
                <RotateCcw size={10} /> Chat
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.unbindChat() }}
                  title="Remove chat binding"
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
              {presetProfiles.activeSource === 'chat' ? 'CHAT' :
               presetProfiles.activeSource === 'character' ? 'CHAR' : 'DEFAULT'}
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
        {activePreset && <AdvancedSettingsPanel advancedSettings={activePreset.advancedSettings} onSave={saveAdvancedSettings} />}
        {activePreset && <ContextMeter />}

        {/* Block list or empty state */}
        <div className={s.blockList}>
          {isLoading ? (
            <div className={s.emptyState}>Loading...</div>
          ) : !activePreset ? (
            <div className={s.emptyState}>
              <Layers size={40} style={{ opacity: 0.3 }} />
              <div style={{ fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))', fontWeight: 500 }}>No Preset Selected</div>
              <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))' }}>Create a new preset or select an existing one to start building.</div>
            </div>
          ) : activePreset.blocks.length === 0 ? (
            <div className={s.emptyState}>
              <div style={{ fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))' }}>No blocks yet</div>
              <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))' }}>Add a prompt block or marker to get started.</div>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visibleBlockIds} strategy={verticalListSortingStrategy}>
                {groups.map(group => (
                  <Fragment key={group.categoryBlock?.id || 'ungrouped'}>
                    {group.categoryBlock && (
                      <SortableCategoryItem
                        block={group.categoryBlock}
                        isCollapsed={collapsedCategories.has(group.categoryBlock.id)}
                        onToggleCollapse={() => toggleCollapse(group.categoryBlock!.id)}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onToggle={toggleBlock}
                        childCount={group.children.length}
                      />
                    )}
                    {(!group.categoryBlock || !collapsedCategories.has(group.categoryBlock.id)) &&
                      group.children.map(block => (
                        <SortableBlockItem
                          key={block.id}
                          block={block}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onToggle={toggleBlock}
                          indented={!!group.categoryBlock}
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
              <Plus size={14} /> Add Prompt <ChevronDown size={12} />
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
            <ChevronRight size={14} /> Add Category
          </button>

          <div style={{ position: 'relative' }}>
            <button className={s.btn} onClick={() => { setMarkerMenuOpen(!markerMenuOpen); setPromptMenuOpen(false) }} type="button">
              <Hash size={14} /> Add Marker <ChevronDown size={12} />
            </button>
            {markerMenuOpen && (
              <div className={s.dropdownMenu} style={{ bottom: '100%', left: 0, marginBottom: '4px', minWidth: '200px' }}>
                {ADDABLE_MARKERS.map((item, i) => {
                  if (typeof item === 'object' && 'section' in item) {
                    return (
                      <div key={item.section}>
                        {i > 0 && <hr className={s.menuDivider} />}
                        <div className={s.sectionLabel}>{item.section}</div>
                      </div>
                    )
                  }
                  return (
                    <MenuButton
                      key={item as string}
                      icon={<Hash size={14} />}
                      label={MARKER_NAMES[item as string] || (item as string)}
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
          title="Export Legacy Preset"
          message="Lumiverse-specific macros (e.g. {{lumiaDef}}, {{loomStyle}}, {{lumiaOOC}}) will not resolve in SillyTavern. Only standard macros like {{char}}, {{user}}, and {{persona}} are portable. Blocks using Lumiverse macros will be exported as-is with their raw macro text."
          variant="warning"
          confirmText="Export Anyway"
          onConfirm={handleExportLegacy}
          onCancel={() => setShowLegacyExportConfirm(false)}
        />

      {/* Confirm delete dialog */}
        <ConfirmationModal
          isOpen={!!confirmDelete}
          title="Delete Block"
          message="Are you sure you want to delete this block? This action cannot be undone."
          variant="danger"
          confirmText="Delete"
          onConfirm={confirmDeleteBlock}
          onCancel={() => setConfirmDelete(null)}
        />
      </div>
    </PanelFadeIn>
  )
}
