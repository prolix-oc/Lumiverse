import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import clsx from 'clsx'
import {
  Compass,
  CornerDownLeft,
  GripVertical,
  Home,
  Layers,
  Link2,
  ListChecks,
  MessageSquare,
  MessageSquareQuote,
  MoreHorizontal,
  RotateCcw,
  RotateCw,
  Search,
  Sliders,
  UserCircle,
  Waypoints,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { useQuickToolbarActions, type ToolbarAction } from '@/components/quick-toolbar/useQuickToolbarActions'
import { IconPlaylistAdd } from '@tabler/icons-react'
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
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { Toggle } from '@/components/shared/Toggle'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import { filterActionIds, filterActions } from '@/lib/toolbarActionSearch'
import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'
import styles from './InputArea.module.css'

/** localStorage key — no store slice exists on the InputArea allowlist. */
export const COMPOSER_ACTION_BAR_STORAGE_KEY = 'lumiverse.composerActionBar'

export const COMPOSER_ACTION_IDS = [
  'home',
  'regen',
  'continue',
  'agentRetry',
  'oneliner',
  'persona',
  'connections',
  'connectionsPicker',
  'altFields',
  'addons',
  'guides',
  'quickReplies',
  'promptVariables',
  'tools',
  'extras',
  'selectMessages',
] as const

export type ComposerActionId = (typeof COMPOSER_ACTION_IDS)[number]

/** QT extras that share a native composer id (`connections`) persist under this prefix. */
export const COMPOSER_QT_PREFIX = 'qt:'

export interface ComposerActionBarState {
  order: string[]
  hidden: string[]
}

export type ComposerActionIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

export interface ComposerActionItem {
  id: string
  label: string
  description: string
  icon: ComposerActionIcon
  keywords?: string[]
}

export const COMPOSER_ACTION_CATALOG: ComposerActionItem[] = [
  { id: 'home', label: 'composerCustomize.actions.home.label', description: 'composerCustomize.actions.home.description', icon: Home },
  { id: 'regen', label: 'composerCustomize.actions.regen.label', description: 'composerCustomize.actions.regen.description', icon: RotateCw },
  { id: 'continue', label: 'composerCustomize.actions.continue.label', description: 'composerCustomize.actions.continue.description', icon: CornerDownLeft },
  { id: 'agentRetry', label: 'composerCustomize.actions.agentRetry.label', description: 'composerCustomize.actions.agentRetry.description', icon: RotateCw },
  { id: 'oneliner', label: 'composerCustomize.actions.oneliner.label', description: 'composerCustomize.actions.oneliner.description', icon: MessageSquare },
  { id: 'persona', label: 'composerCustomize.actions.persona.label', description: 'composerCustomize.actions.persona.description', icon: UserCircle },
  { id: 'connections', label: 'composerCustomize.actions.connections.label', description: 'composerCustomize.actions.connections.description', icon: Link2 },
  { id: 'connectionsPicker', label: 'composerCustomize.actions.connectionsPicker.label', description: 'composerCustomize.actions.connectionsPicker.description', icon: Waypoints },
  { id: 'altFields', label: 'composerCustomize.actions.altFields.label', description: 'composerCustomize.actions.altFields.description', icon: Layers },
  { id: 'addons', label: 'composerCustomize.actions.addons.label', description: 'composerCustomize.actions.addons.description', icon: IconPlaylistAdd },
  { id: 'guides', label: 'composerCustomize.actions.guides.label', description: 'composerCustomize.actions.guides.description', icon: Compass },
  { id: 'quickReplies', label: 'composerCustomize.actions.quickReplies.label', description: 'composerCustomize.actions.quickReplies.description', icon: MessageSquareQuote },
  { id: 'promptVariables', label: 'composerCustomize.actions.promptVariables.label', description: 'composerCustomize.actions.promptVariables.description', icon: Sliders },
  { id: 'tools', label: 'composerCustomize.actions.tools.label', description: 'composerCustomize.actions.tools.description', icon: Wrench },
  { id: 'extras', label: 'composerCustomize.actions.extras.label', description: 'composerCustomize.actions.extras.description', icon: MoreHorizontal },
  {
    id: 'selectMessages',
    label: 'composerCustomize.actions.selectMessages.label',
    description: 'composerCustomize.actions.selectMessages.description',
    icon: ListChecks,
    keywords: ['select', 'messages', 'bulk', 'list-checks'],
  },
]

const DEFAULT_STATE: ComposerActionBarState = {
  order: [...COMPOSER_ACTION_IDS],
  hidden: ['selectMessages'],
}

export function runComposerSelectMessages(): void {
  const state = useStore.getState()
  state.setMessageSelectMode(!state.messageSelectMode)
}

export function isComposerActionId(value: unknown): value is ComposerActionId {
  return typeof value === 'string' && (COMPOSER_ACTION_IDS as readonly string[]).includes(value)
}

function isPersistedActionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Prefix QT catalog ids that would collide with a native composer action. */
export function toComposerExtraId(qtId: string): string {
  return isComposerActionId(qtId) ? `${COMPOSER_QT_PREFIX}${qtId}` : qtId
}

/** Reverse `toComposerExtraId` for QT catalog lookup. */
export function fromComposerExtraId(id: string): string {
  return id.startsWith(COMPOSER_QT_PREFIX) ? id.slice(COMPOSER_QT_PREFIX.length) : id
}

export function composerExtraItem(action: ToolbarAction): ComposerActionItem {
  return {
    id: toComposerExtraId(action.id),
    label: action.label,
    description: action.description,
    icon: action.icon,
    keywords: action.keywords,
  }
}

/**
 * The Suite is the owner of Quick Toolbar actions in the composer customizer.
 * Core composer actions remain available without it, except for its dedicated
 * Connections Picker launcher.
 */
export function buildComposerActionMap(
  actionCatalog: readonly ToolbarAction[],
  hasLumiverseSuite: boolean,
): Map<string, ComposerActionItem> {
  const nativeActions = hasLumiverseSuite
    ? COMPOSER_ACTION_CATALOG
    : COMPOSER_ACTION_CATALOG.filter((action) => action.id !== 'connectionsPicker')
  const map = new Map<string, ComposerActionItem>(
    nativeActions.map((action) => [action.id, action]),
  )
  if (!hasLumiverseSuite) return map

  for (const action of actionCatalog) {
    if (action.id === 'lumiverse_suite.connections_picker.open') continue
    const item = composerExtraItem(action)
    if (map.has(item.id)) continue
    map.set(item.id, item)
  }
  return map
}

export function normalizeComposerActionBarState(raw: unknown): ComposerActionBarState {
  const source = raw && typeof raw === 'object' ? raw as { order?: unknown; hidden?: unknown } : {}
  const sourceHasSelectMessages = Array.isArray(source.order)
    && source.order.some((id) => id === 'selectMessages')
  const seen = new Set<string>()
  const order: string[] = []
  if (Array.isArray(source.order)) {
    for (const id of source.order) {
      if (!isPersistedActionId(id) || seen.has(id)) continue
      seen.add(id)
      order.push(id)
    }
  }
  for (const id of COMPOSER_ACTION_IDS) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  const hidden = Array.isArray(source.hidden)
    ? source.hidden.filter((id): id is string => isPersistedActionId(id) && order.includes(id))
    : []
  if (!sourceHasSelectMessages && order.includes('selectMessages') && !hidden.includes('selectMessages')) {
    hidden.push('selectMessages')
  }
  return { order, hidden }
}

export function loadComposerActionBar(): ComposerActionBarState {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_STATE, order: [...DEFAULT_STATE.order] }
  try {
    const raw = localStorage.getItem(COMPOSER_ACTION_BAR_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STATE, order: [...DEFAULT_STATE.order] }
    return normalizeComposerActionBarState(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_STATE, order: [...DEFAULT_STATE.order] }
  }
}

