import { router } from '@/router'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import {
  COMMANDS,
  type Command,
} from '@/lib/commands'
import {
  DRAWER_TABS,
  extensionTabsToCommands,
  type DrawerTabEntry,
} from '@/lib/drawer-tab-registry'
import {
  getVisibleSettingsTabs,
  settingsRegistryToCommands,
  type SettingsTabEntry,
} from '@/lib/settings-tab-registry'
import type {
  DrawerTabState,
  ExtensionCommandState,
  InputBarActionState,
} from '@/store/slices/spindle-placement'
import {
  applyHostAction,
  HOST_MODAL_IDS,
  HOST_ROUTE_PATTERNS,
  type HostActionParams,
  type HostActionRuntime,
  type HostSurfaceKind,
  type HostSurfaceRef,
} from './host-actions'
import {
  frontendAuthorityRowFor,
  type AuthorityRow,
} from './frontend-authority-map'

export interface HostSurface {
  kind: HostSurfaceKind
  id: string
  label: string
  description?: string
  keywords?: string[]
  iconName?: string
  iconSvg?: string
  scope?: 'global' | 'chat' | 'chat-idle' | 'landing' | 'character'
  role?: 'admin' | 'owner'
  owner?: string
  invocable?: boolean
}

export interface HostSurfaceTarget {
  kind: string
  id: string
  parentId?: string
}

export type HostSurfaceTargetHandler = (target: HostSurfaceTarget) => void

export interface HostSurfaceRegistryInputs {
  drawerTabs?: readonly DrawerTabEntry[]
  settingsTabs?: readonly SettingsTabEntry[]
  extensionTabs?: readonly DrawerTabState[]
  commands?: readonly Command[]
  extensionCommands?: readonly ExtensionCommandState[]
  inputBarActions?: readonly InputBarActionState[]
  userRole?: string | null
}

export interface HostSurfaceAPI {
  list(kinds?: readonly HostSurfaceKind[]): HostSurface[]
  subscribe(handler: (surfaces: HostSurface[]) => void): () => void
  invoke(ref: HostSurfaceRef, params?: HostActionParams): void | Promise<void>
  registerDeepLinkTarget(kind: string, id: string, handler: HostSurfaceTargetHandler): () => void
}

export interface HostSurfaceAPIFactoryOptions extends HostSurfaceRegistryInputs {
  extensionId: string
  getGrantedPermissions?: () => readonly string[]
  assertActive?: () => void
  onTeardown?: (handler: () => void) => () => void
  runtime?: Partial<HostActionRuntime>
  getInputs?: () => HostSurfaceRegistryInputs
}

const ROUTES: readonly HostSurface[] = Object.freeze([
  { kind: 'route', id: '/', label: 'Home', description: 'Open the home screen', scope: 'global' },
  { kind: 'route', id: '/chat/:chatId', label: 'Chat', description: 'Open a chat by id', scope: 'chat' },
  { kind: 'route', id: '/characters', label: 'Characters', description: 'Open the character library', scope: 'global' },
  { kind: 'route', id: '/characters/:id', label: 'Character', description: 'Open a character profile', scope: 'character' },
])

const MODALS: readonly HostSurface[] = Object.freeze([
  { kind: 'modal', id: HOST_MODAL_IDS[0], label: 'Character editor', description: 'Open the character editor', scope: 'character' },
  { kind: 'modal', id: HOST_MODAL_IDS[1], label: 'World book editor', description: 'Open a world book editor', scope: 'global' },
])

function settingsRole(role: string | undefined): 'admin' | 'owner' | undefined {
  return role === 'admin' || role === 'owner' ? role : undefined
}

function isRoleVisible(tab: Pick<SettingsTabEntry, 'role'>, role: string | null | undefined): boolean {
  if (!tab.role) return true
  if (tab.role === 'owner') return role === 'owner'
  return role === 'admin' || role === 'owner'
}

function commandSurface(command: Command): HostSurface {
  return {
    kind: 'command',
    id: command.id,
    label: command.label,
    description: command.description,
    keywords: [...command.keywords],
    scope: command.scope,
  }
}

