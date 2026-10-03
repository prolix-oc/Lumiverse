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
import { adaptExtensionTabs, DRAWER_TABS, extensionCommandsToCommands, type DrawerTabEntry } from '@/lib/drawer-tab-registry'
import { getVisibleSettingsTabs } from '@/lib/settings-tab-registry'
import {
  buildExtensionActionCatalog,
  extensionActionIdentity,
  isExtensionActionOrderPermutation,
  mergeExtensionActionOrder,
  normalizeToolbarExtensionActions,
  setToolbarExtensionActionVisible,
  type ExtensionActionCatalog,
} from '@/lib/extensionActionPreferences'
import { resolveToolbarIntent, type ToolbarSurface, type ToolbarUiState } from '@/lib/quickToolbarToggle'
import { moveWithinFiltered } from '@/lib/toolbarActionSearch'
import { DEFAULT_QUICK_TOOLBAR_SETTINGS } from '@/lib/uiProductivityDefaults'
// Host-surface toolbars render in detached roots without RouterProvider context.
import { router } from '@/router'
import { useStore } from '@/store'
import type { QuickToolbarSettings } from '@/types/store'
import type { DrawerTabState, InputBarActionState } from '@/store/slices/spindle-placement'
import { nextToolbarIconOrder } from './toolbarPointerHold'
import {
  filterEnabledFrontendContributions,
  hasEnabledFrontendExtension,
  hasEnabledFrontendExtensionId,
} from '@/lib/spindle/frontend-extension-availability'
import { isExtensionComposerActionId } from '@/components/chat/composerActionOwnership'

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

