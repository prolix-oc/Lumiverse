import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, useDeferredValue, useId, type ReactNode, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { useSpindleComponentOverride } from '@/lib/spindle/use-spindle-component-override'
import { scheduleLowPriorityTask } from '@/lib/low-priority-task'

import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useDroppable,
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
  Shield,
  Archive,
  CircleHelp,
  Square,
  CheckSquare,
} from 'lucide-react'
import clsx from 'clsx'
import ExpandedTextEditor, { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { ModalShell } from '@/components/shared/ModalShell'
import { GuideViewer } from '@/components/shared/GuideViewer'
import {
  canMovePromptVariableBetweenOccurrences,
  decodeLoomBlockOccurrence,
  encodeLoomBlockOccurrence,
  remapCategorySnapshotsForReorder,
  getLoomBlockAtOccurrence,
  useLoomBuilder,
  type LoomBlockOccurrence,
  type LoomBlockReorderEntry,
} from '@/hooks/useLoomBuilder'
import { RangeSlider } from '@/components/shared/RangeSlider'
import { resolveMacros as resolveMacrosApi } from '@/api/macros'
import { presetsApi, type StashedPromptBlock } from '@/api/presets'
import { imagesApi } from '@/api/images'
import { usePresetProfiles } from '@/hooks/usePresetProfiles'
import { getEffectivePromptVariableValues } from '@/hooks/preset-profile-prompt-variables'
import {
  computeGroups,
  createBlock,
  createMarkerBlock,
  getPortablePresetErrorCode,
  getRemotePresetOrigin,
  resolvePromptBlockPlacements,
  unmarshalPreset,
} from '@/lib/loom/service'
import { sanitizeCharacterTagTrigger, splitCharacterTagTriggerInput } from '@/lib/loom/characterTagTrigger'
import {
  PROMPT_TEMPLATES,
  PROVIDER_DISPLAY_NAMES,
  INJECTION_TRIGGER_TYPES,
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
} from '@/lib/loom/constants'
import type { PromptBlock, PromptBlockPlacement, PromptBlockPlacementBinding, PromptVariableDef, PromptVariableValues, LoomConnectionProfile, SamplerParam, MacroGroup, CategoryGroup, LoomPreset } from '@/lib/loom/types'
import { useLoomOptionLabels } from '@/lib/i18n/loomOptionLabels'
import { PromptVariablesModal } from '@/components/shared/PromptVariablesModal'
import { VariablesEditor } from './PromptVariablesEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import NumberStepper from '@/components/shared/NumberStepper'
import { useStore as __contextMeterStore } from '@/store'
import { groupBreakdownEntries as __groupBreakdownEntries } from '@/lib/prompt-breakdown'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import { Toggle } from '@/components/shared/Toggle'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { PromptStashModal } from './PromptStashModal'
import { Button } from '@/components/shared/FormComponents'
import { toast } from '@/lib/toast'
import { useLongPress } from '@/hooks/useLongPress'
import { markLoomRuntimeProfileContext } from '@/lib/loom/runtimeProfile'
import {
  registerActiveLoomPresetSelectionBlocker,
  type ActiveLoomPresetSelectionBlockerRegistration,
} from '@/lib/loom/preset-selection-coordinator'
import SpindlePresetEditorTabContent from '@/components/spindle/SpindlePresetEditorTabContent'
import SpindlePresetEditorToolbarItem from '@/components/spindle/SpindlePresetEditorToolbarItem'
import { applyPresetEditorDraft, toPresetEditorDraft } from '@/lib/spindle/preset-editor-adapter'
import { setPresetEditorController, syncPresetEditorState } from '@/lib/spindle/preset-editor-helper'
import AgenticRuntimePanel from './AgenticRuntimePanel'
import s from './LoomBuilder.module.css'

function useLb() {
  return useTranslation('panels', { keyPrefix: 'loomBuilder' })
}

// ============================================================================
const OUTER_EDITOR_TAB_PREFIX = 'loom-builder'

function outerEditorDomId(kind: 'tab' | 'panel', tabId: string): string {
  return `${OUTER_EDITOR_TAB_PREFIX}-${kind}-${encodeURIComponent(tabId)}`
}
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

const ROOT_DROP_PREFIX = 'root-drop:'

function parseRootDropId(id: unknown) {
  if (typeof id !== 'string' || !id.startsWith(ROOT_DROP_PREFIX)) return null
  const index = Number(id.slice(ROOT_DROP_PREFIX.length).split(':', 1)[0])
  return Number.isFinite(index) ? index : null
}

function rootDropId(index: number, appendCategoryOccurrenceId?: string) {
  return `${ROOT_DROP_PREFIX}${index}${appendCategoryOccurrenceId ? `:category:${appendCategoryOccurrenceId}` : ''}`
}

function hasExplicitGroup(block: PromptBlock) {
  return block.group !== undefined
}

function blockGroup(block: PromptBlock) {
  return block.group ?? null
}

function sanitizeSealedBlockKey(value: string) {
  return value.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
}

function filterSealedBlockKeyInput(value: string) {
  return value.replace(/[^A-Za-z0-9._:-]+/g, '-')
}

function suggestedSealedBlockKey(block: PromptBlock, name: string) {
  const fromTitle = (name || block.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return fromTitle || sanitizeSealedBlockKey(block.id).toLowerCase() || block.id.toLowerCase()
}

function reportLoomCallbackFailure(error: unknown): void {
  console.error('[Spindle] Loom onChange callback failed', error)
}

function observeLoomCallbackResult(result: unknown): void {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return
  try {
    void Promise.resolve(result).catch(reportLoomCallbackFailure)
  } catch (error) {
    reportLoomCallbackFailure(error)
  }
}

function inferGroupAtIndex(blocks: PromptBlock[], index: number) {
  const target = blocks[index]
  if (!target || target.marker === 'category') return null
  if (hasExplicitGroup(target)) return blockGroup(target)

  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i].marker === 'category') return blocks[i].id
  }
  return null
}

function getCategoryEndIndex(blocks: PromptBlock[], target: LoomBlockOccurrence) {
  const category = getLoomBlockAtOccurrence(blocks, target)
  if (!category || category.marker !== 'category') return -1

  let endIndex = target.promptOrder + 1
  while (endIndex < blocks.length) {
    const block = blocks[endIndex]
    if (block.marker === 'category') break
    if (hasExplicitGroup(block) && blockGroup(block) !== category.id) break
    endIndex += 1
  }
  return endIndex
}

function parseRootDropCategoryId(id: unknown): LoomBlockOccurrence | null {
  if (typeof id !== 'string' || !id.startsWith(ROOT_DROP_PREFIX)) return null
  const marker = ':category:'
  const markerIndex = id.indexOf(marker)
  return markerIndex === -1 ? null : decodeLoomBlockOccurrence(id.slice(markerIndex + marker.length))
}

function RootDropSlot({ id, active, appendArmed }: { id: string; active: boolean; appendArmed?: boolean }) {
  const { t } = useLb()
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !active })
  return (
    <div className={s.rootDropSlotWrap}>
      <div
        ref={setNodeRef}
        className={clsx(
          s.rootDropSlot,
          active && s.rootDropSlotActive,
          isOver && s.rootDropSlotOver,
          appendArmed && s.rootDropSlotAppendArmed,
        )}
        aria-label={appendArmed
          ? t('block.dropAtCategoryEnd', { defaultValue: 'Drop at bottom of category' })
          : t('block.dropAtRoot', { defaultValue: 'Drop at root level' })}
      />
    </div>
  )
}

// ============================================================================
// SORTABLE CATEGORY ITEM
// ============================================================================

interface SortableCategoryItemProps {
  block: PromptBlock
  occurrence: LoomBlockOccurrence
  isCollapsed: boolean
  onToggleCollapse: () => void
  onEdit: (target: LoomBlockOccurrence) => void
  onDelete: (target: LoomBlockOccurrence) => void
  onToggle: (target: LoomBlockOccurrence) => void
  /** Blanket enable/disable of the category and all of its children. */
  onToggleChildren: (target: LoomBlockOccurrence) => void
  childCount: number
  dragDisabled?: boolean
}

function SortableCategoryItem({
  block, occurrence, isCollapsed, onToggleCollapse, onEdit, onDelete, onToggle, onToggleChildren, childCount, dragDisabled = false,
}: SortableCategoryItemProps) {
  const { t } = useLb()
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: encodeLoomBlockOccurrence(occurrence), disabled: dragDisabled })
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
      <Button size="icon-sm" variant="ghost" onClick={() => onToggle(occurrence)} title={block.enabled ? t('category.disable') : t('category.enable')}>
        {block.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={() => onToggleChildren(occurrence)} title={block.enabled ? t('category.disableAll') : t('category.enableAll')}>
        <Layers size={14} />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={() => onEdit(occurrence)} title={t('category.rename')}>
        <Edit2 size={14} />
      </Button>
      <Button size="icon-sm" variant="danger-ghost" onClick={() => onDelete(occurrence)} title={t('category.deleteCategory')}>
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
  occurrence: LoomBlockOccurrence
  effectiveRole?: PromptBlock['role']
  onEdit: (target: LoomBlockOccurrence) => void
  onDelete: (target: LoomBlockOccurrence) => void
  onToggle: (target: LoomBlockOccurrence) => void
  onStash?: (target: LoomBlockOccurrence, block: PromptBlock) => void
  indented: boolean
  dragDisabled?: boolean
}

function SortableBlockItem({ block, occurrence, effectiveRole, onEdit, onDelete, onToggle, onStash, indented, dragDisabled = false }: SortableBlockItemProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: encodeLoomBlockOccurrence(occurrence), disabled: dragDisabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const isMarker = block.marker && block.marker !== 'category'
  const isDisabled = !block.enabled
  const preview = block.content ? block.content.substring(0, 50) + (block.content.length > 50 ? '...' : '') : ''
  const displayedRole = effectiveRole ?? block.role

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
            {block.sealed === true && <Shield size={10} className={clsx(s.blockNameIcon, s.blockNameIconSealed)} />}
            {block.stashId && <Archive size={10} className={clsx(s.blockNameIcon, s.blockNameIconMuted)} />}
            <span className={s.blockNameText}>{block.name}</span>
          </span>
        </div>
        {preview && !isMarker && <span className={s.blockPreview}>{preview}</span>}
      </div>
      <span className={s.blockMetaRow}>
        {!isMarker && (
          <span className={clsx(s.badge, ROLE_BADGES[displayedRole] || s.badgeSystem)}>{ROLE_DISPLAY_LABELS[displayedRole] || displayedRole}</span>
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
      <Button size="icon-sm" variant="ghost" onClick={() => onToggle(occurrence)} title={block.enabled ? t('block.disable') : t('block.enable')}>
        {block.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </Button>
      {!isMarker && !block.stashId && onStash && (
        <Button size="icon-sm" variant="ghost" onClick={() => onStash(occurrence, block)} title={t('actions.addToStash')}>
          <Archive size={14} />
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" onClick={() => onEdit(occurrence)} title={tc('actions.edit')}>
        <Edit2 size={14} />
      </Button>
      {!block.isLocked && (
        <Button size="icon-sm" variant="danger-ghost" onClick={() => onDelete(occurrence)} title={tc('actions.delete')}>
          <Trash2 size={14} />
        </Button>
      )}
    </div>
  )
}

// ============================================================================
// BLOCK EDITOR
// ============================================================================

interface TrustedMacroPreviewControlsProps {
  blockId: string
  blocks: PromptBlock[]
  promptVariables: PromptVariableValues
  content: string
  role: PromptBlock['role']
  position: PromptBlock['position']
  depth: number
  variables: PromptVariableDef[]
  placementBinding?: PromptBlockPlacementBinding
}

function TrustedMacroPreviewControls({
  blockId,
  blocks,
  promptVariables,
  content,
  role,
  position,
  depth,
  variables,
  placementBinding,
}: TrustedMacroPreviewControlsProps) {
  const { t } = useLb()
  const [showPreview, setShowPreview] = useState(false)
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewDiagnostics, setPreviewDiagnostics] = useState<{ level: string; message: string }[]>([])
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A preview can be superseded while its macro request is in flight. Track
  // the request version so a late response never replaces newer context.
  const previewRequestVersionRef = useRef(0)
  const activeChatId = __contextMeterStore((state) => state.activeChatId)
  const activeCharacterId = __contextMeterStore((state) => state.activeCharacterId)
  const activeGroupCharacterId = __contextMeterStore((state) => state.activeGroupCharacterId)
  const activePersonaId = __contextMeterStore((state) => state.activePersonaId)
  const activeProfileId = __contextMeterStore((state) => state.activeProfileId)

  useEffect(() => {
    const requestVersion = ++previewRequestVersionRef.current
    if (!showPreview || !content.trim()) {
      setPreviewText('')
      setPreviewDiagnostics([])
      setPreviewLoading(false)
      return
    }
    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      setPreviewLoading(true)
      const isAppend = role === 'user_append' || role === 'assistant_append'
      const previewBlocks = blocks.map((candidate) =>
        candidate.id === blockId
          ? { ...candidate, content, role, position, depth, variables, placementBinding, enabled: true }
          : candidate,
      )
      resolveMacrosApi({
        template: content,
        trim: !isAppend,
        prompt_blocks: previewBlocks,
        prompt_block_id: blockId,
        prompt_variables: promptVariables,
        ...(activeChatId ? { chat_id: activeChatId } : {}),
        ...(activePersonaId ? { persona_id: activePersonaId } : {}),
        ...(activeProfileId ? { connection_id: activeProfileId } : {}),
        ...(activeGroupCharacterId || activeCharacterId
          ? { character_id: activeGroupCharacterId ?? activeCharacterId ?? undefined }
          : {}),
      })
        .then((response) => {
          if (previewRequestVersionRef.current !== requestVersion) return
          setPreviewText(response.text)
          setPreviewDiagnostics(response.diagnostics)
        })
        .catch(() => {
          if (previewRequestVersionRef.current !== requestVersion) return
          setPreviewText(t('blockEditor.previewUnavailable'))
          setPreviewDiagnostics([])
        })
        .finally(() => {
          if (previewRequestVersionRef.current === requestVersion) {
            setPreviewLoading(false)
          }
        })
    }, 500)
    return () => {
      clearTimeout(previewTimerRef.current)
    }
  }, [
    activeCharacterId,
    activeChatId,
    activeGroupCharacterId,
    activePersonaId,
    activeProfileId,
    blockId,
    blocks,
    content,
    depth,
    position,
    promptVariables,
    role,
    t,
    variables,
    placementBinding,
    showPreview,
  ])

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
        <button
          className={clsx(s.btn, s.btnSmall, showPreview && s.btnPrimary)}
          onClick={() => setShowPreview(!showPreview)}
          type="button"
        >
          <Eye size={12} /> {showPreview ? t('blockEditor.hidePreview') : t('blockEditor.preview')}
        </button>
        {showPreview && previewLoading && (
          <span style={{ fontSize: 'calc(10px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)' }}>
            {t('blockEditor.resolving')}
          </span>
        )}
      </div>
      {showPreview && (
        <div className={s.previewPanel}>
          {previewDiagnostics.length > 0 && (
            <div className={s.previewDiagnostics}>
              {previewDiagnostics.map((diagnostic, index) => (
                <div key={index} className={diagnostic.level === 'error' ? s.previewDiagError : s.previewDiagWarn}>
                  <AlertTriangle size={10} /> {diagnostic.message}
                </div>
              ))}
            </div>
          )}
          <pre className={s.previewContent}>
            {previewLoading
              ? t('blockEditor.resolving')
              : (previewText === '' && content ? t('blockEditor.emptyOutput') : previewText || t('blockEditor.noPreview'))}
          </pre>
        </div>
      )}
    </>
  )
}