function collectCommands(inputs: HostSurfaceRegistryInputs): Command[] {
  const settingsTabs = (inputs.settingsTabs ?? getVisibleSettingsTabs(inputs.userRole ?? undefined))
    .filter((tab) => isRoleVisible(tab, inputs.userRole))
  return [
    ...(inputs.commands ?? COMMANDS),
    ...settingsRegistryToCommands([...settingsTabs]),
    ...extensionTabsToCommands([...(inputs.extensionTabs ?? [])]),
  ]
}

function drawerSurface(tab: DrawerTabEntry, owner?: string): HostSurface {
  return {
    kind: 'drawer_tab',
    id: tab.id,
    label: tab.tabName,
    description: tab.tabDescription,
    keywords: [...tab.keywords],
    owner,
  }
}

function extensionDrawerSurface(tab: DrawerTabState): HostSurface {
  return {
    kind: 'drawer_tab',
    id: tab.id,
    label: tab.title,
    description: tab.description ?? `Open ${tab.title} extension tab`,
    keywords: ['extension', 'spindle', tab.extensionId, ...(tab.keywords ?? [])],
    iconSvg: tab.iconSvg,
    iconName: tab.iconUrl,
    owner: tab.extensionId,
  }
}

function settingsSurface(tab: SettingsTabEntry): HostSurface {
  return {
    kind: 'settings_tab',
    id: tab.id,
    label: tab.tabName,
    description: tab.tabDescription,
    keywords: [...tab.keywords],
    scope: tab.scope,
    role: settingsRole(tab.role),
  }
}

function inputSurface(action: InputBarActionState): HostSurface {
  return {
    kind: 'input_bar_action',
    id: action.id,
    label: action.label,
    description: action.subtitle,
    iconSvg: action.iconSvg,
    iconName: action.iconUrl,
    owner: action.extensionId,
    invocable: action.enabled && action.externallyInvocable !== false,
  }
}

function extensionCommandSurface(extensionId: string, command: ExtensionCommandState['commands'][number]): HostSurface {
  const id = `ext-cmd-${extensionId}-${command.id}`
  return {
    kind: 'ext_command',
    id,
    label: command.label,
    description: command.description,
    keywords: ['extension', extensionId, ...(command.keywords ?? [])],
    scope: command.scope,
    owner: extensionId,
    invocable: command.externallyInvocable !== false,
  }
}

