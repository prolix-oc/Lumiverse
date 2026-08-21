import { useCallback, useMemo, useSyncExternalStore, type ComponentType } from 'react'
import { Columns2, Maximize2, Settings, Waypoints, Zap } from 'lucide-react'
import { createDynamicExtensionIcon } from '@/components/icons/DynamicExtensionIcon'
import {
  buildChatDockerActionCatalog,
  CHAT_DOCKER_ACTION_IDS,
  getChatDockerActionOwners,
  subscribeChatDockerActionOwners,
} from '@/components/chat/chatDockerActionCatalog'
import { COMMANDS } from '@/lib/commands'
import { adaptExtensionTabs, DRAWER_TABS, extensionCommandsToCommands } from '@/lib/drawer-tab-registry'
import { getVisibleSettingsTabs } from '@/lib/settings-tab-registry'
import { resolveToolbarIntent, type ToolbarSurface, type ToolbarUiState } from '@/lib/quickToolbarToggle'
import { moveWithinFiltered } from '@/lib/toolbarActionSearch'
import { DEFAULT_QUICK_TOOLBAR_SETTINGS } from '@/lib/uiProductivityDefaults'
// Host-surface toolbars render in detached roots without RouterProvider context.
import { router } from '@/router'
import { useStore } from '@/store'
import type { QuickToolbarSettings } from '@/types/store'
import type { InputBarActionState } from '@/store/slices/spindle-placement'
import { nextToolbarIconOrder } from './toolbarPointerHold'

export type ToolbarActionIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

export interface ToolbarAction {
  id: string
  label: string
  /**
   * One human sentence describing what pressing this does. Rendered verbatim
   * under the title in the Customize Toolbar modal (`.rowDescription`, clamped
   * to two lines), so it is user-facing copy — never a keyword dump.
   *
   * Every entry is sourced from the registry that owns the surface, so the three
   * catalogs (`DRAWER_TABS`, `SETTINGS_TABS`, `COMMANDS`) stay the single source
   * of truth and the ~70 rows all carry distinct text.
   */
  description: string
  /**
   * Extra search terms that are *not* in `label` or `description` — the synonyms,
   * abbreviations and provider names a user is likely to type ("cot", "png",
   * "openrouter", "reroll"). Never rendered; search-only.
   *
   * Free data: all three registries already declare `keywords` for the command
   * palette, so this is a pass-through rather than a new hand-maintained list.
   * Optional because extension-contributed entries may supply nothing.
   *
   * NOTE FOR CONSUMERS: `frontend/src/lib/toolbarActionSearch.ts` does not read
   * this field yet — its `SearchableToolbarAction` is `{ id, label, description? }`.
   * Until that module is extended, keywords are carried but not matched.
   */
  keywords?: string[]
  icon: ToolbarActionIcon
  /**
   * What this button opens. Drives both the toggle behaviour in `run` and the
   * pressed affordance the toolbar renders (`aria-pressed`, the V2 chevron).
   */
  surface: ToolbarSurface
  run: () => void
  disabled?: boolean
  hidden?: boolean
  /**
   * Explicit pressed state. When defined, toolbar render uses this for
   * `aria-pressed` / active styling even if `surface.kind === 'command'`.
   */
  active?: boolean
}

/** The view the catalog-root "Settings" button opens. */
const SETTINGS_ROOT_VIEW = 'productivity'

/**
 * Snapshot of the UI state a toolbar button needs, read at *click* time.
 *
 * Deliberately not a subscription: reading through `useStore.getState()` (the
 * same idiom `updateSettings` uses) keeps the action catalog's dependency list
 * free of `drawerOpen`/`settingsModalOpen`, which would otherwise rebuild every
 * action — and every `run` closure — each time a drawer opened.
 */
function readUi(): ToolbarUiState {
  const state = useStore.getState()
  return {
    drawerOpen: state.drawerOpen,
    drawerTab: state.drawerTab,
    settingsModalOpen: state.settingsModalOpen,
    settingsActiveView: state.settingsActiveView,
  }
}

const EXTENSION_HALF_LOREBOOK_ACTION_ID = 'lumiverse_suite.lorebook.open_half'
const EXTENSION_ENHANCED_LOREBOOK_ACTION_ID = 'lumiverse_suite.lorebook.open_enhanced'
const EXTENSION_CONNECTIONS_PICKER_ACTION_ID = 'lumiverse_suite.connections_picker.open'
const EXTENSION_QUICK_TOOLBAR_ACTION_IDS = new Set([
  EXTENSION_HALF_LOREBOOK_ACTION_ID,
  EXTENSION_ENHANCED_LOREBOOK_ACTION_ID,
  EXTENSION_CONNECTIONS_PICKER_ACTION_ID,
])