interface BlockEditorProps {
  block: PromptBlock
  blockOccurrence: LoomBlockOccurrence
  blocks: PromptBlock[]
  promptVariables: PromptVariableValues
  onSave: (updates: Partial<PromptBlock>) => boolean | void
  onBack: () => void
  validationError?: string | null
  availableMacros: MacroGroup[]
  refreshMacros?: () => void
  compact: boolean
  trustedHostFeatures?: boolean
  /** Preset-level move: relocates a variable def (and its value bucket) to
   * another block. Returns false when the move was rejected. */
  onMoveVariable?: (source: LoomBlockOccurrence, variable: PromptVariableDef, target: LoomBlockOccurrence) => boolean
}

function cleanPlacementBinding(
  binding: PromptBlockPlacementBinding | undefined,
  variables: PromptVariableDef[],
  fallback: PromptBlockPlacement,
): PromptBlockPlacementBinding | undefined {
  if (!binding) return undefined
  const selector = variables.find(
    (variable): variable is Extract<PromptVariableDef, { type: 'select' }> => (
      variable.id === binding.variableId && variable.type === 'select'
    ),
  )
  if (!selector || selector.options.length === 0) return undefined
  const validRoles = new Set<PromptBlockPlacement['role']>(['system', 'user', 'assistant', 'user_append', 'assistant_append'])
  const validPositions = new Set<PromptBlockPlacement['position']>(['pre_history', 'post_history', 'in_history'])
  const options: PromptBlockPlacementBinding['options'] = {}
  for (const option of selector.options) {
    const raw = binding.options[option.id]
    const placement = raw
      && validRoles.has(raw.role)
      && validPositions.has(raw.position)
      && Number.isFinite(raw.depth)
      && raw.depth >= 0
      ? { role: raw.role, position: raw.position, depth: Math.floor(raw.depth) }
      : { ...fallback }
    options[option.id] = placement
  }
  return { variableId: selector.id, options }
}