function arraysEqual(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Lists that mean "never customised", so a stored equal array is not a user choice. */
const TOOLBAR_DEFAULT_SENTINELS = [LEGACY_DEFAULT_IDS, PREVIOUS_DESIGN_DEFAULT_IDS, PREVIOUS_SUITE_DEFAULT_IDS]

function isToolbarDefaultsSentinel(ids: readonly string[]): boolean {
  return ids.length === 0 || TOOLBAR_DEFAULT_SENTINELS.some((list) => arraysEqual(ids, list))
}

/** The store slices the extension catalog is derived from. */
export interface ToolbarExtensionActionState {
  inputBarActions: readonly InputBarActionState[]
  drawerTabs: readonly DrawerTabState[]
  /** Owner-enabled slice; eligibility is intersected after duplicate grouping. */
  extensions: readonly { id?: unknown; identifier?: unknown; enabled?: unknown; has_frontend?: unknown }[] | null | undefined
}

/** Live registrations plus the runtime-handle keys used to render and persist them. */
export interface LiveToolbarExtensionCatalog {
  /**
   * Every live registration (input and drawer, eligible or not). Duplicate
   * grouping runs over this full set, so a tuple registered once on an eligible
   * surface and once elsewhere stays ambiguous instead of picking a callback.
   */
  catalog: ExtensionActionCatalog
  /** Runtime handle id to persisted key, restricted to eligible unique entries. */
  inputActionKeys: Map<string, string>
  drawerTabKeys: Map<string, string>
}

function assertNever(value: never): never {
  throw new Error(`Unhandled extension action kind: ${String(value)}`)
}

/** Every live registration, native placements and ineligible ones included. */
function buildToolbarExtensionCatalogState(state: ToolbarExtensionActionState): {
  catalog: ExtensionActionCatalog
  catalogInputKeys: Map<string, string>
  catalogDrawerKeys: Map<string, string>
  eligibleInputRuntimeIds: Set<string>
  eligibleDrawerRuntimeIds: Set<string>
} {
  const catalog = buildExtensionActionCatalog([
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
  const catalogInputKeys = new Map<string, string>()
  const catalogDrawerKeys = new Map<string, string>()
  for (const entry of catalog.entries) {
    if (entry.ambiguous) continue
    // Exhaustive so a new kind cannot silently fall into the drawer map.
    switch (entry.kind) {
      case 'input':
        catalogInputKeys.set(entry.runtimeId, entry.key)
        break
      case 'drawer':
        catalogDrawerKeys.set(entry.runtimeId, entry.key)
        break
      default:
        assertNever(entry.kind)
    }
  }
  // Owner-enabled survivors, resolved per kind through the same gate the
  // rendered catalog uses. Duplicate grouping already ran over the RAW
  // registrations above, so an ineligible duplicate still confers ambiguity.
  const eligibleInputRuntimeIds = new Set(
    filterEnabledFrontendContributions(state.inputBarActions, state.extensions)
      .filter(isQuickToolbarInputAction)
      .map((action) => action.id),
  )
  const eligibleDrawerRuntimeIds = new Set(
    filterEnabledFrontendContributions(state.drawerTabs, state.extensions).map((tab) => tab.id),
  )
  return { catalog, catalogInputKeys, catalogDrawerKeys, eligibleInputRuntimeIds, eligibleDrawerRuntimeIds }
}

/**
 * Keys the live extension placements with the shared utility. The catalog is
 * built from every registration so duplicate grouping cannot be defeated by a
 * placement filter; only an eligible, unique input action or drawer tab gets a
 * stable id, so a tuple registered twice is withheld rather than resolved to an
 * arbitrary callback. Eligibility is the current owner-enabled gate intersected
 * with the placement check, not the older placement-only contract.
 */
export function buildToolbarExtensionCatalog(state: ToolbarExtensionActionState): LiveToolbarExtensionCatalog {
  const {
    catalog,
    catalogInputKeys,
    catalogDrawerKeys,
    eligibleInputRuntimeIds,
    eligibleDrawerRuntimeIds,
  } = buildToolbarExtensionCatalogState(state)
  const inputActionKeys = new Map<string, string>()
  for (const [runtimeId, key] of catalogInputKeys) {
    if (eligibleInputRuntimeIds.has(runtimeId)) inputActionKeys.set(runtimeId, key)
  }
  const drawerTabKeys = new Map<string, string>()
  for (const [runtimeId, key] of catalogDrawerKeys) {
    if (eligibleDrawerRuntimeIds.has(runtimeId)) drawerTabKeys.set(runtimeId, key)
  }
  return { catalog, inputActionKeys, drawerTabKeys }
}

/** Persisted toolbar arrays, canonical and complete, with the defaults sentinel materialized. */
export interface ToolbarPreferenceProjection {
  storedVisibleIds: string[]
  /** Complete order: absent and hidden actions keep their complementary slots. */
  storedOrder: string[]
}

/** Read-only projection of the persisted arrays; never writes and never drops unknown ids. */
function projectToolbarPreferences(
  settings: QuickToolbarSettings,
  catalog: ExtensionActionCatalog,
): ToolbarPreferenceProjection {
  const normalized = normalizeToolbarExtensionActions(
    { visibleIds: settings.visibleTabIds, iconOrder: settings.iconOrder },
    catalog,
  )
  return {
    storedVisibleIds: isToolbarDefaultsSentinel(settings.visibleTabIds) ? [...DESIGN_DEFAULT_IDS] : normalized.visibleIds,
    storedOrder: isToolbarDefaultsSentinel(settings.iconOrder) ? [...DESIGN_DEFAULT_IDS] : normalized.iconOrder,
  }
}

/** The enabled, currently displayable sequence that reorder operations permute. */
function resolveAvailableToolbarIds(
  projection: ToolbarPreferenceProjection,
  isAvailable: (id: string) => boolean,
): { visibleIds: string[]; orderedIds: string[] } {
  const visibleIds = projection.storedVisibleIds.filter(isAvailable)
  const orderedIds = [
    ...projection.storedOrder.filter((id) => visibleIds.includes(id)),
    ...visibleIds.filter((id) => !projection.storedOrder.includes(id)),
  ]
  return { visibleIds, orderedIds }
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

function isStableExtensionActionKey(id: string): boolean {
  return id.startsWith('ext-action:') || id.startsWith('ext-runtime:')
}

/**
 * True when the id belongs to an extension action whatever its key shape: the
 * namespaced prefixes above plus the three bare Suite contribution ids, which are
 * reserved to `lumiverse_suite` input actions and are therefore extension keys
 * too. Recognising them keeps extension availability on the fresh eligible maps
 * even though the rendered catalog still holds one from a stale render.
 */
function isExtensionActionKey(id: string): boolean {
  return isStableExtensionActionKey(id) || EXTENSION_QUICK_TOOLBAR_ACTION_IDS.has(id)
}

/**
 * True when `filteredIds` is a real filter snapshot of `availableIds`: unique,
 * non-empty, and every member still present. A different length is expected (a
 * search hides rows) and is exactly what must not be mistaken for staleness.
 */
function isFilteredSnapshotOf(filteredIds: readonly string[], availableIds: readonly string[]): boolean {
  if (filteredIds.length === 0) return false
  const filtered = new Set(filteredIds)
  if (filtered.size !== filteredIds.length) return false
  const available = new Set(availableIds)
  for (const id of filtered) {
    if (!available.has(id)) return false
  }
  return true
}

/**
 * Catalog ids that can actually render a button right now. Every extension key is
 * taken ONLY from the eligible, unique fresh maps (an ineligible, ambiguous or
 * since-unregistered extension action is in the catalog purely for
 * normalization/legacy resolution and must not become selectable), plus the
 * native/command ids that currently have a catalog entry.
 */
function resolvedToolbarCatalogIds(
  live: LiveToolbarExtensionCatalog,
  catalogIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>()
  for (const id of catalogIds) {
    // Extension keys reach this set only through the eligible maps below, so any
    // extension id here is stale (or withheld) and must not be selectable.
    if (!isExtensionActionKey(id)) ids.add(id)
  }
  for (const key of live.inputActionKeys.values()) ids.add(key)
  for (const key of live.drawerTabKeys.values()) ids.add(key)
  return ids
}

/** Stable persisted key for one input action (bare Suite keys, namespaced otherwise). */
export function quickToolbarInputActionId(action: QuickToolbarInputAction): string {
  return extensionActionIdentity({
    kind: 'input',
    extensionId: action.extensionId,
    contributionId: action.contributionId,
    runtimeId: action.id,
  }).key
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
  const extensions = useStore((s) => s.extensions)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const openModal = useStore((s) => s.openModal)
  // The snapshot is a *value*, not just a re-render trigger. ChatView registers
  // `navigateToOldestMessage` / `openMessageNavigator` in an effect, i.e. after
  // the toolbar in the same commit has already rendered — so a catalog memo that
  // read the owners imperatively kept the empty registration forever and
  // rendered chat actions whose `run` did nothing.
  const chatDockerActionOwners = useSyncExternalStore(
    subscribeChatDockerActionOwners,
    getChatDockerActionOwners,
    getChatDockerActionOwners,
  )
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

  const liveExtension = useMemo(
    () => buildToolbarExtensionCatalog({ inputBarActions, drawerTabs: extensionDrawerTabs, extensions }),
    [extensionDrawerTabs, extensions, inputBarActions],
  )

  const actionCatalog = useMemo(() => {
    const enabledDrawerTabs = filterEnabledFrontendContributions(extensionDrawerTabs, extensions)
    const enabledExtensionCommands = filterEnabledFrontendContributions(extensionCommands, extensions)
    const enabledInputBarActions = filterEnabledFrontendContributions(inputBarActions, extensions)
    const toDrawerAction = (tab: DrawerTabEntry, id: string): ToolbarAction => {
      const surface: ToolbarSurface = { kind: 'drawer', tabId: tab.id }
      return {
        id,
        label: tab.tabName,
        description: tab.tabDescription,
        keywords: tab.keywords,
        icon: tab.tabIcon,
        surface,
        run: () => runSurface(surface),
      }
    }
    const drawerActions: ToolbarAction[] = [
      ...DRAWER_TABS.map((tab) => toDrawerAction(tab, tab.id)),
      // A tuple registered twice has no stable key and is withheld until exactly
      // one registration remains; `surface.tabId` stays the runtime handle.
      ...adaptExtensionTabs(enabledDrawerTabs).flatMap((tab) => {
        const id = liveExtension.drawerTabKeys.get(tab.id)
        return id ? [toDrawerAction(tab, id)] : []
      }),
    ]
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
      ...extensionCommandsToCommands(enabledExtensionCommands),
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
    const extensionInputActions: ToolbarAction[] = enabledInputBarActions
      // These named Lumiverse Suite actions are registered by extension-owned
      // surfaces, but they are also first-class Quick Toolbar actions. Keep this
      // allowlist narrow so unrelated contributions never leak into the global
      // quick-action catalog, and never promote native `worldBookEditor`.
      .filter(isQuickToolbarInputAction)
      .flatMap((action) => {
        // An ambiguous duplicate tuple is withheld; the runtime callback stays live.
        const id = liveExtension.inputActionKeys.get(action.id)
        if (!id) return []
        return [{
          id,
          label: quickToolbarInputActionLabel(action),
          // `subtitle` is the extension's own one-liner; the fallback still names the
          // extension, so two actions from different extensions never read alike.
          description: action.subtitle || `Input bar action from the ${action.extensionName} extension.`,
          keywords: ['extension', 'input action', action.extensionName, action.extensionId],
          icon: quickToolbarInputActionIcon(action),
          surface: { kind: 'command' } as const,
          run: () => runSurface(
            { kind: 'command' },
            () => {
              if (!hasEnabledFrontendExtensionId(useStore.getState().extensions, action.extensionId)) return
              action.clickHandlers.forEach((handler) => handler(undefined))
            },
          ),
        }]
      })
    const owners = chatDockerActionOwners
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
    const availableCatalog = hasEnabledFrontendExtension(extensions, 'lumiverse_suite')
      ? catalog
      : catalog.filter((action) => !isExtensionComposerActionId(action.id))
    return [...new Map(availableCatalog.map((action) => [action.id, action])).values()]
  }, [
    activeCharacterId,
    activeChatId,
    activeLoomPresetId,
    chatDockerActionOwners,
    extensionCommands,
    extensionDrawerTabs,
    extensions,
    inputBarActions,
    isGroupChat,
    liveExtension,
    messageSelectMode,
    openModal,
    runSurface,
    userRole,
  ])

  const actionById = useMemo(
    () => new Map(actionCatalog.map((action) => [action.id, action])),
    [actionCatalog],
  )

  /** Non-extension ids that can render right now, including data-driven hidden actions. */
  const catalogIds = useMemo(
    () => new Set(actionCatalog.map((action) => action.id)),
    [actionCatalog],
  )

  const projection = useMemo(
    () => projectToolbarPreferences(settings, liveExtension.catalog),
    [liveExtension.catalog, settings],
  )

  const availability = useMemo(() => {
    const ids = resolvedToolbarCatalogIds(liveExtension, catalogIds)
    return (id: string) => ids.has(id)
  }, [catalogIds, liveExtension])

  const { visibleIds, orderedIds } = useMemo(
    // Availability already excludes extension keys that have no live eligible
    // registration, so a key present here resolved and must not be filtered out.
    () => resolveAvailableToolbarIds(projection, availability),
    [availability, projection],
  )

  const actions = useMemo(() => {
    const resolved = orderedIds
      .map((id) => actionById.get(id))
      .filter((action): action is ToolbarAction => action !== undefined && !action.hidden)
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

  /**
   * Latest persisted arrays plus live registrations, read synchronously at
   * invocation, so two edits in one tick cannot act on a stale snapshot.
   */
  const readLatestToolbar = useCallback(() => {
    const storeState = useStore.getState()
    const live = buildToolbarExtensionCatalog({
      inputBarActions: storeState.inputBarActions,
      drawerTabs: storeState.drawerTabs,
      extensions: storeState.extensions,
    })
    return {
      live,
      catalog: live.catalog,
      projection: projectToolbarPreferences(storeState.quickToolbarSettings, live.catalog),
      availableIds: resolvedToolbarCatalogIds(live, catalogIds),
    }
  }, [catalogIds])

  /** Commits the complete normalized pair once, outside any state updater. */
  const commitToolbarPreferences = useCallback((next: ToolbarPreferenceProjection) => {
    updateSettings({ visibleTabIds: next.storedVisibleIds, iconOrder: next.storedOrder })
  }, [updateSettings])

  /**
   * The one write path: re-read the store, drop nothing, and derive the
   * reorderable sequence from the fresh availability set.
   */
  const commitToolbarOrder = useCallback((
    apply: (available: string[]) => string[] | null,
  ) => {
    const { projection: latest, availableIds } = readLatestToolbar()
    const available = resolveAvailableToolbarIds(latest, (id) => availableIds.has(id)).orderedIds
    const next = apply(available)
    if (!next) return
    commitToolbarPreferences({ ...latest, storedOrder: mergeExtensionActionOrder(latest.storedOrder, available, next) })
  }, [commitToolbarPreferences, readLatestToolbar])

  const moveAction = useCallback((id: string, direction: -1 | 1) => {
    commitToolbarOrder((available) => {
      const index = available.indexOf(id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= available.length) return null
      const next = [...available]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [commitToolbarOrder])

  /**
   * Writes a whole new order from a drag. `ids` must be a unique permutation of
   * the latest reorderable set; a snapshot that predates a catalog or selection
   * change is rejected as a no-op instead of replacing newer state.
   */
  const reorderActions = useCallback((ids: string[]) => {
    commitToolbarOrder((available) => (
      isExtensionActionOrderPermutation(ids, available) ? ids : null
    ))
  }, [commitToolbarOrder])

  const reorderActionPair = useCallback((activeId: string, overId: string) => {
    commitToolbarOrder((available) => nextToolbarIconOrder(available, activeId, overId))
  }, [commitToolbarOrder])

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
   * `id` already at a visible end) or when `filteredIds` is a stale snapshot that
   * references ids no longer available; pair it with `canMoveWithinFiltered` from
   * the same module for the chevron's `disabled` prop and the two cannot disagree.
   */
  const moveActionWithin = useCallback((id: string, direction: -1 | 1, filteredIds: string[]) => {
    commitToolbarOrder((available) => {
      // A stale snapshot (an id that no longer exists) is a no-op; a genuine
      // search filter is a subset and must still perform the one visible step.
      if (!isFilteredSnapshotOf(filteredIds, available)) return null
      const next = moveWithinFiltered(available, filteredIds, id, direction)
      if (next === available) return null
      return next
    })
  }, [commitToolbarOrder])

  /**
   * Hides or shows one action against the latest arrays. Hiding keeps the
   * complementary order slot, and both arrays are committed together so a
   * canonical alias can never survive in just one of them.
   */
  const toggleAction = useCallback((id: string) => {
    const { projection: latest, catalog } = readLatestToolbar()
    const next = setToolbarExtensionActionVisible(
      { visibleIds: latest.storedVisibleIds, iconOrder: latest.storedOrder },
      catalog,
      id,
      !latest.storedVisibleIds.includes(id),
    )
    commitToolbarPreferences({ storedVisibleIds: next.visibleIds, storedOrder: next.iconOrder })
  }, [commitToolbarPreferences, readLatestToolbar])

  /**
   * Shared overflow pin: move the target to the first available slot through the
   * same complementary merge, so absent and hidden slots keep their places.
   */
  const pinAction = useCallback((id: string) => {
    commitToolbarOrder((available) => (
      available.includes(id) ? [id, ...available.filter((candidate) => candidate !== id)] : null
    ))
  }, [commitToolbarOrder])

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
    pinAction,
    resetCurrentVariant,
  }
}