const NON_DEFAULT_DOCKER_IDS = new Set<string>([
  'chat.select-messages',
  'chat.scroll-to-top',
  'chat.browse-messages',
  'chat.customize-composer',
])

/** Ids from the confirmed toolbar designs, used when nothing has been customised. */
export const DESIGN_DEFAULT_IDS = CHAT_DOCKER_ACTION_IDS.filter((id) => !NON_DEFAULT_DOCKER_IDS.has(id))
/** The previous built-in defaults. Treated as "untouched" so they upgrade cleanly. */
const PREVIOUS_DESIGN_DEFAULT_IDS = ['profile', 'connections', 'council', 'lorebook', 'presets', 'settings']
const PREVIOUS_SUITE_DEFAULT_IDS = [
  'profile',
  'connections',
  'council',
  'lorebook',
  EXTENSION_HALF_LOREBOOK_ACTION_ID,
  EXTENSION_ENHANCED_LOREBOOK_ACTION_ID,
  'presets',
  'settings',
]
/** The pre-redesign default set. Treated as "untouched" so it upgrades cleanly. */
const LEGACY_DEFAULT_IDS = ['characters', 'lorebook', 'connections']

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

type QuickToolbarInputAction = Pick<
  InputBarActionState,
  'id' | 'contributionId' | 'placement' | 'extensionId' | 'iconSvg' | 'iconUrl'
>

function isExtensionQuickToolbarAction(action: Pick<QuickToolbarInputAction, 'contributionId'>): boolean {
  return EXTENSION_QUICK_TOOLBAR_ACTION_IDS.has(action.contributionId ?? '')
}

/** Only explicitly supported extension actions cross from the entry toolbar into Quick Toolbar. */
export function isQuickToolbarInputAction(action: Pick<QuickToolbarInputAction, 'placement' | 'contributionId'>): boolean {
  return !action.placement
    || action.placement === 'input_bar.extras'
    || isExtensionQuickToolbarAction(action)
}

/** Persist contributor ids for named suite actions; generated registration ids are not stable. */
export function quickToolbarInputActionId(action: QuickToolbarInputAction): string {
  return isExtensionQuickToolbarAction(action)
    ? action.contributionId!
    : `input-action:${action.extensionId}:${action.id}`
}

/** The suite owns the meaning of these two named editor actions, so it owns their glyph mapping too. */
export function quickToolbarInputActionIcon(action: QuickToolbarInputAction): ToolbarActionIcon {
  if (action.contributionId === EXTENSION_HALF_LOREBOOK_ACTION_ID) return Columns2
  if (action.contributionId === EXTENSION_ENHANCED_LOREBOOK_ACTION_ID) return Maximize2
  if (action.contributionId === EXTENSION_CONNECTIONS_PICKER_ACTION_ID) return Waypoints
  return action.iconSvg || action.iconUrl
    ? createDynamicExtensionIcon({ iconSvg: action.iconSvg, iconUrl: action.iconUrl })
    : Zap
}

/** Keep first-party suite names stable even while an older extension instance is still registered. */
export function quickToolbarInputActionLabel(action: Pick<InputBarActionState, 'contributionId' | 'label'>): string {
  if (action.contributionId === EXTENSION_HALF_LOREBOOK_ACTION_ID) return 'Half-Screen Lorebook Editor'
  if (action.contributionId === EXTENSION_ENHANCED_LOREBOOK_ACTION_ID) return 'Full-Screen Lorebook Editor'
  return action.label
}

/**
 * Shared toolbar model. The floating toolbar, its glued customizer popover and
 * the Customize Toolbar modal all read from here so a change made in one is
 * immediately reflected in the others.
 */