export function BlockEditor({
  block,
  blockOccurrence,
  blocks,
  promptVariables,
  onSave,
  onBack,
  validationError,
  availableMacros,
  refreshMacros,
  compact,
  trustedHostFeatures = false,
  onMoveVariable,
}: BlockEditorProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const { injectionTriggerTypes, injectionTriggerLabel } = useLoomOptionLabels()
  const fieldIdPrefix = useId()
  const isInstalledLumiHubSealed = trustedHostFeatures && block.sealedSource === 'lumihub'
  const [name, setName] = useState(block.name)
  const [role, setRole] = useState<PromptBlock['role']>(block.role || 'system')
  const [content, setContent] = useState(block.content || '')
  const [position, setPosition] = useState<PromptBlock['position']>(block.position || 'pre_history')
  const [depth, setDepth] = useState(block.depth || 0)
  const [isLocked, setIsLocked] = useState(block.isLocked || false)
  const [sealControlsOpen, setSealControlsOpen] = useState(block.sealed === true)
  const [sealed, setSealed] = useState(block.sealed === true)
  const [sealedKey, setSealedKey] = useState(typeof block.sealedKey === 'string' ? block.sealedKey : '')
  const [injectionTrigger, setInjectionTrigger] = useState<string[]>(block.injectionTrigger || [])
  const [characterTagTrigger, setCharacterTagTrigger] = useState<string[]>(sanitizeCharacterTagTrigger(block.characterTagTrigger))
  const [characterTagDraft, setCharacterTagDraft] = useState('')
  const [categoryMode, setCategoryMode] = useState<PromptBlock['categoryMode']>(block.categoryMode ?? null)
  const [variables, setVariables] = useState<PromptVariableDef[]>(
    Array.isArray(block.variables) ? block.variables : [],
  )
  const [placementBinding, setPlacementBinding] = useState<PromptBlockPlacementBinding | undefined>(block.placementBinding)
  const [showMacros, setShowMacros] = useState(false)
  const [macroSearch, setMacroSearch] = useState('')
  const [showExpandedEditor, setShowExpandedEditor] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handlePositionChange = (newPosition: string) => {
    const pos = newPosition as PromptBlock['position']
    setPosition(pos)
    const isAppend = role === 'user_append' || role === 'assistant_append'
    if (pos === 'post_history' && !isAppend && role === 'system') setRole('user')
    else if (pos === 'pre_history' && role === 'assistant') setRole('system')
  }

  const handleSave = () => {
    const isAppend = role === 'user_append' || role === 'assistant_append'
    const cleanedVariables = variables.filter((variable) => variable && variable.name?.trim().length > 0)
    const cleanedCharacterTagTrigger = sanitizeCharacterTagTrigger(characterTagTrigger)
    const fallbackPlacement: PromptBlockPlacement = {
      role,
      position: isAppend ? 'pre_history' : position,
      depth: (position === 'in_history' || isAppend) ? depth : 0,
    }
    const trustedUpdates: Partial<PromptBlock> = {}
    if (trustedHostFeatures) {
      const cleanSealedKey = sanitizeSealedBlockKey(sealedKey || block.sealedKey || block.id)
      const shouldSeal = isInstalledLumiHubSealed || (sealed && !!cleanSealedKey)
      trustedUpdates.sealed = shouldSeal ? true : undefined
      trustedUpdates.sealedKey = shouldSeal ? cleanSealedKey : undefined
      trustedUpdates.sealedSource = isInstalledLumiHubSealed ? block.sealedSource : undefined
      trustedUpdates.sealedOriginPresetId = isInstalledLumiHubSealed ? block.sealedOriginPresetId : undefined
      trustedUpdates.sealedOriginVersion = isInstalledLumiHubSealed ? block.sealedOriginVersion : undefined
      trustedUpdates.sealedSha256 = isInstalledLumiHubSealed ? block.sealedSha256 : undefined
    }
    onSave({
      name,
      role,
      content,
      position: isAppend ? 'pre_history' : position,
      depth: (position === 'in_history' || isAppend) ? depth : 0,
      isLocked,
      injectionTrigger,
      characterTagTrigger: cleanedCharacterTagTrigger.length > 0 ? cleanedCharacterTagTrigger : undefined,
      ...trustedUpdates,
      categoryMode: block.marker === 'category' ? categoryMode : null,
      variables: cleanedVariables.length ? cleanedVariables : undefined,
      placementBinding: cleanPlacementBinding(placementBinding, cleanedVariables, fallbackPlacement),
    })
  }

  const toggleTrigger = (value: string) => {
    setInjectionTrigger(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }

  const commitCharacterTagDraft = useCallback(() => {
    const parsed = splitCharacterTagTriggerInput(characterTagDraft)
    if (parsed.length === 0) return
    setCharacterTagTrigger((prev) => sanitizeCharacterTagTrigger([...prev, ...parsed]))
    setCharacterTagDraft('')
  }, [characterTagDraft])

  const removeCharacterTagTrigger = useCallback((value: string) => {
    setCharacterTagTrigger((prev) => prev.filter((tag) => tag !== value))
  }, [])

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
          {validationError && <div role="alert" className={s.jsonError}>{validationError}</div>}
          <div className={s.formGroup}>
            <label className={s.label} htmlFor={`${fieldIdPrefix}-name`}>{t('blockEditor.name')}</label>
            <input id={`${fieldIdPrefix}-name`} className={s.input} value={name} onChange={e => setName(e.target.value)} placeholder={t('blockEditor.namePlaceholder')} />
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div className={s.formGroup} style={{ flex: 1, minWidth: '120px' }}>
              <label className={s.label} htmlFor={`${fieldIdPrefix}-role`}>{t('blockEditor.role')}</label>
              <select id={`${fieldIdPrefix}-role`} className={s.select} value={role} onChange={e => setRole(e.target.value as PromptBlock['role'])}>
                {position !== 'post_history' && <option value="system">{t('blockEditor.roles.system')}</option>}
                <option value="user">{t('blockEditor.roles.user')}</option>
                <option value="assistant">{t('blockEditor.roles.assistant')}</option>
                <option value="user_append">{t('blockEditor.roles.user_append')}</option>
                <option value="assistant_append">{t('blockEditor.roles.assistant_append')}</option>
              </select>
            </div>
            {role !== 'user_append' && role !== 'assistant_append' && (
              <div className={s.formGroup} style={{ flex: 1, minWidth: '140px' }}>
                <label className={s.label} htmlFor={`${fieldIdPrefix}-position`}>{t('blockEditor.position')}</label>
                <select id={`${fieldIdPrefix}-position`} className={s.select} value={position} onChange={e => handlePositionChange(e.target.value)}>
                  <option value="pre_history">{t('blockEditor.positions.pre_history')}</option>
                  <option value="post_history">{t('blockEditor.positions.post_history')}</option>
                  <option value="in_history">{t('blockEditor.positions.in_history')}</option>
                </select>
              </div>
            )}
            {(position === 'in_history' || role === 'user_append' || role === 'assistant_append') && (
              <div className={s.formGroup} style={{ width: '100px' }}>
                <label className={s.label} htmlFor={`${fieldIdPrefix}-depth`}>{t('blockEditor.depth')}</label>
                <NumberStepper inputId={`${fieldIdPrefix}-depth`} value={depth} min={0} onChange={(v) => setDepth(v ?? 0)} />
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
              <label className={s.label} htmlFor={`${fieldIdPrefix}-content`}>{t('blockEditor.content')}</label>
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
                    <input className={s.macroSearchInput} aria-label={t('blockEditor.searchMacros')} placeholder={t('blockEditor.searchMacros')} value={macroSearch} onChange={e => setMacroSearch(e.target.value)} />
                  </div>
                </div>
                {filteredMacros.map((group, groupIndex) => (
                  <div key={group.category} className={s.macroGroup} aria-labelledby={`${fieldIdPrefix}-macro-group-${groupIndex}`}>
                    <div id={`${fieldIdPrefix}-macro-group-${groupIndex}`} className={s.macroGroupTitle}>{group.category}</div>
                    {group.macros.map(macro => (
                      <button type="button" key={macro.syntax} className={s.macroItem} onClick={() => insertMacro(macro.syntax)}>
                        <span className={s.macroSyntax}>{macro.syntax}</span>
                        <span className={s.macroDesc}>{macro.description}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <textarea id={`${fieldIdPrefix}-content`} ref={textareaRef} className={s.textarea} value={content} onChange={e => setContent(e.target.value)} placeholder={t('blockEditor.contentPlaceholder')} />
            {trustedHostFeatures && (
              <TrustedMacroPreviewControls
                blockId={block.id}
                blocks={blocks}
                promptVariables={promptVariables}
                content={content}
                role={role}
                position={position}
                depth={depth}
                variables={variables}
                placementBinding={placementBinding}
              />
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Toggle.Checkbox checked={isLocked} onChange={setIsLocked} label={<><Lock size={14} /> {t('blockEditor.lockBlock')}</>} />
          </div>

          {trustedHostFeatures && !block.marker && (
            <div className={clsx(s.sealedBlockPanel, sealed && s.sealedBlockPanelActive)}>
              <button
                className={s.sealedBlockReveal}
                type="button"
                onClick={() => {
                  const nextOpen = !sealControlsOpen
                  setSealControlsOpen(nextOpen)
                  if (nextOpen && !sealedKey.trim()) setSealedKey(suggestedSealedBlockKey(block, name))
                }}
                aria-expanded={sealControlsOpen}
              >
                <span className={s.sealedBlockRevealCopy}>
                  <Shield size={14} />
                  <span>{t('blockEditor.sealedBlockTitle')}</span>
                </span>
                <ChevronDown size={14} className={clsx(s.sealedBlockChevron, sealControlsOpen && s.sealedBlockChevronOpen)} />
              </button>
              {sealControlsOpen && (
                <div className={s.sealedBlockBody}>
                  <p className={s.sealedBlockText}>{t(isInstalledLumiHubSealed ? 'blockEditor.sealedBlockInstalledHint' : 'blockEditor.sealedBlockHint')}</p>
                  <div className={s.formGroup}>
                    <label className={s.label} htmlFor={`${fieldIdPrefix}-sealed-key`}>{t('blockEditor.sealedBlockKey')}</label>
                    <input
                      id={`${fieldIdPrefix}-sealed-key`}
                      className={s.input}
                      value={sealedKey}
                      onChange={e => setSealedKey(filterSealedBlockKeyInput(e.target.value))}
                      placeholder={t('blockEditor.sealedBlockKeyPlaceholder')}
                      spellCheck={false}
                      disabled={isInstalledLumiHubSealed}
                    />
                    <span className={s.settingsHint}>{t('blockEditor.sealedBlockKeyHint')}</span>
                  </div>
                  <label className={clsx(s.sealedBlockArmRow, !sealedKey.trim() && s.sealedBlockArmRowDisabled)}>
                    <input
                      type="checkbox"
                      checked={(isInstalledLumiHubSealed || sealed) && !!sealedKey.trim()}
                      disabled={isInstalledLumiHubSealed || !sealedKey.trim()}
                      onChange={e => setSealed(e.target.checked)}
                    />
                    <span>{t(isInstalledLumiHubSealed ? 'blockEditor.sealedBlockInstalledEnable' : 'blockEditor.sealedBlockEnable')}</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {block.marker === 'category' && (
            <div className={s.formGroup}>
              <label className={s.label} htmlFor={`${fieldIdPrefix}-category-mode`}>{t('blockEditor.categoryMode')}</label>
              <select
                id={`${fieldIdPrefix}-category-mode`}
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

          <fieldset className={clsx(s.formGroup, s.editorFieldset)}>
            <legend className={s.label}>{t('blockEditor.injectionTriggers')}</legend>
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
          </fieldset>

          <div className={s.formGroup}>
            <label className={s.label} htmlFor={`${fieldIdPrefix}-character-tags`}>{t('blockEditor.characterTagTrigger')}</label>
            <div className={s.tagTriggerField}>
              {characterTagTrigger.map((tag) => (
                <span key={tag} className={s.tagTriggerChip}>
                  {tag}
                  <button
                    type="button"
                    className={s.tagTriggerChipRemove}
                    onClick={() => removeCharacterTagTrigger(tag)}
                    aria-label={`${tc('actions.delete')}: ${tag}`}
                    title={tc('actions.delete')}
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                </span>
              ))}
              <div className={s.tagTriggerDraftRow}>
                <input
                  id={`${fieldIdPrefix}-character-tags`}
                  className={s.tagTriggerDraftInput}
                  value={characterTagDraft}
                  onChange={(e) => setCharacterTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      commitCharacterTagDraft()
                    }
                  }}
                  placeholder={t('blockEditor.characterTagTriggerPlaceholder')}
                />
                <button
                  type="button"
                  className={s.tagTriggerDraftAdd}
                  onClick={commitCharacterTagDraft}
                  disabled={!characterTagDraft.trim()}
                  aria-label={`${tc('actions.add')}: ${t('blockEditor.characterTagTrigger')}`}
                >
                  <Plus size={12} aria-hidden="true" />
                </button>
              </div>
            </div>
            <span className={s.settingsHint}>
              {characterTagTrigger.length === 0
                ? t('blockEditor.characterTagTriggerNone')
                : t('blockEditor.characterTagTriggerActive', { list: characterTagTrigger.join(', ') })}
            </span>
            <span className={s.settingsHint}>{t('blockEditor.characterTagTriggerHint')}</span>
          </div>

          <VariablesEditor
            variables={variables}
            onChange={setVariables}
            placementBinding={placementBinding}
            fallbackPlacement={{ role, position, depth }}
            onPlacementBindingChange={setPlacementBinding}
            moveTargets={blocks
              .map((candidate, promptOrder) => ({
                candidate,
                occurrence: { blockId: candidate.id, promptOrder },
              }))
              .filter(({ occurrence }) => (
                canMovePromptVariableBetweenOccurrences(blockOccurrence, occurrence)
              ))
              .map(({ candidate, occurrence }) => {
                const group = computeGroups(blocks).find((entry) => (
                  entry.categoryBlock === candidate || entry.children.includes(candidate)
                ))
                const category = group?.categoryBlock
                const isCategory = candidate.marker === 'category'
                return {
                  id: encodeLoomBlockOccurrence(occurrence),
                  name: candidate.name || candidate.id,
                  categoryId: category ? encodeLoomBlockOccurrence({
                    blockId: category.id,
                    promptOrder: blocks.indexOf(category),
                  }) : null,
                  categoryName: category?.name || null,
                  isCategory,
                  variableNames: (candidate.variables ?? [])
                    .map((variable) => variable.name?.trim() ?? '')
                    .filter(Boolean),
                }
              })}
            onMoveToBlock={onMoveVariable ? (variableId, encodedTarget) => {
              const moving = variables.find((variable) => variable.id === variableId)
              const target = decodeLoomBlockOccurrence(encodedTarget)
              if (!moving || !target) return
              // Move the in-editor version of the def (it may carry unsaved
              // edits) and drop it from the local list so a later Save of
              // this block doesn't resurrect it.
              if (onMoveVariable(blockOccurrence, moving, target)) {
                setVariables((current) => current.filter((variable) => variable.id !== variableId))
              }
            } : undefined}
          />
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
          sourceRef={textareaRef}
        />
      )}
    </div>
  )
}

export interface ControlledLoomBlockEditorProps {
  blocks: PromptBlock[]
  promptVariables: PromptVariableValues
  onChange: (blocks: PromptBlock[]) => boolean | void | Promise<unknown>
  availableMacros: MacroGroup[]
  refreshMacros?: () => void
  readOnly?: boolean
  compact?: boolean
  trustedHostFeatures?: boolean
}

/**
 * Controlled Loom block editor surface used by host integrations such as
 * Spindle. It deliberately reuses the same BlockEditor as the preset editor,
 * while leaving persistence and ownership of the block array to the caller.
 */
export function ControlledLoomBlockEditor({
  blocks,
  promptVariables,
  onChange,
  availableMacros,
  refreshMacros,
  readOnly = false,
  compact = true,
  trustedHostFeatures = false,
}: ControlledLoomBlockEditorProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const [editingBlockTarget, setEditingBlockTarget] = useState<LoomBlockOccurrence | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const editingBlock = editingBlockTarget
    ? getLoomBlockAtOccurrence(blocks, editingBlockTarget)
    : null
  const effectiveBlocks = useMemo(
    () => resolvePromptBlockPlacements(blocks, promptVariables),
    [blocks, promptVariables],
  )

  useEffect(() => {
    if (editingBlockTarget && !getLoomBlockAtOccurrence(blocks, editingBlockTarget)) {
      setEditingBlockTarget(null)
    }
  }, [blocks, editingBlockTarget])

  if (editingBlock && editingBlockTarget && !readOnly) {
    return (
      <BlockEditor
        key={`${encodeLoomBlockOccurrence(editingBlockTarget)}:${JSON.stringify(editingBlock)}`}
        block={editingBlock}
        blockOccurrence={editingBlockTarget}
        blocks={blocks}
        promptVariables={promptVariables}
        validationError={validationError}
        onSave={(updates) => {
          const nextBlocks = [...blocks]
          nextBlocks[editingBlockTarget.promptOrder] = { ...editingBlock, ...updates }
          const callbackBlocks = structuredClone(nextBlocks)
          let callbackResult: unknown = undefined
          try {
            callbackResult = onChange(callbackBlocks) as unknown
          } catch (error) {
            reportLoomCallbackFailure(error)
          }
          observeLoomCallbackResult(callbackResult)
          if (callbackResult === false) {
            setValidationError(t('blockEditor.validationFailed'))
            return
          }
          setValidationError(null)
          setEditingBlockTarget(null)
        }}
        onBack={() => {
          setValidationError(null)
          setEditingBlockTarget(null)
        }}
        availableMacros={availableMacros}
        refreshMacros={refreshMacros}
        compact={compact}
        trustedHostFeatures={trustedHostFeatures}
      />
    )
  }

  return (
    <div className={clsx(s.layout, compact && s.layoutCompact)}>
      <div className={s.toolbar}>
        <span className={s.title}>{t('preset.blocks', { count: blocks.length })}</span>
      </div>
      <div className={s.scrollArea}>
        <div className={s.blockList}>
          {blocks.length === 0 ? (
            <div className={s.empty}>{t('empty.noBlocksTitle')}</div>
          ) : blocks.map((block, promptOrder) => {
            const effectiveRole = effectiveBlocks[promptOrder]?.role ?? block.role
            const occurrence = { blockId: block.id, promptOrder }
            return (
              <div key={encodeLoomBlockOccurrence(occurrence)} className={clsx(s.item, !block.enabled && s.itemDisabled)}>
                <div className={s.blockContent}>
                  <div className={s.blockNameRow}>
                    <span className={s.blockName}>{block.name}</span>
                  </div>
                  {block.content && (
                    <span className={s.blockPreview}>
                      {block.content.slice(0, 100)}{block.content.length > 100 ? '…' : ''}
                    </span>
                  )}
                </div>
                <span className={s.blockMetaRow}>
                  <span className={clsx(s.badge, ROLE_BADGES[effectiveRole] || s.badgeSystem)}>
                    {ROLE_DISPLAY_LABELS[effectiveRole] || effectiveRole}
                  </span>
                </span>
                {!readOnly && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => {
                      setValidationError(null)
                      setEditingBlockTarget(occurrence)
                    }}
                    title={tc('actions.edit')}
                  >
                    <Edit2 size={14} />
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// PRESET SELECTOR
// ============================================================================

interface PresetSelectorProps {
  registry: Record<string, { name: string; blockCount: number; coverUrl?: string | null; updatedAt?: number }>
  activePresetId: string | null
  activePresetName: string | null
  onSelect: (id: string | null) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string, name: string) => void
  onDelete: (id: string) => void
  onBulkDelete: (ids: string[]) => Promise<string[] | null>
  onBulkExport: (ids: string[]) => Promise<number | null>
  onImport: (type: string) => void
  onExport: (id: string) => void
  onExportLegacy: () => void
}

function PresetSelector({ registry, activePresetId, activePresetName, onSelect, onCreate, onRename, onDuplicate, onDelete, onBulkDelete, onBulkExport, onImport, onExport, onExportLegacy }: PresetSelectorProps) {
  const { t } = useLb()
  const { t: tc } = useTranslation('common')
  const [showMenu, setShowMenu] = useState(false)
  const [showManager, setShowManager] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [renamePresetId, setRenamePresetId] = useState<string | null>(null)
  const [cardContextMenu, setCardContextMenu] = useState<{ presetId: string; position: ContextMenuPos } | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedPresetIds, setSelectedPresetIds] = useState<Set<string>>(new Set())
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null)
  const [bulkActionPending, setBulkActionPending] = useState(false)
  const registryEntries = Object.entries(registry)
  const allSelected = registryEntries.length > 0 && registryEntries.every(([id]) => selectedPresetIds.has(id))
  const contextPresetIdRef = useRef<string | null>(null)
  const selectionAnchorIdRef = useRef<string | null>(null)
  const cardLongPress = useLongPress({
    onLongPress: (position) => {
      const presetId = contextPresetIdRef.current
      if (presetId && registry[presetId]) setCardContextMenu({ presetId, position })
    },
  })

  useEffect(() => {
    const registryIds = new Set(Object.keys(registry))
    if (selectionAnchorIdRef.current && !registryIds.has(selectionAnchorIdRef.current)) {
      selectionAnchorIdRef.current = null
    }
    setSelectedPresetIds((current) => {
      const next = new Set([...current].filter((id) => registryIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [registry])

  const handleCreate = () => {
    if (!newName.trim()) return
    onCreate(newName.trim())
    setNewName('')
    setShowCreate(false)
  }

  const handleRename = () => {
    if (!renamePresetId || !renameName.trim()) return
    onRename(renamePresetId, renameName.trim())
    setRenameName('')
    setRenamePresetId(null)
    setShowRename(false)
  }

  const openRename = (id: string, name: string) => {
    setRenamePresetId(id)
    setRenameName(name)
    setShowRename(true)
    setShowMenu(false)
  }

  const togglePresetSelection = (id: string) => {
    setSelectedPresetIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handlePresetSelection = (id: string, selectRange = false) => {
    const anchorId = selectionAnchorIdRef.current
    if (selectRange && anchorId) {
      const anchorIndex = registryEntries.findIndex(([presetId]) => presetId === anchorId)
      const targetIndex = registryEntries.findIndex(([presetId]) => presetId === id)
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        setSelectedPresetIds((current) => {
          const next = new Set(current)
          for (let index = start; index <= end; index += 1) {
            next.add(registryEntries[index][0])
          }
          return next
        })
        return
      }
    }

    selectionAnchorIdRef.current = id
    togglePresetSelection(id)
  }

  const handleToggleSelectMode = () => {
    setSelectMode((current) => {
      if (current) {
        setSelectedPresetIds(new Set())
        selectionAnchorIdRef.current = null
      }
      return !current
    })
    setCardContextMenu(null)
  }

  const closeManager = () => {
    setShowManager(false)
    setCardContextMenu(null)
    setSelectMode(false)
    setSelectedPresetIds(new Set())
    selectionAnchorIdRef.current = null
  }

  const handleBulkExport = async () => {
    const ids = [...selectedPresetIds]
    if (ids.length === 0 || bulkActionPending) return
    setBulkActionPending(true)
    try {
      const count = await onBulkExport(ids)
      if (count === null) return
      toast.success(t('toast.bulkExportStarted', { count }))
    } catch (error: any) {
      toast.error(error?.body?.error || error?.message || t('toast.bulkExportFailed'))
    } finally {
      setBulkActionPending(false)
    }
  }

  const handleBulkDelete = async () => {
    if (!bulkDeleteIds?.length || bulkActionPending) return
    setBulkActionPending(true)
    try {
      const deleted = await onBulkDelete(bulkDeleteIds)
      if (deleted === null) return
      const deletedSet = new Set(deleted)
      setSelectedPresetIds((current) => new Set([...current].filter((id) => !deletedSet.has(id))))
      setBulkDeleteIds(null)
      toast.success(t('toast.bulkDeleted', { count: deleted.length }))
    } catch (error: any) {
      toast.error(error?.body?.error || error?.message || t('toast.bulkDeleteFailed'))
    } finally {
      setBulkActionPending(false)
    }
  }

  const contextPresetId = cardContextMenu?.presetId ?? null
  const contextPreset = contextPresetId ? registry[contextPresetId] : null
  const cardContextMenuItems: ContextMenuEntry[] = []
  if (contextPresetId && contextPreset) {
    const isActive = contextPresetId === activePresetId
    cardContextMenuItems.push({
      key: 'use',
      label: isActive ? t('preset.currentPreset') : t('preset.usePreset'),
      icon: <Check size={14} />,
      active: isActive,
      onClick: () => { onSelect(contextPresetId); setCardContextMenu(null) },
    })
    cardContextMenuItems.push(
      {
        key: 'rename',
        label: t('preset.rename'),
        icon: <Edit2 size={14} />,
        onClick: () => { openRename(contextPresetId, contextPreset.name); setCardContextMenu(null) },
      },
      {
        key: 'duplicate',
        label: t('preset.duplicate'),
        icon: <Copy size={14} />,
        onClick: () => { onDuplicate(contextPresetId, contextPreset.name); setCardContextMenu(null) },
      },
      {
        key: 'export',
        label: t('preset.exportLoomJson'),
        icon: <Download size={14} />,
        onClick: () => { onExport(contextPresetId); setCardContextMenu(null) },
      },
      { key: 'delete-divider', type: 'divider' },
      {
        key: 'delete',
        label: tc('actions.delete'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => { onDelete(contextPresetId); setCardContextMenu(null) },
      },
    )
  }

  const getPresetIdFromTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    return target.closest<HTMLElement>('[data-preset-id]')?.dataset.presetId ?? null
  }

  return (
    <div className={s.presetSelector}>
      <select className={clsx(s.select, s.presetSelect)} value={activePresetId || ''} onChange={e => onSelect(e.target.value || null)}>
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
            <MenuButton icon={<Layers size={14} />} label={t('preset.manage')} onClick={() => { setShowManager(true); setShowMenu(false) }} />
            <MenuButton icon={<Plus size={14} />} label={t('preset.newPreset')} onClick={() => { setShowCreate(true); setShowMenu(false) }} />
            {activePresetId && (
              <>
                <MenuButton icon={<Edit2 size={14} />} label={t('preset.rename')} onClick={() => openRename(activePresetId, activePresetName || '')} />
                <MenuButton icon={<Copy size={14} />} label={t('preset.duplicate')} onClick={() => { onDuplicate(activePresetId, activePresetName || registry[activePresetId]?.name || 'Preset'); setShowMenu(false) }} />
                <MenuButton icon={<Download size={14} />} label={t('preset.exportLoomJson')} onClick={() => { onExport(activePresetId); setShowMenu(false) }} />
                <MenuButton icon={<Download size={14} />} label={t('preset.exportLegacy')} onClick={() => { onExportLegacy(); setShowMenu(false) }} />
                <hr className={s.menuDivider} />
                <MenuButton icon={<Trash2 size={14} />} label={tc('actions.delete')} danger onClick={() => { onDelete(activePresetId); setShowMenu(false) }} />
              </>
            )}
            <hr className={s.menuDivider} />
            <MenuButton icon={<Upload size={14} />} label={t('preset.importLegacy')} onClick={() => { onImport('st'); setShowMenu(false) }} />
            <MenuButton icon={<Upload size={14} />} label={t('preset.importLoomJson')} onClick={() => { onImport('json'); setShowMenu(false) }} />
          </div>
        )}
      </div>

      <ModalShell
        isOpen={showManager}
        onClose={closeManager}
        maxWidth="min(920px, 94vw)"
        maxHeight="min(780px, 90vh)"
        className={s.presetManagerModal}
      >
        <div className={s.presetManagerHeader}>
          <div>
            <h2 className={s.presetManagerTitle}>{t('preset.managerTitle')}</h2>
            <p className={s.presetManagerSubtitle}>{t('preset.managerSubtitle', { count: registryEntries.length })}</p>
          </div>
          <button type="button" className={s.presetManagerClose} onClick={closeManager} aria-label={tc('actions.close')}>
            <X size={18} />
          </button>
        </div>
        <div className={clsx(s.presetManagerToolbar, selectMode && s.presetManagerToolbarSelecting)}>
          <div className={s.presetManagerToolbarPrimary}>
            <button type="button" className={s.presetManagerPrimaryAction} onClick={() => setShowCreate(true)}>
              <Plus size={15} /> {t('preset.newPreset')}
            </button>
            <button type="button" className={s.presetManagerAction} onClick={() => onImport('json')}>
              <Upload size={15} /> {t('preset.importLoomJson')}
            </button>
            <button type="button" className={s.presetManagerAction} onClick={() => onImport('st')}>
              <Upload size={15} /> {t('preset.importLegacy')}
            </button>
          </div>
          <div className={s.presetManagerBulkActions}>
            <button
              type="button"
              className={clsx(s.presetManagerAction, selectMode && s.presetManagerSelectModeActive)}
              onClick={handleToggleSelectMode}
              aria-pressed={selectMode}
              title={selectMode ? t('preset.exitSelectMode') : t('preset.selectMode')}
            >
              {selectMode ? <CheckSquare size={15} /> : <Square size={15} />}
              {selectMode ? t('preset.doneSelecting') : t('preset.selectMode')}
            </button>
            {selectMode && (
              <>
                <button
                  type="button"
                  className={s.presetManagerSelectAll}
                  onClick={() => {
                    selectionAnchorIdRef.current = null
                    setSelectedPresetIds(allSelected ? new Set() : new Set(registryEntries.map(([id]) => id)))
                  }}
                  disabled={registryEntries.length === 0}
                >
                  {allSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                  <span>{allSelected ? t('preset.deselectAll') : t('preset.selectAll')}</span>
                </button>
                <span className={s.presetManagerSelectedCount}>{t('preset.selected', { count: selectedPresetIds.size })}</span>
                {selectedPresetIds.size > 0 && (
                  <>
                    <button type="button" className={s.presetManagerAction} onClick={() => { void handleBulkExport() }} disabled={bulkActionPending}>
                      <Download size={15} /> {t('preset.exportSelected')}
                    </button>
                    <button type="button" className={s.presetManagerDangerAction} onClick={() => setBulkDeleteIds([...selectedPresetIds])} disabled={bulkActionPending}>
                      <Trash2 size={15} /> {t('preset.deleteSelected')}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <div
          className={s.presetManagerGrid}
          onTouchStart={(event) => {
            if (selectMode) return
            contextPresetIdRef.current = getPresetIdFromTarget(event.target)
            if (contextPresetIdRef.current) cardLongPress.onTouchStart(event)
          }}
          onTouchMove={(event) => {
            if (!selectMode) cardLongPress.onTouchMove(event)
          }}
          onTouchEnd={(event) => {
            if (!selectMode) cardLongPress.onTouchEnd(event)
            contextPresetIdRef.current = null
          }}
          onTouchCancel={() => {
            if (!selectMode) cardLongPress.onTouchCancel()
            contextPresetIdRef.current = null
          }}
          onContextMenu={(event) => {
            contextPresetIdRef.current = getPresetIdFromTarget(event.target)
            if (selectMode && contextPresetIdRef.current) {
              event.preventDefault()
              return
            }
            if (contextPresetIdRef.current) cardLongPress.onContextMenu(event)
          }}
        >
          {registryEntries.map(([id, entry]) => {
            const isActive = id === activePresetId
            return (
              <article
                key={id}
                data-preset-id={id}
                role="button"
                tabIndex={0}
                aria-pressed={selectMode ? selectedPresetIds.has(id) : isActive}
                className={clsx(
                  s.presetManagerCard,
                  isActive && s.presetManagerCardActive,
                  selectedPresetIds.has(id) && s.presetManagerCardSelected,
                )}
                onClick={(event) => {
                  const target = event.target
                  if (target instanceof Element && target.closest('input, label')) return
                  if (selectMode) handlePresetSelection(id, event.shiftKey)
                  else onSelect(id)
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    if (selectMode) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    setCardContextMenu({ presetId: id, position: { x: rect.left + 24, y: rect.top + 24 } })
                    return
                  }
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (selectMode) handlePresetSelection(id, event.shiftKey)
                  else onSelect(id)
                }}
              >
                <div className={clsx(s.presetManagerMedia, selectMode && s.presetManagerMediaSelectable)}>
                  <Layers size={32} className={s.presetManagerCoverFallback} />
                  {entry.coverUrl && (
                    <img
                      key={entry.coverUrl}
                      src={imagesApi.displayUrl(entry.coverUrl)}
                      alt=""
                      className={s.presetManagerCoverImage}
                      referrerPolicy="no-referrer"
                      onLoad={(event) => { event.currentTarget.style.display = '' }}
                      onError={(event) => {
                        const fallback = imagesApi.directDisplayFallback(entry.coverUrl!)
                        if (fallback && event.currentTarget.dataset.directFallback !== fallback) {
                          event.currentTarget.dataset.directFallback = fallback
                          event.currentTarget.src = fallback
                          return
                        }
                        event.currentTarget.style.display = 'none'
                      }}
                    />
                  )}
                  {isActive && <span className={s.presetManagerActiveBadge}>{t('preset.active')}</span>}
                  {selectMode && (
                    <label className={s.presetManagerCardSelect} onContextMenu={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedPresetIds.has(id)}
                        onChange={(event) => handlePresetSelection(id, (event.nativeEvent as MouseEvent).shiftKey)}
                        aria-label={t('preset.selectForBulk', { name: entry.name })}
                      />
                      <span><Check size={13} /></span>
                    </label>
                  )}
                </div>
                <div className={s.presetManagerCardBody}>
                  <div className={s.presetManagerCardTitleRow}>
                    <span className={s.presetManagerCardName} title={entry.name}>
                      {entry.name}
                    </span>
                  </div>
                  <span className={s.presetManagerCardMeta}>{t('preset.blocks', { count: entry.blockCount })}</span>
                </div>
              </article>
            )
          })}
          {registryEntries.length === 0 && (
            <div className={s.presetManagerEmpty}>{t('preset.managerEmpty')}</div>
          )}
        </div>
      </ModalShell>

      <ContextMenu
        position={cardContextMenu?.position ?? null}
        items={cardContextMenuItems}
        onClose={() => setCardContextMenu(null)}
      />

      <ConfirmationModal
        isOpen={!!bulkDeleteIds}
        zIndex={10005}
        title={t('confirm.bulkDeletePresetTitle')}
        message={t('confirm.bulkDeletePresetMessage', { count: bulkDeleteIds?.length ?? 0 })}
        variant="danger"
        confirmText={t('preset.deleteSelected')}
        loading={bulkActionPending}
        onConfirm={() => { void handleBulkDelete() }}
        onCancel={() => { if (!bulkActionPending) setBulkDeleteIds(null) }}
      />

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

      <ModalShell isOpen={showRename} onClose={() => { setShowRename(false); setRenamePresetId(null) }} maxWidth="clamp(320px, 90vw, min(420px, var(--lumiverse-content-max-width, 420px)))" className={s.presetNameModal} zIndex={10003}>
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
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null)
  const description = preset.description?.trim()
  const origin = getRemotePresetOrigin(preset)
  const visibleCoverUrl = coverUrl && failedCoverUrl !== coverUrl ? coverUrl : null
  if (!visibleCoverUrl && !origin && !preset.presetVersion) return null

  return (
    <section className={s.presetCoverHeader} aria-label={visibleCoverUrl ? t('preset.coverAria', { name: preset.name }) : undefined}>
      {visibleCoverUrl && (
        <img
          key={visibleCoverUrl}
          className={s.presetCoverImage}
          src={imagesApi.displayUrl(visibleCoverUrl)}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          onLoad={(event) => { event.currentTarget.style.display = '' }}
          onError={(event) => {
            const fallback = imagesApi.directDisplayFallback(visibleCoverUrl)
            if (fallback && event.currentTarget.dataset.directFallback !== fallback) {
              event.currentTarget.dataset.directFallback = fallback
              event.currentTarget.src = fallback
              return
            }
            setFailedCoverUrl(visibleCoverUrl)
          }}
        />
      )}
      <div className={s.presetCoverContent}>
        <div className={s.presetCoverBadgeRow}>
          {origin === 'lumihub' && <span className={s.presetCoverBadge}>{t('preset.lumihubBadge')}</span>}
          {origin === 'illarin' && <span className={s.presetCoverBadge}>{t('preset.illarinBadge')}</span>}
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
  connectionProfile: LoomConnectionProfile | null
  samplerParams: SamplerParam[]
  onSaveSamplers: (overrides: any) => void
  onRefreshProfile: () => void
}

function GenerationSettings({ samplerOverrides, connectionProfile, samplerParams, onSaveSamplers, onRefreshProfile }: GenerationSettingsProps) {
  const { t } = useLb()
  const [isExpanded, setIsExpanded] = useState(false)

  const overrides = samplerOverrides || {}
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

  const isActive = overrides.enabled

  return (
    <div className={s.accordionSection}>
      <div
        className={clsx(s.accordionHeader, isActive && s.accordionHeaderActive)}
        onClick={() => { setIsExpanded(!isExpanded); if (!isExpanded) onRefreshProfile() }}
      >
        <Settings2 size={12} style={{ color: isActive ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
        <span className={s.accordionTitle}>{t('settings.samplers')}</span>
        {activeCount > 0 && <span className={s.accordionBadge}>{activeCount}</span>}
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
  // The compiler's hook-name heuristic falsely flags the `useSystemPrompt`
  // boolean setting as a Hook reference. Suppress only this component.
  /* eslint-disable react-compiler/react-compiler */
  const { t } = useLb()
  const { continuePostfixOptions } = useLoomOptionLabels()
  const [isExpanded, setIsExpanded] = useState(false)
  const settings = completionSettings || {}
  const defaults = DEFAULT_COMPLETION_SETTINGS
  const systemPromptKey = 'useSystemPrompt'
  const visibleKeys = Object.keys(defaults).filter(key => key !== 'namesBehavior')
  const systemPromptEnabled = !!(settings[systemPromptKey] ?? defaults[systemPromptKey])

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
            <span className={clsx(s.settingsFieldLabel, s.settingsFieldLabelDefault)}>{t('settings.reasoningPrefill')}</span>
            <textarea className={s.settingsTextarea} style={{ minHeight: '40px' }} value={settings.reasoningPrefill ?? defaults.reasoningPrefill} onChange={e => handleChange('reasoningPrefill', e.target.value)} placeholder={t('settings.reasoningPrefillPlaceholder')} spellCheck={false} />
            <span className={s.settingsHint}>{t('settings.reasoningPrefillHint')}</span>
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
            <Toggle.Checkbox checked={systemPromptEnabled} onChange={v => handleChange('useSystemPrompt', v)} label={t('settings.useSystemPrompt')} />
            <Toggle.Checkbox checked={!!(settings.enableWebSearch ?? defaults.enableWebSearch)} onChange={v => handleChange('enableWebSearch', v)} label={t('settings.enableWebSearch')} />
            <Toggle.Checkbox checked={!!(settings.sendInlineMedia ?? defaults.sendInlineMedia)} onChange={v => handleChange('sendInlineMedia', v)} label={t('settings.sendInlineMedia')} />
            <Toggle.Checkbox checked={!!(settings.enableFunctionCalling ?? defaults.enableFunctionCalling)} onChange={v => handleChange('enableFunctionCalling', v)} label={t('settings.enableFunctionCalling')} />
            <Toggle.Checkbox checked={!!(settings.includeUsage ?? defaults.includeUsage)} onChange={v => handleChange('includeUsage', v)} label={t('settings.includeUsage')} />
          </div>
        </div>
      )}
    </div>
  )
  /* eslint-enable react-compiler/react-compiler */
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
  const trimIncompleteWords: boolean = settings.trimIncompleteWords ?? defaults.trimIncompleteWords
  const namesBehavior = completion.namesBehavior ?? completionDefaults.namesBehavior

  const isActive = seed >= 0 || stopStrings.length > 0 || collapseMessages || trimIncompleteWords || namesBehavior !== completionDefaults.namesBehavior

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
        {isActive && <span className={s.accordionBadge}>{(seed >= 0 ? 1 : 0) + (stopStrings.length > 0 ? 1 : 0) + (collapseMessages ? 1 : 0) + (trimIncompleteWords ? 1 : 0) + (namesBehavior !== completionDefaults.namesBehavior ? 1 : 0)}</span>}
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
          <div className={s.settingsField}>
            <Toggle.Checkbox checked={trimIncompleteWords} onChange={v => onSave({ trimIncompleteWords: v })} label={t('settings.trimIncompleteWords')} hint={t('settings.trimIncompleteWordsHint')} />
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
    <button
      type="button"
      className={clsx(s.contextMeter, s.contextMeterButton)}
      onClick={() => openModal('promptItemizer', { messageId })}
      title={t('context.breakdownTitle')}
      aria-label={`${t('context.breakdownTitle')}: ${total.toLocaleString()}${max > 0 ? ` / ${max.toLocaleString()} (${pct}%)` : ` ${t('tokens')}`}`}
    >
      <div className={s.contextBar} aria-hidden="true">
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
    </button>
  )
}

// ============================================================================
// MAIN LOOM BUILDER COMPONENT
// ============================================================================

interface LoomBuilderProps {
  compact?: boolean
}

function LoomBuilderNative({
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
    saveAgenticRuntime,
    reloadActivePreset,
    deletePreset,
    bulkDeletePresets,
    bulkExportPresets,
    duplicatePreset,
    renamePreset,
    addBlock,
    removeBlock,
    updateBlock,
    toggleBlock,
    toggleCategoryChildren,
    movePromptVariable,
    saveSamplerOverrides,
    savePromptBehavior,
    saveCompletionSettings,
    saveAdvancedSettings,
    savePromptVariableValues: savePresetPromptVariableValues,
    applyRuntimeBlockProfile,
    updatePresetDraft,
    flushPresetDraft,
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  } = useLoomBuilder()

  const presetProfiles = usePresetProfiles(activePresetId, activePreset?.blocks, activePreset?.promptVariables)
  const {
    activeBinding,
    activeSource,
    activeSourceId,
    activeChatId,
    activePersonaId,
    activeCharacterId,
    activeProfileId,
    captureDefaults: captureProfileDefaults,
    defaults,
    isResolved,
    resolvedPresetId,
    saveActivePromptVariableValues,
    selectResolvedPreset,
  } = presetProfiles
  const effectivePromptVariableValues = useMemo(() => getEffectivePromptVariableValues(
    activePreset?.id,
    activePreset?.promptVariables ?? {},
    activeBinding,
  ), [activePreset?.id, activePreset?.promptVariables, activeBinding])
  const promptVariableScopeKey = `${activeSource}:${activeSourceId ?? 'none'}:${activePreset?.id ?? 'none'}`
  const savePromptVariableValues = useCallback(async (values: PromptVariableValues) => {
    // Do not make an already-open modal fail merely because a background
    // profile read has not settled yet. In that case the user is editing the
    // preset currently shown in Loom, so persist its base values.
    if (!isResolved || resolvedPresetId !== activePreset?.id) {
      await savePresetPromptVariableValues(values)
      return
    }
    const savedToProfile = await saveActivePromptVariableValues(values)
    if (!savedToProfile) await savePresetPromptVariableValues(values)
  }, [activePreset?.id, isResolved, resolvedPresetId, saveActivePromptVariableValues, savePresetPromptVariableValues])
  const reloadPromptVariableValues = useCallback(async (): Promise<PromptVariableValues> => {
    const latest = await reloadActivePreset()
    return unmarshalPreset(latest.preset).promptVariables
  }, [reloadActivePreset])
  const presetEditorTabs = __contextMeterStore((state) => state.presetEditorTabs)
  const outerEditorTabIds = useMemo(
    () => ['preset', 'agentic-runtime', ...presetEditorTabs.map((tab) => tab.id)],
    [presetEditorTabs],
  )
  const presetEditorToolbarItems = __contextMeterStore((state) => state.presetEditorToolbarItems)
  const addToast = __contextMeterStore((s) => s.addToast)
  const activePresetRef = useRef(activePreset)
  const suppressNextProfileApplyRef = useRef<string | null>(null)

  const getProfileContextKey = useCallback(() => (
    `${activePresetRef.current?.id ?? 'none'}:${activeChatId ?? 'none'}:${activePersonaId ?? 'none'}:${activeCharacterId ?? 'none'}:${activeProfileId ?? 'none'}`
  ), [activeChatId, activePersonaId, activeCharacterId, activeProfileId])

  const captureDefaults = useCallback(() => {
    suppressNextProfileApplyRef.current = getProfileContextKey()
    void captureProfileDefaults()
  }, [captureProfileDefaults, getProfileContextKey])

  const reapplyDefaults = useCallback(() => {
    const binding = defaults
    if (!binding || !activePreset?.blocks?.length) return

    const updatedBlocks = activePreset.blocks.map(b =>
      b.id in binding.block_states ? { ...b, enabled: binding.block_states[b.id] } : b
    )

    const changed = updatedBlocks.some((b, i) => b.enabled !== activePreset.blocks[i].enabled)
    if (changed) {
      applyRuntimeBlockProfile(activePreset.id, binding.block_states, binding.prompt_variables)
      addToast({ type: 'success', message: lb('profiles.reapplied') })
    } else {
      addToast({ type: 'info', message: lb('profiles.alreadyDefault') })
    }
  }, [defaults, activePreset, applyRuntimeBlockProfile, addToast, lb])

  // Profile block states are a runtime overlay. They must never be written
  // into the shared preset merely because the active chat/persona/connection
  // changed; doing so lets an unrelated preset save capture the wrong scope.
  const lastProfileApplicationRef = useRef<string | null>(null)
  activePresetRef.current = activePreset

  useEffect(() => {
    if (!isResolved) return

    const contextKey = `${activePresetRef.current?.id ?? 'none'}:${activeChatId ?? 'none'}:${activePersonaId ?? 'none'}:${activeCharacterId ?? 'none'}:${activeProfileId ?? 'none'}`
    const binding = activeBinding
    const blockStateKey = binding
      ? JSON.stringify(Object.entries(binding.block_states).sort(([a], [b]) => a.localeCompare(b)))
      : 'none'
    const promptVariableKey = binding?.prompt_variables
      ? JSON.stringify(binding.prompt_variables)
      : 'none'
    const applicationKey = `${contextKey}:${activeSource}:${binding?.preset_id ?? 'none'}:${blockStateKey}:${promptVariableKey}`
    const applicationChanged = lastProfileApplicationRef.current !== applicationKey

    if (
      resolvedPresetId
      && resolvedPresetId !== activePresetRef.current?.id
      && (applicationChanged || !activePresetRef.current?.id)
    ) {
      selectResolvedPreset()
      return
    }

    const activeId = activePresetRef.current?.id
    if (!activeId || !applicationChanged) return
    if (suppressNextProfileApplyRef.current === contextKey) {
      suppressNextProfileApplyRef.current = null
      lastProfileApplicationRef.current = applicationKey
      markLoomRuntimeProfileContext(activeId, activeChatId, activeCharacterId, activeProfileId)
      return
    }
    lastProfileApplicationRef.current = applicationKey
    applyRuntimeBlockProfile(activeId, binding?.block_states ?? null, binding?.prompt_variables)
    markLoomRuntimeProfileContext(
      binding ? activeId : null,
      activeChatId,
      activeCharacterId,
      activeProfileId,
    )
  }, [
    isResolved,
    resolvedPresetId,
    selectResolvedPreset,
    activeBinding,
    activeSource,
    activeChatId,
    activePersonaId,
    activeCharacterId,
    applyRuntimeBlockProfile,
  ])

  const [view, setView] = useState<'list' | 'edit'>('list')
  const [activePresetEditorTab, setActivePresetEditorTab] = useState('preset')
  const [guideOpen, setGuideOpen] = useState(false)
  const [agenticRuntimeDirty, setAgenticRuntimeDirty] = useState(false)
  const agenticRuntimeDirtyRef = useRef(false)
  const blockPresetChangeForDirtyAgenticRuntimeRef = useRef<() => boolean>(() => false)
  const presetSelectionBlockerRef = useRef<ActiveLoomPresetSelectionBlockerRegistration | null>(null)
  const cleanPresetSelectionReleaseRef = useRef<string | null>(null)
  const loomBuilderMountedRef = useRef(true)
  const [editingBlockTarget, setEditingBlockTarget] = useState<LoomBlockOccurrence | null>(null)
  const [blockValidationError, setBlockValidationError] = useState<string | null>(null)
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const [markerMenuOpen, setMarkerMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<LoomBlockOccurrence | null>(null)
  const [confirmDeletePresetId, setConfirmDeletePresetId] = useState<string | null>(null)
  const [showLegacyExportConfirm, setShowLegacyExportConfirm] = useState(false)
  const [showPromptVariablesModal, setShowPromptVariablesModal] = useState(false)
  const [showPromptStashModal, setShowPromptStashModal] = useState(false)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [hoveredAppendRootDropId, setHoveredAppendRootDropId] = useState<string | null>(null)
  const [armedAppendRootDropId, setArmedAppendRootDropId] = useState<string | null>(null)

  const editingBlock = editingBlockTarget
    ? getLoomBlockAtOccurrence(activePreset?.blocks ?? [], editingBlockTarget)
    : null

  useEffect(() => {
    if (editingBlockTarget && !editingBlock) {
      setEditingBlockTarget(null)
      setView('list')
    }
  }, [editingBlock, editingBlockTarget])

  useEffect(() => {
    setShowPromptVariablesModal(false)
  }, [
    presetProfiles.activeChatId,
    presetProfiles.activePersonaId,
    presetProfiles.activeCharacterId,
    presetProfiles.activeProfileId,
  ])
  const outerEditorTabRefs = useRef(new Map<string, HTMLButtonElement>())
  const editorTabChangeRef = useRef<(tabId: string) => boolean>(() => false)

  const activePresetEditorTabRef = useRef(activePresetEditorTab)
  const updatePresetDraftRef = useRef(updatePresetDraft)
  const flushPresetDraftRef = useRef(flushPresetDraft)

  useEffect(() => { activePresetEditorTabRef.current = activePresetEditorTab }, [activePresetEditorTab])
  useEffect(() => { updatePresetDraftRef.current = updatePresetDraft }, [updatePresetDraft])
  useEffect(() => { flushPresetDraftRef.current = flushPresetDraft }, [flushPresetDraft])
  const presetEditorBridgeFailureLoggedRef = useRef(false)
  const safeToPresetEditorDraft = useCallback((preset: LoomPreset) => {
    try {
      return toPresetEditorDraft(preset)
    } catch (error) {
      if (!presetEditorBridgeFailureLoggedRef.current) {
        presetEditorBridgeFailureLoggedRef.current = true
        console.error('[Loom] Preset editor bridge unavailable', error)
      }
      return null
    }
  }, [])


  useEffect(() => {
    setPresetEditorController({
      getState: () => {
        const preset = activePresetRef.current
        if (!preset || preset.id !== __contextMeterStore.getState().activeLoomPresetId) {
          return {
            open: false,
            presetId: null,
            activeTabId: activePresetEditorTabRef.current,
            preset: null,
          }
        }
        const draft = safeToPresetEditorDraft(preset)
        if (!draft) {
          return {
            open: false,
            presetId: null,
            activeTabId: activePresetEditorTabRef.current,
            preset: null,
          }
        }
        return {
          open: true,
          presetId: preset.id,
          activeTabId: activePresetEditorTabRef.current,
          preset: draft,
        }
      },
      setActiveTab: (tabId) => {
        editorTabChangeRef.current(tabId)
      },
      updatePreset: (mutator, immediate) => {
        updatePresetDraftRef.current((current) => {
          const draft = safeToPresetEditorDraft(current)
          if (!draft) return current
          return applyPresetEditorDraft(current, mutator(draft))
        }, immediate)
      },
      flush: () => flushPresetDraftRef.current(),
    })
    return () => { setPresetEditorController(null) }
  }, [])

  useEffect(() => {
    if (!activePreset || activePreset.id !== activePresetId) {
      syncPresetEditorState({
        open: false,
        presetId: null,
        activeTabId: activePresetEditorTab,
        preset: null,
      }, {})
      return
    }
    const draft = safeToPresetEditorDraft(activePreset)
    if (!draft) {
      syncPresetEditorState({
        open: false,
        presetId: null,
        activeTabId: activePresetEditorTab,
        preset: null,
      }, {})
      return
    }
    syncPresetEditorState({
      open: true,
      presetId: activePreset.id,
      activeTabId: activePresetEditorTab,
      preset: draft,
    }, activePreset.promptVariables)
  }, [activePreset, activePresetEditorTab, activePresetId, safeToPresetEditorDraft])

  useEffect(() => {
    if (activePresetEditorTab === 'preset') return
    if (activePresetEditorTab === 'agentic-runtime' && activePreset) return
    if (presetEditorTabs.some((tab) => tab.id === activePresetEditorTab)) return
    editorTabChangeRef.current('preset')
  }, [activePreset, activePresetEditorTab, presetEditorTabs])

  const activePresetExtensionTab = useMemo(
  () =>
    presetEditorTabs.find(
      (tab) => tab.id === activePresetEditorTab,
    ) ?? null,
  [presetEditorTabs, activePresetEditorTab],
)


  const blockPresetChangeForDirtyAgenticRuntime = useCallback(() => {
    if (!agenticRuntimeDirty) return false
    setView('list')
    setEditingBlockTarget(null)
    setActivePresetEditorTab('agentic-runtime')
    addToast({
      type: 'warning',
      message: lb('agenticRuntime.navigation.saveBeforePresetAction'),
    })
    return true
  }, [addToast, agenticRuntimeDirty, lb])
  blockPresetChangeForDirtyAgenticRuntimeRef.current = blockPresetChangeForDirtyAgenticRuntime
  const handleEditorTabChange = useCallback((tabId: string): boolean => {
    if (tabId === activePresetEditorTab) return true
    if (!outerEditorTabIds.includes(tabId)) return false
    if (tabId === 'agentic-runtime' && !activePreset) return false
    if (tabId !== 'agentic-runtime' && blockPresetChangeForDirtyAgenticRuntime()) return false
    setView('list')
    setEditingBlockTarget(null)
    setActivePresetEditorTab(tabId)
    return true
  }, [
    activePreset,
    activePresetEditorTab,
    blockPresetChangeForDirtyAgenticRuntime,
    outerEditorTabIds,
  ])
  editorTabChangeRef.current = handleEditorTabChange

  const handleEditorTabKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLButtonElement>,
    tabId: string,
  ) => {
    const navigableTabIds = outerEditorTabIds.filter((id) => id !== 'agentic-runtime' || !!activePreset)
    const currentIndex = navigableTabIds.indexOf(tabId)
    if (currentIndex < 0) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % navigableTabIds.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + navigableTabIds.length) % navigableTabIds.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = navigableTabIds.length - 1
    }
    if (nextIndex === null) return
    event.preventDefault()
    const nextTabId = navigableTabIds[nextIndex]
    if (!nextTabId || !handleEditorTabChange(nextTabId)) return
    outerEditorTabRefs.current.get(nextTabId)?.focus()
  }, [activePreset, handleEditorTabChange, outerEditorTabIds])

  useLayoutEffect(() => {
    loomBuilderMountedRef.current = true
    return () => {
      loomBuilderMountedRef.current = false
      cleanPresetSelectionReleaseRef.current = null
      const blocker = presetSelectionBlockerRef.current
      presetSelectionBlockerRef.current = null
      blocker?.cancel()
    }
  }, [])
  useLayoutEffect(() => {
    const ownerPresetId = activePreset?.id ?? null
    if (!agenticRuntimeDirty || !ownerPresetId) return
    const blocker = registerActiveLoomPresetSelectionBlocker((presetId) => (
      presetId !== ownerPresetId
        && blockPresetChangeForDirtyAgenticRuntimeRef.current()
    ))
    presetSelectionBlockerRef.current = blocker
    return () => {
      if (presetSelectionBlockerRef.current !== blocker) return
      presetSelectionBlockerRef.current = null
      cleanPresetSelectionReleaseRef.current = null
      blocker.cancel()
    }
  }, [activePreset?.id, agenticRuntimeDirty])
  const handleSaveAgenticRuntime = useCallback(async (
    ...args: Parameters<typeof saveAgenticRuntime>
  ) => {
    const result = await saveAgenticRuntime(...args)
    if (activePresetRef.current?.id === result.editor.presetId) {
      cleanPresetSelectionReleaseRef.current = result.editor.presetId
    }
    return result
  }, [saveAgenticRuntime])
  const handleReloadActivePreset = useCallback(async () => {
    const result = await reloadActivePreset()
    if (activePresetRef.current?.id === result.editor.presetId) {
      cleanPresetSelectionReleaseRef.current = result.editor.presetId
    }
    return result
  }, [reloadActivePreset])
  const handleAgenticRuntimeDirtyChange = useCallback((dirty: boolean) => {
    agenticRuntimeDirtyRef.current = dirty
    setAgenticRuntimeDirty(dirty)
    if (dirty) return
    const cleanPresetId = cleanPresetSelectionReleaseRef.current
    if (!cleanPresetId) return
    scheduleLowPriorityTask(() => {
      if (
        !loomBuilderMountedRef.current
        || agenticRuntimeDirtyRef.current
        || cleanPresetSelectionReleaseRef.current !== cleanPresetId
        || activePresetRef.current?.id !== cleanPresetId
      ) return
      cleanPresetSelectionReleaseRef.current = null
      const blocker = presetSelectionBlockerRef.current
      presetSelectionBlockerRef.current = null
      blocker?.release()
    }, { label: 'release Loom preset selection blocker' })
  }, [])
  useEffect(() => {
    if (!agenticRuntimeDirty || typeof window === 'undefined') return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [agenticRuntimeDirty])
  useEffect(() => {
    setGuideOpen(false)
  }, [activePresetEditorTab])

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

  const promptOrderBlocks = activePreset?.blocks ?? []
  const groups = useMemo(() => computeGroups(promptOrderBlocks), [activePreset?.blocks])
  const blockOccurrences = useMemo(() => new Map(
    promptOrderBlocks.map((block, promptOrder) => [block, { blockId: block.id, promptOrder }] as const),
  ), [activePreset?.blocks])
  const effectiveBlocks = useMemo(() => resolvePromptBlockPlacements(
    promptOrderBlocks,
    activePreset?.promptVariables ?? {},
  ), [activePreset?.blocks, activePreset?.promptVariables])
  const categoryIds = useMemo(
    () => promptOrderBlocks
      .map((block, promptOrder) => ({ block, promptOrder }))
      .filter(({ block }) => block.marker === 'category')
      .map(({ block, promptOrder }) => encodeLoomBlockOccurrence({ blockId: block.id, promptOrder })),
    [activePreset?.blocks],
  )
  const allCategoriesCollapsed = categoryIds.length > 0
    && categoryIds.every((categoryId) => collapsedCategories.has(categoryId))

  const searchTokens = useMemo(
    () => deferredTrimmedSearchQuery.toLowerCase().split(/\s+/).filter(Boolean),
    [deferredTrimmedSearchQuery],
  )

  const searchableBlockText = useMemo(() => new Map(promptOrderBlocks
    .map((block, promptOrder) => ({ block, promptOrder }))
    .filter(({ block }) => block.marker !== 'category')
    .map(({ block, promptOrder }) => [
      encodeLoomBlockOccurrence({ blockId: block.id, promptOrder }),
      `${block.name}\n${block.content || ''}`.toLowerCase(),
    ] as const)), [activePreset?.blocks])

  const isSearchActive = searchTokens.length > 0

  const displayedGroups = useMemo<CategoryGroup[]>(() => {
    if (!isSearchActive) return groups

    return groups
      .map((group) => ({
        ...group,
        children: group.children.filter((block) => {
          const target = blockOccurrences.get(block)
          const searchableText = target
            ? searchableBlockText.get(encodeLoomBlockOccurrence(target)) ?? ''
            : ''
          return searchTokens.every((token) => searchableText.includes(token))
        }),
      }))
      .filter((group) => group.children.length > 0)
  }, [blockOccurrences, groups, isSearchActive, searchableBlockText, searchTokens])

  const searchMatchCount = useMemo(
    () => displayedGroups.reduce((count, group) => count + group.children.length, 0),
    [displayedGroups],
  )

  useEffect(() => {
    if (activePreset?.blocks && activePresetId && activePresetId !== lastCollapsedPresetRef.current) {
      lastCollapsedPresetRef.current = activePresetId
      setCollapsedCategories(new Set(categoryIds))
    }
  }, [activePresetId, activePreset?.blocks, categoryIds])

  useEffect(() => {
    setIsSearchOpen(false)
    setSearchQuery('')
  }, [activePresetId])

  useEffect(() => {
    if (!isSearchVisible) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isSearchVisible])

  useEffect(() => {
    if (!hoveredAppendRootDropId) {
      setArmedAppendRootDropId(null)
      return
    }

    const timer = window.setTimeout(() => {
      setArmedAppendRootDropId(hoveredAppendRootDropId)
    }, 3000)

    return () => {
      window.clearTimeout(timer)
      setArmedAppendRootDropId(null)
    }
  }, [hoveredAppendRootDropId])

  const visibleBlockIds = useMemo(() => {
    const ids: string[] = []
    const appendOccurrence = (block: PromptBlock) => {
      const target = blockOccurrences.get(block)
      if (target) ids.push(encodeLoomBlockOccurrence(target))
    }
    for (const group of displayedGroups) {
      if (group.categoryBlock) {
        const categoryTarget = blockOccurrences.get(group.categoryBlock)
        const categoryId = categoryTarget ? encodeLoomBlockOccurrence(categoryTarget) : null
        appendOccurrence(group.categoryBlock)
        if (isSearchActive || !categoryId || !collapsedCategories.has(categoryId)) {
          for (const child of group.children) appendOccurrence(child)
        }
      } else {
        for (const child of group.children) appendOccurrence(child)
      }
    }
    return ids
  }, [blockOccurrences, displayedGroups, collapsedCategories, isSearchActive])

  const activeDraggedBlock = useMemo(() => {
    const target = decodeLoomBlockOccurrence(activeDragId)
    return target ? getLoomBlockAtOccurrence(promptOrderBlocks, target) : null
  }, [activeDragId, activePreset?.blocks])

  const rootDropIndexAfterGroup = useCallback((group: CategoryGroup) => {
    const blocks = activePreset?.blocks ?? []
    if (group.categoryBlock) {
      const categoryIndex = blocks.indexOf(group.categoryBlock)
      if (categoryIndex === -1) return blocks.length
      let endIndex = categoryIndex + 1
      while (endIndex < blocks.length) {
        const block = blocks[endIndex]
        if (block.marker === 'category') break
        if (hasExplicitGroup(block) && blockGroup(block) !== group.categoryBlock.id) break
        endIndex += 1
      }
      return endIndex
    }

    const childIndexes = group.children
      .map((child) => blocks.indexOf(child))
      .filter((index) => index >= 0)
    return childIndexes.length > 0 ? Math.max(...childIndexes) + 1 : blocks.length
  }, [activePreset?.blocks])

  const toggleCollapse = useCallback((categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }, [])

  const toggleAllCategories = useCallback(() => {
    setCollapsedCategories((current) => {
      const shouldExpand = categoryIds.length > 0
        && categoryIds.every((categoryId) => current.has(categoryId))
      if (shouldExpand) return new Set()
      return new Set(categoryIds)
    })
  }, [categoryIds])

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
    setActiveDragId(null)
    setHoveredAppendRootDropId(null)
    setArmedAppendRootDropId(null)
    if (!over || active.id === over.id || !activePreset) return

    const blocks = activePreset.blocks
    const draggedTarget = decodeLoomBlockOccurrence(active.id)
    const draggedBlock = draggedTarget ? getLoomBlockAtOccurrence(blocks, draggedTarget) : null
    if (!draggedTarget || !draggedBlock) return
    const reorderedEntries: LoomBlockReorderEntry[] = blocks.map((block, promptOrder) => ({
      block,
      source: { blockId: block.id, promptOrder },
    }))
    const saveReorderedBlocks = (entries: LoomBlockReorderEntry[]) => {
      saveBlocks(remapCategorySnapshotsForReorder(blocks, entries))
    }
    const rootDropIndex = parseRootDropId(over.id)
    const armedAppendCategory = armedAppendRootDropId === over.id ? parseRootDropCategoryId(over.id) : null

    if (draggedBlock.marker === 'category') {
      const catIdx = draggedTarget.promptOrder
      let endIdx = blocks.length
      for (let i = catIdx + 1; i < blocks.length; i++) {
        if (blocks[i].marker === 'category') { endIdx = i; break }
        if (hasExplicitGroup(blocks[i]) && blockGroup(blocks[i]) !== draggedBlock.id) { endIdx = i; break }
      }
      const group = reorderedEntries.slice(catIdx, endIdx)
      const remaining = [...reorderedEntries.slice(0, catIdx), ...reorderedEntries.slice(endIdx)]
      const overTarget = decodeLoomBlockOccurrence(over.id)
      const overBlock = overTarget ? getLoomBlockAtOccurrence(blocks, overTarget) : null
      const overIdx = rootDropIndex == null
        ? overBlock && overTarget
          ? remaining.findIndex((entry) => (
              entry.source?.promptOrder === overTarget.promptOrder
              && entry.source.blockId === overTarget.blockId
            ))
          : -1
        : Math.max(0, Math.min(remaining.length, rootDropIndex > catIdx ? rootDropIndex - group.length : rootDropIndex))
      if (overIdx === -1) return
      remaining.splice(overIdx, 0, ...group)
      saveReorderedBlocks(remaining)
      return
    }

    const oldIndex = draggedTarget.promptOrder
    if (armedAppendCategory) {
      const category = getLoomBlockAtOccurrence(blocks, armedAppendCategory)
      const endIndex = getCategoryEndIndex(blocks, armedAppendCategory)
      if (!category || endIndex === -1) return
      const nextBlocks = [...reorderedEntries]
      const [moved] = nextBlocks.splice(oldIndex, 1)
      if (!moved) return
      const insertAt = Math.max(0, Math.min(nextBlocks.length, endIndex > oldIndex ? endIndex - 1 : endIndex))
      nextBlocks.splice(insertAt, 0, { ...moved, block: { ...moved.block, group: category.id } })
      saveReorderedBlocks(nextBlocks)
      return
    }

    if (rootDropIndex != null) {
      const nextBlocks = [...reorderedEntries]
      const [moved] = nextBlocks.splice(oldIndex, 1)
      if (!moved) return
      const insertAt = Math.max(0, Math.min(nextBlocks.length, rootDropIndex > oldIndex ? rootDropIndex - 1 : rootDropIndex))
      nextBlocks.splice(insertAt, 0, { ...moved, block: { ...moved.block, group: null } })
      saveReorderedBlocks(nextBlocks)
      return
    }

    const overTarget = decodeLoomBlockOccurrence(over.id)
    const overBlock = overTarget ? getLoomBlockAtOccurrence(blocks, overTarget) : null
    if (!overTarget || !overBlock) return
    const newIndex = overTarget.promptOrder
    if (overBlock.marker === 'category') {
      const nextBlocks = [...reorderedEntries]
      const [moved] = nextBlocks.splice(oldIndex, 1)
      if (!moved) return
      const insertAt = newIndex > oldIndex ? newIndex : newIndex + 1
      nextBlocks.splice(insertAt, 0, { ...moved, block: { ...moved.block, group: overBlock.id } })
      saveReorderedBlocks(nextBlocks)
      return
    }

    const movedGroup = inferGroupAtIndex(blocks, newIndex)
    const reordered = arrayMove(reorderedEntries, oldIndex, newIndex)
    const moved = reordered[newIndex]
    if (!moved) return
    reordered[newIndex] = { ...moved, block: { ...moved.block, group: movedGroup } }
    saveReorderedBlocks(reordered)
  }, [activePreset, armedAppendRootDropId, saveBlocks])

  const handleDragOver = useCallback((event: any) => {
    const activeTarget = decodeLoomBlockOccurrence(event.active?.id)
    const activeBlock = activeTarget
      ? getLoomBlockAtOccurrence(activePreset?.blocks ?? [], activeTarget)
      : null
    const appendCategory = parseRootDropCategoryId(event.over?.id)
    setHoveredAppendRootDropId(appendCategory && activeBlock?.marker !== 'category' ? event.over.id : null)
  }, [activePreset?.blocks])

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null)
    setHoveredAppendRootDropId(null)
    setArmedAppendRootDropId(null)
  }, [])
  const handleEdit = useCallback((target: LoomBlockOccurrence) => {
    setBlockValidationError(null)
    setEditingBlockTarget(target)
    setView('edit')
  }, [])

  const handleEditSave = useCallback((updates: Partial<PromptBlock>): boolean => {
    if (!editingBlockTarget || !editingBlock) return false
    const accepted = updateBlock(editingBlockTarget, updates)
    if (!accepted) {
      setBlockValidationError(lb('blockEditor.validationFailed'))
      return false
    }
    setBlockValidationError(null)
    setView('list')
    setEditingBlockTarget(null)
    return true
  }, [editingBlock, editingBlockTarget, lb, updateBlock])

  const handleAddTemplate = useCallback((template: { name: string; content: string; role: string }) => {
    addBlock(createBlock({ name: template.name, content: template.content, role: template.role as PromptBlock['role'] }))
    setPromptMenuOpen(false)
  }, [addBlock])

  const handleInsertStashedBlock = useCallback((entry: StashedPromptBlock) => {
    addBlock(createBlock({ ...entry.block, stashId: entry.id }))
  }, [addBlock])

  const handleAddToStash = useCallback(async (target: LoomBlockOccurrence, block: PromptBlock) => {
    try {
      const entry = await presetsApi.addToStash(block, activePreset?.id)
      updateBlock(target, { stashId: entry.id })
      addToast({ type: 'success', message: lb('actions.addedToStash') })
    } catch {
      addToast({ type: 'error', message: lb('actions.stashFailed') })
    }
  }, [activePreset?.id, addToast, lb, updateBlock])

  const handleAddCategory = useCallback(() => {
    addBlock(createMarkerBlock('category', lb('actions.newCategory')))
  }, [addBlock, lb])

  const handleAddMarker = useCallback((type: string) => {
    addBlock(createMarkerBlock(type))
    setMarkerMenuOpen(false)
  }, [addBlock])

  const handleDelete = useCallback((target: LoomBlockOccurrence) => {
    setConfirmDelete(target)
  }, [])

  const confirmDeleteBlock = useCallback(() => {
    if (confirmDelete) {
      void removeBlock(confirmDelete)
      setConfirmDelete(null)
    }
  }, [confirmDelete, removeBlock])

  const handleSelectPreset = useCallback((presetId: string | null) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    selectPreset(presetId)
  }, [blockPresetChangeForDirtyAgenticRuntime, selectPreset])

  const handleCreatePreset = useCallback((name: string) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    void createPreset(name)
  }, [blockPresetChangeForDirtyAgenticRuntime, createPreset])

  const handleRenamePreset = useCallback(async (presetId: string, newName: string) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    await renamePreset(presetId, newName)
  }, [blockPresetChangeForDirtyAgenticRuntime, renamePreset])

  const handleDuplicatePreset = useCallback(async (presetId: string, presetName: string) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    await duplicatePreset(presetId, presetName + lb('preset.copySuffix'))
  }, [blockPresetChangeForDirtyAgenticRuntime, duplicatePreset, lb])

  const handleBulkDeletePresets = useCallback(async (presetIds: string[]) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return null
    return bulkDeletePresets(presetIds)
  }, [blockPresetChangeForDirtyAgenticRuntime, bulkDeletePresets])

  const handleBulkExportPresets = useCallback(async (presetIds: string[]) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return null
    return bulkExportPresets(presetIds)
  }, [blockPresetChangeForDirtyAgenticRuntime, bulkExportPresets])

  const handleRequestDeletePreset = useCallback((presetId: string) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    setConfirmDeletePresetId(presetId)
  }, [blockPresetChangeForDirtyAgenticRuntime])

  const handleDeletePreset = useCallback(async () => {
    if (!confirmDeletePresetId || blockPresetChangeForDirtyAgenticRuntime()) return
    const presetId = confirmDeletePresetId
    setConfirmDeletePresetId(null)
    await deletePreset(presetId)
  }, [blockPresetChangeForDirtyAgenticRuntime, confirmDeletePresetId, deletePreset])

  const handleExport = useCallback(async (presetId: string) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    try {
      const data = await exportInternal(presetId)
      if (!data) return
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${data.name || 'loom-preset'}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      const code = getPortablePresetErrorCode(err)
      toast.error(lb(`toast.portableErrors.${code}`), {
        title: lb('toast.presetImportTitle'),
      })
    }
  }, [blockPresetChangeForDirtyAgenticRuntime, exportInternal, lb])

  const handleRequestLegacyExport = useCallback(() => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    setShowLegacyExportConfirm(true)
  }, [blockPresetChangeForDirtyAgenticRuntime])

  const handleExportLegacy = useCallback(() => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    try {
      const data = exportLegacy()
      if (!data) return
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const dataRecord = data as Record<string, unknown>
      a.download = `${typeof dataRecord.name === 'string' ? dataRecord.name : 'preset'}.json`
      a.click()
      URL.revokeObjectURL(url)
      setShowLegacyExportConfirm(false)
    } catch (err: unknown) {
      const code = getPortablePresetErrorCode(err)
      toast.error(lb(`toast.portableErrors.${code}`), {
        title: lb('toast.presetImportTitle'),
      })
    }
  }, [blockPresetChangeForDirtyAgenticRuntime, exportLegacy, lb])

  const handleImport = useCallback((type: string) => {
    if (blockPresetChangeForDirtyAgenticRuntime()) return
    importTypeRef.current = type
    fileInputRef.current?.click()
  }, [blockPresetChangeForDirtyAgenticRuntime])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (blockPresetChangeForDirtyAgenticRuntime()) {
      e.target.value = ''
      return
    }
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      if (importTypeRef.current === 'st') {
        await importFromST(json, file.name)
      } else {
        await importFromFile(json, file.name)
      }
    } catch (err: unknown) {
      const code = getPortablePresetErrorCode(err)
      toast.error(lb(`toast.portableErrors.${code}`), {
        title: lb('toast.presetImportTitle'),
      })
    }
    e.target.value = ''
  }, [blockPresetChangeForDirtyAgenticRuntime, importFromFile, importFromST, lb])

  const presetEditorToolbar = presetEditorToolbarItems.some((item) => item.visible) ? (
    <div className={s.extensionToolbar}>
      {presetEditorToolbarItems.filter((item) => item.visible).map((item) => (
        <SpindlePresetEditorToolbarItem key={item.id} item={item} />
      ))}
    </div>
  ) : null

  // Edit view
  if (activePresetEditorTab === 'preset' && view === 'edit' && editingBlockTarget && editingBlock) {
    return (
      <>
        {presetEditorToolbar}
        <span data-spindle-mount="preset_editor_toolbar" data-spindle-scope={`loom:${activePreset?.id ?? activePresetId ?? 'none'}:preset-toolbar`} style={{ display: 'contents' }} />
        <span data-spindle-mount="loom_builder_toolbar" data-spindle-scope={`loom:${activePreset?.id ?? activePresetId ?? 'none'}:builder-toolbar`} style={{ display: 'contents' }} />
        <span data-spindle-mount="loom_builder_inspector" data-spindle-scope={`loom:${activePreset?.id ?? activePresetId ?? 'none'}:inspector`} style={{ display: 'contents' }} />
        <BlockEditor
          block={editingBlock}
          blockOccurrence={editingBlockTarget}
          blocks={activePreset?.blocks ?? []}
          promptVariables={activePreset?.promptVariables ?? {}}
          validationError={blockValidationError}
          onSave={handleEditSave}
          onBack={() => {
            setBlockValidationError(null)
            setView('list')
            setEditingBlockTarget(null)
          }}
          availableMacros={availableMacros}
          refreshMacros={refreshMacros}
          compact={compact}
          trustedHostFeatures={true}
          onMoveVariable={movePromptVariable}
        />
      </>
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
            onSelect={handleSelectPreset}
            onCreate={handleCreatePreset}
            onRename={handleRenamePreset}
            onDuplicate={handleDuplicatePreset}
            onDelete={handleRequestDeletePreset}
            onBulkDelete={handleBulkDeletePresets}
            onBulkExport={handleBulkExportPresets}
            onImport={handleImport}
            onExport={handleExport}
            onExportLegacy={handleRequestLegacyExport}
          />
          <div className={s.toolbarActions}>
            <button
              type="button"
              className={clsx(s.btn, s.searchToggle, isSearchVisible && s.searchToggleActive)}
              onClick={toggleSearch}
              disabled={!activePreset}
              aria-label={isSearchVisible ? lb('search.close') : lb('search.search')}
              title={isSearchVisible ? lb('search.closeTitle') : lb('search.openTitle')}
            >
              <Search size={14} />
              <span className={s.toolbarButtonLabel}>{isSearchVisible ? lb('search.close') : lb('search.search')}</span>
            </button>
            <button
              type="button"
              className={clsx(s.btn, s.categoryToggle)}
              onClick={toggleAllCategories}
              disabled={categoryIds.length === 0 || isSearchActive}
              aria-label={allCategoriesCollapsed ? lb('category.expandAll') : lb('category.collapseAll')}
              title={isSearchActive
                ? lb('category.bulkUnavailableSearch')
                : allCategoriesCollapsed
                  ? lb('category.expandAll')
                  : lb('category.collapseAll')}
            >
              {allCategoriesCollapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className={s.toolbarButtonLabel}>{allCategoriesCollapsed ? lb('category.expandAll') : lb('category.collapseAll')}</span>
            </button>
            <span data-spindle-mount="loom_builder_toolbar" data-spindle-scope={`loom:${activePreset?.id ?? activePresetId ?? 'none'}:builder-toolbar`} style={{ display: 'contents' }} />
          </div>
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

        {presetEditorToolbar}
        <span data-spindle-mount="preset_editor_toolbar" data-spindle-scope={`loom:${activePreset?.id ?? activePresetId ?? 'none'}:preset-toolbar`} style={{ display: 'contents' }} />

        <div
          className={s.extensionTabRow}
        >
          <div
            className={s.extensionTabBar}
            role="tablist"
            aria-label={lb('editorTabs.ariaLabel')}
            aria-orientation="horizontal"
          >
            <button
              ref={(element) => {
                if (element) outerEditorTabRefs.current.set('preset', element)
                else outerEditorTabRefs.current.delete('preset')
              }}
              type="button"
              role="tab"
              id={outerEditorDomId('tab', 'preset')}
              aria-controls={outerEditorDomId('panel', 'preset')}
              aria-selected={activePresetEditorTab === 'preset'}
              tabIndex={activePresetEditorTab === 'preset' ? 0 : -1}
              className={clsx(
                s.extensionTab,
                activePresetEditorTab === 'preset' && s.extensionTabActive,
              )}
              onClick={() => handleEditorTabChange('preset')}
              onKeyDown={(event) => handleEditorTabKeyDown(event, 'preset')}
            >
              {lb('editorTabs.preset')}
            </button>
            <button
              ref={(element) => {
                if (element) outerEditorTabRefs.current.set('agentic-runtime', element)
                else outerEditorTabRefs.current.delete('agentic-runtime')
              }}
              type="button"
              role="tab"
              id={outerEditorDomId('tab', 'agentic-runtime')}
              aria-controls={outerEditorDomId('panel', 'agentic-runtime')}
              aria-selected={activePresetEditorTab === 'agentic-runtime'}
              tabIndex={activePresetEditorTab === 'agentic-runtime' ? 0 : -1}
              className={clsx(
                s.extensionTab,
                activePresetEditorTab === 'agentic-runtime' && s.extensionTabActive,
              )}
              onClick={() => handleEditorTabChange('agentic-runtime')}
              onKeyDown={(event) => handleEditorTabKeyDown(event, 'agentic-runtime')}
              disabled={!activePreset}
            >
              {lb('editorTabs.agenticRuntime')}
            </button>
            {presetEditorTabs.map((tab) => (
              <button
                ref={(element) => {
                  if (element) outerEditorTabRefs.current.set(tab.id, element)
                  else outerEditorTabRefs.current.delete(tab.id)
                }}
                key={tab.id}
                type="button"
                role="tab"
                id={outerEditorDomId('tab', tab.id)}
                aria-controls={outerEditorDomId('panel', tab.id)}
                aria-selected={activePresetEditorTab === tab.id}
                tabIndex={activePresetEditorTab === tab.id ? 0 : -1}
                className={clsx(
                  s.extensionTab,
                  activePresetEditorTab === tab.id && s.extensionTabActive,
                )}
                onClick={() => handleEditorTabChange(tab.id)}
                onKeyDown={(event) => handleEditorTabKeyDown(event, tab.id)}
              >
                {tab.title}
              </button>
            ))}
            <span
              data-spindle-mount="preset_editor_tab"
              data-spindle-scope={'loom:' + (activePreset?.id ?? activePresetId ?? 'none') + ':preset-tab'}
              style={{ display: 'contents' }}
            />
          </div>

          {activePresetExtensionTab?.guide && (
            <button
              type="button"
              className={s.extensionGuideButton}
              onClick={() => setGuideOpen(true)}
              aria-label={`Open guide for ${activePresetExtensionTab.title}`}
              title="Open guide"
            >
              <CircleHelp size={15} strokeWidth={1.7} />
            </button>
          )}
        </div>
      {presetEditorTabs.map((tab) => (
        <div
          key={tab.id}
          className={s.extensionTabContent}
          role="tabpanel"
          id={outerEditorDomId('panel', tab.id)}
          aria-labelledby={outerEditorDomId('tab', tab.id)}
          tabIndex={0}
          hidden={activePresetEditorTab !== tab.id}
        >
          {activePresetEditorTab === tab.id && (
            <SpindlePresetEditorTabContent tab={tab} />
          )}
        </div>
      ))}

      <div
        className={s.agentsTabContent}
        role="tabpanel"
        id={outerEditorDomId('panel', 'agentic-runtime')}
        aria-labelledby={outerEditorDomId('tab', 'agentic-runtime')}
        tabIndex={0}
        hidden={!activePreset || activePresetEditorTab !== 'agentic-runtime'}
      >
        {activePreset && (
          <AgenticRuntimePanel
            key={activePreset.id}
            preset={activePreset}
            onSave={handleSaveAgenticRuntime}
            onReload={handleReloadActivePreset}
            onDirtyChange={handleAgenticRuntimeDirtyChange}
          />
        )}
      </div>

    {activePresetExtensionTab?.guide && (
  <GuideViewer
    isOpen={guideOpen}
    onClose={() => setGuideOpen(false)}
    guide={{
      kind: 'markdown',
      ...activePresetExtensionTab.guide,
    }}
    title={activePresetExtensionTab.title}
  />
)}

      <div
        role="tabpanel"
        id={outerEditorDomId('panel', 'preset')}
        aria-labelledby={outerEditorDomId('tab', 'preset')}
        tabIndex={0}
        hidden={activePresetEditorTab !== 'preset'}
        style={{ display: activePresetEditorTab === 'preset' ? 'contents' : 'none' }}
      >

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

            {/* Bind / unbind active persona. Persona profiles outrank character
                profiles, so switching persona restores its own writing mode. */}
            {!presetProfiles.hasPersonaBinding ? (
              <button
                className={s.profileBtn}
                onClick={presetProfiles.bindToPersona}
                disabled={!presetProfiles.hasDefaults || presetProfiles.isLoading || !activePreset || !presetProfiles.activePersonaId}
                title={
                  !presetProfiles.activePersonaId ? lb('profiles.noPersona')
                    : !presetProfiles.hasDefaults ? lb('profiles.captureFirst')
                      : lb('profiles.bindPersona')
                }
                type="button"
              >
                <Link size={10} /> {lb('profiles.persona')}
              </button>
            ) : (
              <button
                className={clsx(s.profileBtn, s.profileBtnActive)}
                onClick={presetProfiles.bindToPersona}
                disabled={presetProfiles.isLoading || !presetProfiles.activePersonaId}
                title={lb('profiles.rebindPersona')}
                type="button"
              >
                <RotateCcw size={10} /> {lb('profiles.persona')}
                <span
                  className={s.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); presetProfiles.unbindPersona() }}
                  title={lb('profiles.removePersona')}
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
               presetProfiles.activeSource === 'persona' ? lb('profiles.sourcePersona') :
               presetProfiles.activeSource === 'character' ? lb('profiles.sourceCharacter') :
               presetProfiles.activeSource === 'connection' ? lb('profiles.sourceConnection') : lb('profiles.sourceDefault')}
            </span>
          )}
        </div>
      )}

      {/* Scrollable content: settings + block list */}
      <div className={s.scrollArea} ref={scrollAreaRef} onScroll={handleScrollCapture}>
        {activePreset && <PresetCoverHeader preset={activePreset} />}

        {/* Settings accordion sections */}
        {activePreset && (
          <GenerationSettings
            samplerOverrides={activePreset.samplerOverrides}
            connectionProfile={connectionProfile}
            samplerParams={samplerParams}
            onSaveSamplers={saveSamplerOverrides}
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
              // A cached profile lookup must not make this action inert. The
              // input bar opens the same modal from the active preset; Loom
              // uses base values if the scoped profile is still resolving.
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
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={(event) => setActiveDragId(String(event.active.id))}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={visibleBlockIds} strategy={verticalListSortingStrategy}>
                <RootDropSlot id={rootDropId(0)} active={!!activeDragId && !isSearchActive} />
                {displayedGroups.map((group) => {
                  const categoryTarget = group.categoryBlock
                    ? blockOccurrences.get(group.categoryBlock) ?? null
                    : null
                  const categoryOccurrenceId = categoryTarget
                    ? encodeLoomBlockOccurrence(categoryTarget)
                    : null
                  const firstChildTarget = group.children[0]
                    ? blockOccurrences.get(group.children[0]) ?? null
                    : null
                  const groupKey = categoryOccurrenceId
                    ?? (firstChildTarget ? encodeLoomBlockOccurrence(firstChildTarget) : `ungrouped:${rootDropIndexAfterGroup(group)}`)
                  const categoryCollapsed = !!categoryOccurrenceId && collapsedCategories.has(categoryOccurrenceId)
                  const endDropId = rootDropId(rootDropIndexAfterGroup(group), categoryOccurrenceId ?? undefined)
                  return (
                    <Fragment key={groupKey}>
                      {group.categoryBlock && categoryTarget && (
                        <SortableCategoryItem
                          block={group.categoryBlock}
                          occurrence={categoryTarget}
                          isCollapsed={isSearchActive ? false : categoryCollapsed}
                          onToggleCollapse={isSearchActive ? () => {} : () => toggleCollapse(categoryOccurrenceId!)}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onToggle={toggleBlock}
                          onToggleChildren={toggleCategoryChildren}
                          childCount={group.children.length}
                          dragDisabled={isSearchActive}
                        />
                      )}
                      {(!group.categoryBlock || isSearchActive || !categoryCollapsed) &&
                        group.children.map((block) => {
                          const occurrence = blockOccurrences.get(block)
                          if (!occurrence) return null
                          return (
                            <SortableBlockItem
                              key={encodeLoomBlockOccurrence(occurrence)}
                              block={block}
                              occurrence={occurrence}
                              effectiveRole={effectiveBlocks[occurrence.promptOrder]?.role}
                              onEdit={handleEdit}
                              onDelete={handleDelete}
                              onToggle={toggleBlock}
                              onStash={handleAddToStash}
                              indented={!!group.categoryBlock}
                              dragDisabled={isSearchActive}
                            />
                          )
                        })
                      }
                      <RootDropSlot
                        id={endDropId}
                        active={!!activeDragId && !isSearchActive}
                        appendArmed={!!activeDraggedBlock && activeDraggedBlock.marker !== 'category' && armedAppendRootDropId === endDropId}
                      />
                    </Fragment>
                  )
                })}
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

          <button className={s.btn} onClick={() => setShowPromptStashModal(true)} type="button">
            <Archive size={14} /> {lb('actions.fromStash')}
          </button>

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
      </div>

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
          isOpen={!!confirmDeletePresetId}
          zIndex={10004}
          title={lb('confirm.deletePresetTitle')}
          message={lb('confirm.deletePresetMessage', { name: confirmDeletePresetId ? registry[confirmDeletePresetId]?.name : '' })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { void handleDeletePreset() }}
          onCancel={() => setConfirmDeletePresetId(null)}
        />

        {activePreset && (
          <PromptVariablesModal
            key={promptVariableScopeKey}
            isOpen={showPromptVariablesModal}
            blocks={activePreset.blocks}
            values={effectivePromptVariableValues}
            onSave={savePromptVariableValues}
            onReloadLatest={reloadPromptVariableValues}
            onClose={() => setShowPromptVariablesModal(false)}
          />
        )}
        <PromptStashModal
          isOpen={showPromptStashModal}
          onClose={() => setShowPromptStashModal(false)}
          onSelect={handleInsertStashedBlock}
        />
      </div>
    </PanelFadeIn>
  )
}

export default function LoomBuilder(props: LoomBuilderProps) {
  return useSpindleComponentOverride('LoomBuilder', LoomBuilderNative, props)
}