export function saveComposerActionBar(state: ComposerActionBarState) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COMPOSER_ACTION_BAR_STORAGE_KEY, JSON.stringify(normalizeComposerActionBarState(state)))
  } catch {
    /* quota / private mode */
  }
}

export function useComposerActionBar() {
  const [state, setState] = useState<ComposerActionBarState>(loadComposerActionBar)

  const persist = useCallback((next: ComposerActionBarState) => {
    const normalized = normalizeComposerActionBarState(next)
    setState(normalized)
    saveComposerActionBar(normalized)
  }, [])

  const hiddenSet = useMemo(() => new Set(state.hidden), [state.hidden])

  const isVisible = useCallback(
    (id: string) => state.order.includes(id) && !hiddenSet.has(id),
    [hiddenSet, state.order],
  )

  const toggle = useCallback((id: string) => {
    if (!state.order.includes(id)) {
      persist({ order: [...state.order, id], hidden: state.hidden.filter((item) => item !== id) })
      return
    }
    persist({
      order: state.order,
      hidden: hiddenSet.has(id) ? state.hidden.filter((item) => item !== id) : [...state.hidden, id],
    })
  }, [hiddenSet, persist, state.hidden, state.order])

  const reorder = useCallback((order: string[]) => {
    persist({ order, hidden: state.hidden })
  }, [persist, state.hidden])

  const reset = useCallback(() => {
    persist({ order: [...DEFAULT_STATE.order], hidden: [...DEFAULT_STATE.hidden] })
  }, [persist])

  return {
    order: state.order,
    hidden: state.hidden,
    isVisible,
    toggle,
    reorder,
    reset,
  }
}