export function useQuickToolbarActions() {
  const settings = useStore((s) => s.quickToolbarSettings)
  const userRole = useStore((s) => s.user?.role)
  const extensionDrawerTabs = useStore((s) => s.drawerTabs)
  const extensionCommands = useStore((s) => s.extensionCommands)
  const inputBarActions = useStore((s) => s.inputBarActions)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const openModal = useStore((s) => s.openModal)
  useSyncExternalStore(subscribeChatDockerActionOwners, getChatDockerActionOwners, getChatDockerActionOwners)
  const openDrawer = useStore((s) => s.openDrawer)
  const closeDrawer = useStore((s) => s.closeDrawer)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const setSetting = useStore((s) => s.setSetting)
  const updateSettings = useCallback((patch: Partial<QuickToolbarSettings>) => {
    setSetting('quickToolbarSettings', { ...useStore.getState().quickToolbarSettings, ...patch })
  }, [setSetting])

  /**
   * QT-4: a second press on the button that opened a surface closes it again.
   *
   * The decision is made by the pure `resolveToolbarIntent`, and the *store*
   * actions stay open-only on purpose — `openDrawer`/`openSettings` have 20+
   * other callers (websocket commands, deep links, extension requests) that all
   * mean "make visible", and a websocket "open the lorebook drawer" must never
   * close it. `ViewportDrawer.tsx` shows the same caller-decides idiom.
   */
  const runSurface = useCallback((surface: ToolbarSurface, command?: () => void) => {
    const intent = resolveToolbarIntent(surface, readUi())
    switch (intent.type) {
      case 'open-drawer':
        setDrawerTab(intent.tabId)
        openDrawer(intent.tabId)
        return
      case 'close-drawer':
        closeDrawer()
        return
      case 'open-settings':
        openSettings(intent.view)
        return
      case 'close-settings':
        closeSettings()
        return
      case 'run-command':
        // Commands and extension input actions have no surface to close, so
        // they always re-run; idempotency is the command's own contract.
        command?.()
    }
  }, [closeDrawer, closeSettings, openDrawer, openSettings, setDrawerTab])

  const actionCatalog = useMemo(() => {
    const drawerActions: ToolbarAction[] = [...DRAWER_TABS, ...adaptExtensionTabs(extensionDrawerTabs)].map((tab) => {
      const surface: ToolbarSurface = { kind: 'drawer', tabId: tab.id }
      return {
        id: tab.id,
        label: tab.tabName,
        description: tab.tabDescription,
        keywords: tab.keywords,
        icon: tab.tabIcon,
        surface,
        run: () => runSurface(surface),
      }
    })
    const settingsActions: ToolbarAction[] = getVisibleSettingsTabs(userRole).map((tab) => {
      const surface: ToolbarSurface = { kind: 'settings', view: tab.id }
      return {
        id: `settings:${tab.id}`,
        label: tab.tabName,
        description: tab.tabDescription,
        keywords: tab.keywords,
        icon: tab.tabIcon,
        surface,
        run: () => runSurface(surface),
      }
    })
    const registeredActions: ToolbarAction[] = [
      ...COMMANDS.filter((command) => command.group === 'actions'),
      ...extensionCommandsToCommands(extensionCommands),
    ].map((command) => ({
      id: `command:${command.id}`,
      label: command.label,
      // Was the literal `'Run this command.'` for every entry — sixteen static
      // rows of identical text, which made a description search useless across
      // the largest block of the catalog. `Command` has carried a real,
      // per-command sentence for the palette all along; this just stops
      // discarding it. The old string survives only as an empty-value guard for
      // extension-supplied commands, which are untrusted input.
      description: command.description || 'Run this command.',
      keywords: command.keywords,
      icon: command.icon,
      surface: { kind: 'command' },
      run: () => runSurface({ kind: 'command' }, () => void command.run(router.navigate)),
    }))
    const extensionInputActions: ToolbarAction[] = inputBarActions
      // These named Lumiverse Suite actions are registered by extension-owned
      // surfaces, but they are also first-class Quick Toolbar actions. Keep this
      // allowlist narrow so unrelated contributions never leak into the global
      // quick-action catalog, and never promote native `worldBookEditor`.
      .filter(isQuickToolbarInputAction)
      .map((action) => {
        return {
          // Input-action registrations have process-local ids. The two workspace
          // actions instead persist their contributor ids, so their quick-toolbar
          // visibility/order survives extension reloads and can be defaulted.
          id: quickToolbarInputActionId(action),
          label: quickToolbarInputActionLabel(action),
          // `subtitle` is the extension's own one-liner; the fallback still names the
          // extension, so two actions from different extensions never read alike.
          description: action.subtitle || `Input bar action from the ${action.extensionName} extension.`,
          keywords: ['extension', 'input action', action.extensionName, action.extensionId],
          icon: quickToolbarInputActionIcon(action),
          surface: { kind: 'command' } as const,
          run: () => runSurface(
            { kind: 'command' },
            () => action.clickHandlers.forEach((handler) => handler()),
          ),
        }
      })
    const owners = getChatDockerActionOwners()
    const chatDockerActions: ToolbarAction[] = buildChatDockerActionCatalog({
      owners: {
        ...owners,
        openModal: owners.openModal ?? openModal,
        navigate: router.navigate,
      },
      scope: {
        activeCharacterId,
        activeChatId,
        isGroupChat,
        activeLoomPresetId,
        promptVariablesLoading: owners.promptVariablesLoading,
        memoryCortexAvailable: owners.memoryCortexAvailable,
        memoryCortexInFlight: owners.memoryCortexInFlight,
        groupChatCreatorRegistered: owners.groupChatCreatorRegistered,
      },
    }).map((action) => ({
      id: action.id,
      label: action.id === 'chat.select-messages' && messageSelectMode
        ? 'Exit selection mode'
        : action.label,
      description: action.description,
      keywords: action.keywords,
      icon: action.icon,
      surface: { kind: 'command' } as const,
      run: action.run,
      disabled: action.disabled,
      hidden: action.hidden,
      active: action.id === 'chat.select-messages' ? Boolean(messageSelectMode) : undefined,
    }))
    const catalog: ToolbarAction[] = [
      ...chatDockerActions,
      {
        id: 'settings',
        label: 'Settings',
        description: 'Open productivity settings.',
        keywords: ['settings', 'preferences', 'options', 'config', 'productivity', 'toolbar'],
        icon: Settings,
        surface: { kind: 'settings', view: SETTINGS_ROOT_VIEW },
        run: () => runSurface({ kind: 'settings', view: SETTINGS_ROOT_VIEW }),
      },
      ...drawerActions,
      ...settingsActions,
      ...registeredActions,
      ...extensionInputActions,
    ]
    return [...new Map(catalog.map((action) => [action.id, action])).values()]
  }, [
    activeCharacterId,
    activeChatId,
    activeLoomPresetId,
    extensionCommands,
    extensionDrawerTabs,
    inputBarActions,
    isGroupChat,
    messageSelectMode,
    openModal,
    runSurface,
    userRole,
  ])

  const actionById = useMemo(
    () => new Map(actionCatalog.map((action) => [action.id, action])),
    [actionCatalog],
  )

  const visibleIds = useMemo(() => {
    if (
      settings.visibleTabIds.length === 0
      || arraysEqual(settings.visibleTabIds, LEGACY_DEFAULT_IDS)
      || arraysEqual(settings.visibleTabIds, PREVIOUS_DESIGN_DEFAULT_IDS)
      || arraysEqual(settings.visibleTabIds, PREVIOUS_SUITE_DEFAULT_IDS)
    ) {
      return DESIGN_DEFAULT_IDS
    }
    return settings.visibleTabIds.filter((id) => actionById.has(id))
  }, [actionById, settings.visibleTabIds])

  const orderedIds = useMemo(() => {
    const configuredOrder = (
      settings.iconOrder.length === 0
      || arraysEqual(settings.iconOrder, LEGACY_DEFAULT_IDS)
      || arraysEqual(settings.iconOrder, PREVIOUS_DESIGN_DEFAULT_IDS)
      || arraysEqual(settings.iconOrder, PREVIOUS_SUITE_DEFAULT_IDS)
    )
      ? DESIGN_DEFAULT_IDS
      : settings.iconOrder
    return [
      ...configuredOrder.filter((id) => visibleIds.includes(id)),
      ...visibleIds.filter((id) => !configuredOrder.includes(id)),
    ]
  }, [settings.iconOrder, visibleIds])

  const actions = useMemo(() => {
    const resolved = orderedIds
      .map((id) => actionById.get(id))
      .filter((action): action is ToolbarAction => Boolean(action) && !action.hidden)
    // A-S4: the catalog dedupes on `id`, and `'settings'` vs
    // `'settings:productivity'` are different keys — so both can be visible at
    // once, two buttons opening the same view, each closing the other's modal.
    // The *surface* is the real identity, so drop the catalog-root button when a
    // `settings:<id>` button already resolves to the same view.
    const root = resolved.find((action) => action.id === 'settings')
    if (!root || root.surface.kind !== 'settings') return resolved
    const rootView = root.surface.view
    const aliased = resolved.some((action) => (
      action.id !== 'settings' && action.surface.kind === 'settings' && action.surface.view === rootView
    ))
    return aliased ? resolved.filter((action) => action.id !== 'settings') : resolved
  }, [actionById, orderedIds])

  /** Full catalog order used by the customizer: enabled entries first, in order. */
  const catalogOrder = useMemo(() => {
    const rest = actionCatalog.map((action) => action.id).filter((id) => !orderedIds.includes(id))
    return [...orderedIds, ...rest]
  }, [actionCatalog, orderedIds])

  const moveAction = useCallback((id: string, direction: -1 | 1) => {
    const next = [...orderedIds]
    const index = next.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    updateSettings({ iconOrder: next })
  }, [orderedIds, updateSettings])

  /**
   * Writes a whole new order. The `visibleIds` filter is a guard against a
   * caller handing over ids that are not enabled — it is a no-op for any
   * permutation of `orderedIds`, because `orderedIds` is built exclusively from
   * `visibleIds` above, but it SILENTLY DROPS anything else. Pass a permutation
   * of `orderedIds`, nothing wider.
   */
  const reorderActions = useCallback((ids: string[]) => {
    updateSettings({ iconOrder: ids.filter((id) => visibleIds.includes(id)) })
  }, [updateSettings, visibleIds])

  const reorderActionPair = useCallback((activeId: string, overId: string) => {
    const next = nextToolbarIconOrder(orderedIds, activeId, overId)
    if (!next) return
    reorderActions(next)
  }, [orderedIds, reorderActions])

  /**
   * The chevron write path for a list that is being filtered by a search box.
   *
   * `filteredIds` is what the user can currently see — normally
   * `filterActionIds(orderedIds, actionById, query)`. The item is removed and
   * reinserted at the full-list index of its nearest *visible* neighbour, so one
   * click always produces exactly one visible step even when hidden rows sit in
   * between. A pairwise swap (`moveAction`) is wrong under a filter: if the
   * adjacent id is filtered out the row does not appear to move at all.
   *
   * With no filter active — `filteredIds === orderedIds`, which is exactly what
   * `filterActionIds` returns for an empty query — the nearest visible neighbour
   * *is* the adjacent element, so this is identical to `moveAction`. Surfaces can
   * therefore call this unconditionally instead of branching on the query.
   *
   * Writes nothing when the move is impossible (`id` disabled, `id` hidden, or
   * `id` already at a visible end); pair it with `canMoveWithinFiltered` from the
   * same module for the chevron's `disabled` prop and the two cannot disagree.
   */
  const moveActionWithin = useCallback((id: string, direction: -1 | 1, filteredIds: string[]) => {
    const next = moveWithinFiltered(orderedIds, filteredIds, id, direction)
    if (next === orderedIds) return
    updateSettings({ iconOrder: next })
  }, [orderedIds, updateSettings])

  const toggleAction = useCallback((id: string) => {
    const next = visibleIds.includes(id) ? visibleIds.filter((item) => item !== id) : [...visibleIds, id]
    updateSettings({ visibleTabIds: next })
  }, [updateSettings, visibleIds])

  const resetCurrentVariant = useCallback(() => {
    const defaults = DEFAULT_QUICK_TOOLBAR_SETTINGS
    if (settings.variant === 'v2-settings-adjacent') {
      // Deliberately does not touch `labelVisible` — that belongs to V1/V3, and
      // resetting V2 must not wipe the other variants' label preference.
      updateSettings({
        visibleTabIds: defaults.visibleTabIds,
        iconOrder: defaults.iconOrder,
        v2IconSize: defaults.v2IconSize,
        v2LabelTextSize: defaults.v2LabelTextSize,
        v2LabelVisible: defaults.v2LabelVisible,
      })
      return
    }
    updateSettings({
      visibleTabIds: defaults.visibleTabIds,
      iconOrder: defaults.iconOrder,
      iconSize: defaults.iconSize,
      labelVisible: defaults.labelVisible,
      labelTextSize: defaults.labelTextSize,
      scale: defaults.scale,
      orientation: defaults.orientation,
      rotationDeg: defaults.rotationDeg,
      opacity: defaults.opacity,
      snapToEdge: defaults.snapToEdge,
      resizeHandlesEnabled: defaults.resizeHandlesEnabled,
      // The auto sentinel on *both* orientations, so "reset" restores auto-fit
      // rather than re-pinning whatever box the user last dragged — and cannot
      // leave the orientation the user is not looking at still pinned.
      rect: defaults.rect,
      verticalSize: defaults.verticalSize,
    })
  }, [settings.variant, updateSettings])

  return {
    settings,
    updateSettings,
    actionCatalog,
    actionById,
    actions,
    visibleIds,
    orderedIds,
    catalogOrder,
    moveAction,
    moveActionWithin,
    reorderActions,
    reorderActionPair,
    toggleAction,
    resetCurrentVariant,
  }
}
