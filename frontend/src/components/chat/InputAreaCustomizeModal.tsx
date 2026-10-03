import { useCallback, useMemo, useRef, useState, type ComponentType } from 'react'
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
import { useStore } from '@/store'
import type { DrawerTabState, InputBarActionState } from '@/store/slices/spindle-placement'
import { useQuickToolbarActions, type ToolbarAction } from '@/components/quick-toolbar/useQuickToolbarActions'
import {
  applyComposerExtensionActionOrder,
  buildExtensionActionCatalog,
  normalizeComposerExtensionActions,
  setComposerExtensionActionVisible,
  type ExtensionActionCatalog,
} from '@/lib/extensionActionPreferences'
import { IconPlaylistAdd } from '@tabler/icons-react'
import {
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
import { DndContext, useScaledSortableStyle } from '@/lib/dndUiScale'
import { filterActionIds, filterActions } from '@/lib/toolbarActionSearch'
import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'
import { isCoreOwnedComposerActionId } from './composerActionOwnership'
import styles from './InputArea.module.css'

/** localStorage key — no store slice exists on the InputArea allowlist. */
export const COMPOSER_ACTION_BAR_STORAGE_KEY = 'lumiverse.composerActionBar'

export const COMPOSER_ACTION_IDS = [
  'home',
  'regen',
  'continue',
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
  { id: 'home', label: 'Home', description: 'Return to the home screen', icon: Home },
  { id: 'regen', label: 'Regenerate', description: 'Regenerate the last assistant reply', icon: RotateCw },
  { id: 'continue', label: 'Continue', description: 'Continue the last assistant reply', icon: CornerDownLeft },
  { id: 'oneliner', label: 'Impersonate', description: 'Generate a user draft with the selected impersonation mode', icon: MessageSquare },
  { id: 'persona', label: 'Persona', description: 'Send as or switch the active persona', icon: UserCircle },
  { id: 'connections', label: 'Connections', description: 'Switch the active connection profile', icon: Link2 },
  { id: 'connectionsPicker', label: 'Connections Picker', description: 'Open the Waypoints connections picker', icon: Waypoints },
  { id: 'altFields', label: 'Alternate fields', description: 'Bind alternate character fields', icon: Layers },
  { id: 'addons', label: 'Addons', description: 'Persona addons for this chat', icon: IconPlaylistAdd },
  { id: 'guides', label: 'Guides', description: 'Guided generations', icon: Compass },
  { id: 'quickReplies', label: 'Quick replies', description: 'Insert a saved quick reply', icon: MessageSquareQuote },
  { id: 'promptVariables', label: 'Prompt variables', description: 'Configure prompt variables for the active preset', icon: Sliders },
  { id: 'tools', label: 'Tools', description: 'Chat tools and settings', icon: Wrench },
  { id: 'extras', label: 'Extras', description: 'Extra composer actions', icon: MoreHorizontal },
  {
    id: 'selectMessages',
    label: 'Select messages',
    description: 'Toggle message selection mode in the current chat.',
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

/**
 * Restores the current baseline's native pruning after the shared normalizer.
 * `normalizeComposerExtensionActions` deliberately preserves unknown and legacy
 * strings and re-materializes a hidden-only id as a tail order slot, so a native
 * core-owned alias (`chat.customize-composer`) would otherwise survive in both
 * arrays. Only that one pinned native launcher is removed; every unknown, absent
 * or extension-owned key — and all other order/hidden intent — passes through.
 */
function pruneCoreOwnedComposerAliases(state: ComposerActionBarState): ComposerActionBarState {
  const order = state.order.filter((id) => !isCoreOwnedComposerActionId(id))
  const hidden = state.hidden.filter((id) => !isCoreOwnedComposerActionId(id))
  return { order, hidden }
}

function sameComposerActionBarState(a: ComposerActionBarState, b: ComposerActionBarState): boolean {
  return a.order.length === b.order.length
    && a.order.every((id, index) => id === b.order[index])
    && a.hidden.length === b.hidden.length
    && a.hidden.every((id, index) => id === b.hidden[index])
}

/**
 * Live extension registrations, keyed exactly as the toolbar keys them (same full
 * logical catalog, so both surfaces agree on identity and on duplicate
 * withholding). The composer keys every live input action and drawer tab and
 * applies no toolbar eligibility allowlist.
 */
function extensionActionCatalogFor(state: ComposerExtensionActionState): ExtensionActionCatalog {
  return buildExtensionActionCatalog([
    ...state.inputBarActions.map((action) => ({
      kind: 'input' as const,
      extensionId: action.extensionId,
      contributionId: action.contributionId,
      runtimeId: action.id,
    })),
    ...state.drawerTabs.map((tab) => ({
      kind: 'drawer' as const,
      extensionId: tab.extensionId,
      contributionId: tab.contributionId,
      runtimeId: tab.id,
    })),
  ])
}

/** The mandatory store slices extension identity is derived from. */
export interface ComposerExtensionActionState {
  inputBarActions: readonly InputBarActionState[]
  drawerTabs: readonly DrawerTabState[]
}

/** Reads those slices synchronously, so a mutation never acts on a render-time catalog. */
function readComposerExtensionActionState(): ComposerExtensionActionState {
  const state = useStore.getState()
  return { inputBarActions: state.inputBarActions, drawerTabs: state.drawerTabs }
}

function currentExtensionActionCatalog(): ExtensionActionCatalog {
  return extensionActionCatalogFor(readComposerExtensionActionState())
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
    if (
      action.id === 'lumiverse_suite.connections_picker.open'
      || isCoreOwnedComposerActionId(action.id)
    ) continue
    const item = composerExtraItem(action)
    if (map.has(item.id)) continue
    map.set(item.id, item)
  }
  return map
}

export function normalizeComposerActionBarState(
  raw: unknown,
  catalog: ExtensionActionCatalog = currentExtensionActionCatalog(),
): ComposerActionBarState {
  const source = raw && typeof raw === 'object' ? raw as { order?: unknown; hidden?: unknown } : {}
  const sourceHasSelectMessages = Array.isArray(source.order)
    && source.order.some((id) => id === 'selectMessages')
  const seen = new Set<string>()
  const order: string[] = []
  if (Array.isArray(source.order)) {
    for (const id of source.order) {
      if (!isPersistedActionId(id) || seen.has(id) || isCoreOwnedComposerActionId(id)) continue
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
    ? source.hidden.filter((id): id is string => isPersistedActionId(id))
    : []
  if (!sourceHasSelectMessages && order.includes('selectMessages') && !hidden.includes('selectMessages')) {
    hidden.push('selectMessages')
  }
  // Canonicalize both arrays together before any membership filter can drop a
  // hidden alias that only exists in its legacy form; the shared normalizer also
  // keeps a hidden-only id addressable with a tail order slot. Native core-owned
  // aliases are pruned after that, so the pinned launcher cannot be re-admitted
  // through a legacy `hidden` entry.
  return pruneCoreOwnedComposerAliases(normalizeComposerExtensionActions({ order, hidden }, catalog))
}

export function loadComposerActionBar(): ComposerActionBarState {
  if (typeof localStorage === 'undefined') return { order: [...DEFAULT_STATE.order], hidden: [...DEFAULT_STATE.hidden] }
  try {
    const raw = localStorage.getItem(COMPOSER_ACTION_BAR_STORAGE_KEY)
    if (!raw) return { order: [...DEFAULT_STATE.order], hidden: [...DEFAULT_STATE.hidden] }
    return normalizeComposerActionBarState(JSON.parse(raw))
  } catch {
    return { order: [...DEFAULT_STATE.order], hidden: [...DEFAULT_STATE.hidden] }
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
  /** Live registrations; these slices change on extension registration churn. */
  const inputBarActions = useStore((store) => store.inputBarActions)
  const drawerTabs = useStore((store) => store.drawerTabs)
  /**
   * Committed-state reference, advanced synchronously by `persist` so the second
   * of two handlers in the same tick cannot read a stale snapshot. It is
   * initialized once and never reassigned during render, so a render can never
   * overwrite a newer edit.
   */
  const committed = useRef<ComposerActionBarState>(state)

  const persist = useCallback((next: ComposerActionBarState) => {
    const normalized = normalizeComposerActionBarState(next)
    if (sameComposerActionBarState(normalized, committed.current)) return
    committed.current = normalized
    setState(normalized)
    saveComposerActionBar(normalized)
  }, [])

  /**
   * Read-only render projection. A stored legacy id must be canonicalized when
   * its extension registers after load, or the bar and the drag identity would
   * disagree with the toolbar's stable key. The same native pruning is applied so
   * the projection cannot show a core-owned alias the persisted pair has already
   * dropped. Nothing here writes storage, and the committed ref is never touched,
   * so an intermediate render cannot displace a newer edit.
   */
  const projected = useMemo(
    () => pruneCoreOwnedComposerAliases(
      normalizeComposerExtensionActions(state, extensionActionCatalogFor({ inputBarActions, drawerTabs })),
    ),
    [drawerTabs, inputBarActions, state],
  )

  const hiddenSet = useMemo(() => new Set(projected.hidden), [projected.hidden])

  const isVisible = useCallback(
    (id: string) => projected.order.includes(id) && !hiddenSet.has(id),
    [hiddenSet, projected.order],
  )

  const toggle = useCallback((id: string) => {
    const catalog = currentExtensionActionCatalog()
    // Normalize the raw pair with the LIVE catalog before deciding visibility:
    // a stored legacy alias must resolve to the same key the caller passes, or a
    // Show would be computed as a Hide. Prune first so the latest pair matches
    // the persisted normalization.
    const current = pruneCoreOwnedComposerAliases(normalizeComposerExtensionActions(committed.current, catalog))
    persist(setComposerExtensionActionVisible(current, catalog, id, !(current.order.includes(id) && !current.hidden.includes(id))))
  }, [persist])

  const reorder = useCallback((order: string[]) => {
    const catalog = currentExtensionActionCatalog()
    const current = pruneCoreOwnedComposerAliases(normalizeComposerExtensionActions(committed.current, catalog))
    // A snapshot that is no longer a permutation of the latest order is stale;
    // it returns the current state unchanged rather than replacing newer edits.
    persist(applyComposerExtensionActionOrder(current, catalog, order))
  }, [persist])

  const reset = useCallback(() => {
    persist({ order: [...DEFAULT_STATE.order], hidden: [...DEFAULT_STATE.hidden] })
  }, [persist])

  return {
    order: projected.order,
    hidden: projected.hidden,
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
        title={enabled ? 'Drag to reorder' : 'Enable this icon to reorder it'}
        aria-label={`Drag ${action.label}`}
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
        aria-label={`${enabled ? 'Hide' : 'Show'} ${action.label}`}
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
  const { actionCatalog } = useQuickToolbarActions()
  const hasLumiverseSuite = useStore((state) => hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite'))
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const actionById = useMemo(
    () => buildComposerActionMap(actionCatalog, hasLumiverseSuite),
    [actionCatalog, hasLumiverseSuite],
  )
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
      <CloseButton onClick={onClose} variant="solid" position="absolute" />

      <div className={styles.customizeHeader}>
        <h3 className={styles.customizeTitle}>Customize composer</h3>
        <p className={styles.customizeSubtitle}>
          {hasLumiverseSuite
            ? 'Drag to reorder composer icons. Toggle to add or hide Quick Toolbar actions and native icons. Changes apply immediately.'
            : 'Drag to reorder composer icons. Toggle to add or hide native icons. Changes apply immediately.'}
        </p>
      </div>

      <div className={styles.customizeBody}>
        <div className={styles.customizeSectionHeader}>
          <h4 className={styles.customizeSectionTitle}>Composer icons</h4>
          <p className={styles.customizeSectionDescription}>
            {filtering
              ? `${filteredRows.length} of ${rows.length} match, ${filteredEnabledCount} of those shown on the bar.`
              : `${visibleIds.length} of ${rows.length} shown, in bar order.`}
          </p>
          <label className={styles.customizeSearchField}>
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search icons..."
              aria-label="Search composer icons"
            />
          </label>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <div className={styles.customizeList}>
              {filtering && filteredRows.length === 0 ? (
                <p className={styles.customizeEmptyState}>No composer icons match “{query.trim()}”.</p>
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
          Reset icons
        </button>
        <button type="button" className={styles.customizeDoneButton} onClick={onClose}>Done</button>
      </div>
    </ModalShell>
  )
}