function SortableActionRow({
  action,
  enabled,
  onToggle,
}: {
  action: ComposerActionItem
  enabled: boolean
  onToggle: (id: string) => void
}) {
  const { t } = useTranslation('chat')
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: action.id, disabled: !enabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const Icon = action.icon

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(styles.customizeRow, isDragging && styles.customizeRowDragging, !enabled && styles.customizeRowDisabled)}
    >
      <button
        type="button"
        className={styles.customizeDragHandle}
        title={enabled ? t('composerCustomize.dragToReorder') : t('composerCustomize.enableToReorder')}
        aria-label={t('composerCustomize.dragAction', { label: action.label })}
        disabled={!enabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>

      <span className={styles.customizeIconWrap}>
        <Icon size={18} strokeWidth={1.75} />
      </span>

      <div className={styles.customizeCopy}>
        <span className={styles.customizeRowTitle}>{action.label}</span>
        <p className={styles.customizeRowDescription}>{action.description}</p>
      </div>

      <Toggle.Switch
        checked={enabled}
        onChange={() => onToggle(action.id)}
        aria-label={t(enabled ? 'composerCustomize.hideAction' : 'composerCustomize.showAction', { label: action.label })}
      />
    </div>
  )
}

interface InputAreaCustomizeModalProps {
  onClose: () => void
  order: string[]
  hidden: string[]
  onToggle: (id: string) => void
  onReorder: (order: string[]) => void
  onReset: () => void
}