/** Assemble a deterministic, role-filtered snapshot without invoking anything. */
export function buildHostSurfaceCatalog(inputs: HostSurfaceRegistryInputs = {}): HostSurface[] {
  const role = inputs.userRole ?? undefined
  const drawerTabs = inputs.drawerTabs ?? DRAWER_TABS
  const settingsTabs = (inputs.settingsTabs ?? getVisibleSettingsTabs(role))
    .filter((tab) => isRoleVisible(tab, role))
  const commands = collectCommands(inputs)
  const extensionCommands = inputs.extensionCommands ?? []

  const surfaces: HostSurface[] = [
    ...drawerTabs.map((tab) => drawerSurface(tab)),
    ...(inputs.extensionTabs ?? []).map(extensionDrawerSurface),
    ...settingsTabs.map(settingsSurface),
    ...commands.map(commandSurface),
    ...extensionCommands.flatMap((entry) => entry.commands.map((command) => extensionCommandSurface(entry.extensionId, command))),
    ...(inputs.inputBarActions ?? []).map(inputSurface),
    ...ROUTES,
    ...MODALS,
  ]

  const seen = new Set<string>()
  return surfaces.filter((surface) => {
    const key = `${surface.kind}:${surface.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((surface) => ({
    ...surface,
    keywords: surface.keywords ? [...surface.keywords] : undefined,
  }))
}

function targetKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function assertTarget(target: unknown): asserts target is HostSurfaceTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('HOST_ACTION_INVALID_PARAMS:target')
  const value = target as Record<string, unknown>
  if (typeof value.kind !== 'string' || value.kind.length < 1 || value.kind.length > 64) throw new Error('HOST_ACTION_INVALID_PARAMS:target.kind')
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128) throw new Error('HOST_ACTION_INVALID_PARAMS:target.id')
  if (value.parentId !== undefined && (typeof value.parentId !== 'string' || value.parentId.length > 128)) throw new Error('HOST_ACTION_INVALID_PARAMS:target.parentId')
}

function defaultRuntime(
  getCommand: (id: string) => Command | undefined,
  getInputAction: (id: string) => InputBarActionState | undefined,
  getExtensionCommand: (id: string) => { extensionId: string; commandId: string } | undefined,
): HostActionRuntime {
  return {
    openDrawer: (id) => useStore.getState().openDrawer(id),
    closeDrawer: () => useStore.getState().closeDrawer(),
    openSettings: (id) => useStore.getState().openSettings(id),
    closeSettings: () => useStore.getState().closeSettings(),
    openCommandPalette: () => useStore.getState().openCommandPalette(),
    closeCommandPalette: () => useStore.getState().closeCommandPalette(),
    runCommand: (id) => {
      const command = getCommand(id)
      if (!command) throw new Error(`HOST_ACTION_UNMAPPED:command:${id}`)
      return command.run(router.navigate)
    },
    navigate: (path) => { void router.navigate(path) },
    setEditingCharacterId: (id) => useStore.getState().setEditingCharacterId(id),
    openWorldBookEditor: (id, entryId) => {
      const state = useStore.getState()
      state.setPendingWorldBookEditEntryId(entryId ?? null)
      state.openModal('worldBookEditor', { bookId: id })
    },
    invokeInputBarAction: async (id) => {
      const action = getInputAction(id)
      if (!action) throw new Error(`HOST_ACTION_UNMAPPED:input_bar_action:${id}`)
      for (const handler of [...action.clickHandlers]) await handler()
    },
    invokeExtensionCommand: (id) => {
      const target = getExtensionCommand(id)
      if (!target) throw new Error(`HOST_ACTION_UNMAPPED:ext_command:${id}`)
      const state = useStore.getState()
      // The command palette sends the same context shape.  The receiver is
      // still the owning extension and therefore runs with its own grants.
      wsClient.send({
        type: 'SPINDLE_COMMAND_INVOKE',
        extensionId: target.extensionId,
        commandId: target.commandId,
        context: {
          route: window.location.pathname,
          chatId: state.activeChatId ?? undefined,
          characterId: state.activeCharacterId ?? undefined,
          isGroupChat: state.isGroupChat ?? false,
        },
      })
    },
  }
}

function authorityReference(kind: HostSurfaceKind, id: string, owner: string | undefined, caller: string): { surface: 'host_action'; id: string } {
  if (kind === 'input_bar_action') return { surface: 'host_action', id: `input_bar_action:${owner === caller ? 'self' : 'cross_extension'}` }
  if (kind === 'ext_command') return { surface: 'host_action', id: `ext_command:${owner === caller ? 'self' : 'cross_extension'}` }
  return { surface: 'host_action', id: `${kind}:${id}` }
}

function permissionError(permission: string, id: string): Error {
  return new Error(`PERMISSION_DENIED:${permission} — host action ${id} requires the ${permission} permission`)
}

/** Create the generation-scoped H4 host catalog and invoker. */
export function createHostSurfaceAPI(options: HostSurfaceAPIFactoryOptions): HostSurfaceAPI {
  const assertActive = options.assertActive ?? (() => {})
  const getInputs = options.getInputs ?? (() => ({
    ...options,
    userRole: useStore.getState().user?.role ?? null,
    settingsTabs: (useStore.getState() as unknown as { settingsTabs?: readonly SettingsTabEntry[] }).settingsTabs,
    extensionTabs: useStore.getState().drawerTabs,
    extensionCommands: useStore.getState().extensionCommands,
    inputBarActions: useStore.getState().inputBarActions,
  }))
  const getGranted = options.getGrantedPermissions ?? (() => [])
  const targetHandlers = new Map<string, HostSurfaceTargetHandler>()
  const subscribers = new Set<(surfaces: HostSurface[]) => void>()
  let disposed = false
  let storeUnsubscribe: (() => void) | undefined

  const snapshot = () => buildHostSurfaceCatalog(getInputs())
  const find = (ref: HostSurfaceRef) => snapshot().find((surface) => surface.kind === ref.kind && surface.id === ref.id)
  const commandById = (id: string) => collectCommands(getInputs()).find((command) => command.id === id)
  const inputById = (id: string) => getInputs().inputBarActions?.find((action) => action.id === id)
  const extCommandById = (id: string) => {
    for (const entry of getInputs().extensionCommands ?? []) {
      for (const command of entry.commands) {
        if (`ext-cmd-${entry.extensionId}-${command.id}` === id) return { extensionId: entry.extensionId, commandId: command.id }
      }
    }
    return undefined
  }
  const runtime = {
    ...defaultRuntime(commandById as (id: string) => Command | undefined, inputById, extCommandById),
    ...(options.runtime ?? {}),
  }

  const emit = () => {
    if (disposed) return
    const next = snapshot()
    for (const subscriber of [...subscribers]) {
      try { subscriber(next.map((surface) => ({ ...surface, keywords: surface.keywords ? [...surface.keywords] : undefined }))) } catch { /* observer isolation */ }
    }
  }

  const subscribeStore = () => {
    if (storeUnsubscribe || options.getInputs) return
    storeUnsubscribe = useStore.subscribe(emit)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    subscribers.clear()
    targetHandlers.clear()
    storeUnsubscribe?.()
    storeUnsubscribe = undefined
  }
  options.onTeardown?.(dispose)

  const assertUsable = () => {
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: host surface catalog is disposed')
    assertActive()
  }

  return {
    list(kinds) {
      assertUsable()
      const allowed = kinds ? new Set(kinds) : undefined
      subscribeStore()
      return snapshot().filter((surface) => !allowed || allowed.has(surface.kind)).map((surface) => ({
        ...surface,
        keywords: surface.keywords ? [...surface.keywords] : undefined,
      }))
    },
    subscribe(handler) {
      assertUsable()
      subscribers.add(handler)
      subscribeStore()
      let active = true
      return () => {
        if (!active) return
        active = false
        subscribers.delete(handler)
        if (subscribers.size === 0) {
          storeUnsubscribe?.()
          storeUnsubscribe = undefined
        }
      }
    },
    registerDeepLinkTarget(kind, id, handler) {
      assertUsable()
      if (!kind || !id || typeof handler !== 'function') throw new Error('HOST_SURFACE_INVALID_TARGET')
      const key = targetKey(kind, id)
      if (targetHandlers.has(key)) throw new Error(`HOST_SURFACE_DUPLICATE_TARGET:${key}`)
      targetHandlers.set(key, handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (targetHandlers.get(key) === handler) targetHandlers.delete(key)
      }
    },
    invoke(ref, params) {
      assertUsable()
      const surface = find(ref)
      const authority = frontendAuthorityRowFor(authorityReference(ref.kind, ref.id, surface?.owner, options.extensionId))
      if (!authority) throw new Error(`HOST_ACTION_UNMAPPED:${ref.kind}:${ref.id}`)
      if (!surface) throw new Error(`HOST_ACTION_UNAVAILABLE:${ref.kind}:${ref.id}`)
      if (surface.invocable === false) throw new Error('HOST_ACTION_NOT_EXTERNALLY_INVOCABLE')
      if (authority.permission !== null && !getGranted().includes(authority.permission)) {
        throw permissionError(authority.permission, ref.id)
      }
      if (ref.kind === 'settings_tab' && surface.role && !getVisibleSettingsTabs(getInputs().userRole ?? null).some((entry) => entry.id === ref.id)) {
        throw new Error(`HOST_ACTION_UNAVAILABLE:settings_tab:${ref.id}`)
      }
      if (ref.kind === 'drawer_tab' && params?.target !== undefined) {
        assertTarget(params.target)
        targetHandlers.get(targetKey(params.target.kind, params.target.id))?.(params.target)
      }
      return applyHostAction(ref, params, runtime)
    },
  }
}

export { HOST_ROUTE_PATTERNS }