export default function InputAreaCustomizeModal({
  onClose,
  order,
  hidden,
  onToggle,
  onReorder,
  onReset,
}: InputAreaCustomizeModalProps) {
  const [query, setQuery] = useState('')
  const { t } = useTranslation('chat')
  const { actionCatalog } = useQuickToolbarActions()
  const hasLumiverseSuite = useStore((state) => hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite'))
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ))
    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? focusable()[0]
      ?? dialog
    initial.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown)
      if (restoreTarget?.isConnected) restoreTarget.focus()
    }
  }, [])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const actionById = useMemo<Map<string, ComposerActionItem>>(() => {
    const map = buildComposerActionMap(actionCatalog, hasLumiverseSuite)
    for (const action of COMPOSER_ACTION_CATALOG) {
      if (!map.has(action.id)) continue
      map.set(action.id, {
        ...action,
        label: t(action.label),
        description: t(action.description),
      })
    }
    return map
  }, [actionCatalog, hasLumiverseSuite, t])
  const listedOrder = useMemo(() => {
    const availableQuickToolbarActions = hasLumiverseSuite ? actionCatalog : []
    const seen = new Set(order)
    const extras = availableQuickToolbarActions
      .map((action) => toComposerExtraId(action.id))
      .filter((id) => !seen.has(id) && actionById.has(id))
    return [...order, ...extras]
  }, [actionById, actionCatalog, hasLumiverseSuite, order])
  const rows = useMemo(
    () => listedOrder
      .map((id) => actionById.get(id))
      .filter((action): action is ComposerActionItem => Boolean(action)),
    [actionById, listedOrder],
  )
  const visibleIds = useMemo(
    () => order.filter((id) => !hidden.includes(id) && actionById.has(id)),
    [actionById, hidden, order],
  )
  const filteredRows = useMemo(() => filterActions(rows, query), [query, rows])
  const sortableIds = useMemo(
    () => filterActionIds(visibleIds, actionById, query),
    [actionById, query, visibleIds],
  )
  const filtering = filteredRows !== rows
  const filteredEnabledCount = useMemo(
    () => filteredRows.reduce((total, action) => total + (visibleIds.includes(action.id) ? 1 : 0), 0),
    [filteredRows, visibleIds],
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = order.indexOf(String(active.id))
    const to = order.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    onReorder(arrayMove(order, from, to))
  }

  return (
    <ModalShell data-component="InputAreaCustomizeModal" isOpen onClose={onClose} maxWidth={560} className={styles.customizeModal}>
      <div
        id="input-area-customize-dialog"
        ref={dialogRef}
        className={styles.customizeDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="input-area-customize-title"
        tabIndex={-1}
      >
        <CloseButton onClick={onClose} variant="solid" position="absolute" />

        <div className={styles.customizeHeader}>
          <h3 id="input-area-customize-title" className={styles.customizeTitle}>{t('composerCustomize.title')}</h3>
          <p className={styles.customizeSubtitle}>{t('composerCustomize.subtitle')}</p>
        </div>

        <div className={styles.customizeBody}>
          <div className={styles.customizeSectionHeader}>
            <h4 className={styles.customizeSectionTitle}>{t('composerCustomize.sectionTitle')}</h4>
            <p className={styles.customizeSectionDescription}>
              {filtering
                ? t('composerCustomize.summaryFiltered', {
                  matches: filteredRows.length,
                  total: rows.length,
                  shown: filteredEnabledCount,
                })
                : t('composerCustomize.summaryShown', { shown: visibleIds.length, total: rows.length })}
            </p>
            <label className={styles.customizeSearchField}>
              <Search size={14} />
              <input
                data-dialog-initial-focus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('composerCustomize.searchPlaceholder')}
                aria-label={t('composerCustomize.searchAria')}
              />
            </label>
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <div className={styles.customizeList}>
                {filtering && filteredRows.length === 0 ? (
                  <p className={styles.customizeEmptyState}>{t('composerCustomize.empty', { query: query.trim() })}</p>
                ) : filteredRows.map((action) => (
                  <SortableActionRow
                    key={action.id}
                    action={action}
                    enabled={visibleIds.includes(action.id)}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        <div className={styles.customizeFooter}>
          <button type="button" className={styles.customizeResetButton} onClick={onReset}>
            <RotateCcw size={14} />
            {t('composerCustomize.reset')}
          </button>
          <button type="button" className={styles.customizeDoneButton} onClick={onClose}>{t('composerCustomize.done')}</button>
        </div>
      </div>
    </ModalShell>
  )
}
