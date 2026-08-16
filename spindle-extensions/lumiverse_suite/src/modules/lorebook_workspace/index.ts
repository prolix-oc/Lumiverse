import type { SuiteHostContext, SuiteModule, SuiteModuleContext } from '../../suite'
import { PermissionBroker } from '../../shared/permissions'
import {
  asMount,
  ownerDocumentOf,
  readExtensionInstallationId,
  requireScopedHostRoot,
  type ScopedHostRoot,
} from '../../shared/public-sdk'
import { requireSuiteSettings, type SuiteSettingsAPI } from '../../shared/settings'
import {
  defaultLorebookWorkspaceSettings,
  isLorebookWorkspaceDensity,
  LOREBOOK_WORKSPACE_SETTINGS_KEY,
  normalizeLorebookWorkspaceSettings,
  type LorebookWorkspaceDensity,
  type LorebookWorkspaceSettings,
} from './types'
import { installLorebookContentResizeTracking } from './content-resize'

const MODULE_ID = 'lorebook_workspace' as const
const WORKSPACE_MOUNT_POINT = 'lorebook_workspace'
const TABLE_SURFACE_ID = 'world_book_entry_table'
const EDITOR_SURFACE_ID = 'world_book_entry_editor'
const BOOK_SELECTED_EVENT = 'lorebook-workspace/book-selected'
const HALF_ACTION_ID = 'lumiverse_suite.lorebook.open_half'
const HALF_WORKSPACE_SURFACE_ID = 'lorebook.half.workspace'
const ENHANCED_ACTION_ID = 'lumiverse_suite.lorebook.open_enhanced'
const ENHANCED_WORKSPACE_SURFACE_ID = 'lorebook.enhanced.workspace'
const HOST_CONTRACT_VERSION = 1

const MODULE_STYLES = String.raw`
[data-lumiverse-module="lorebook_workspace"]{box-sizing:border-box;color:var(--lumiverse-text,inherit);display:grid;gap:12px;grid-template-columns:minmax(12rem,.8fr) minmax(18rem,1.2fr);min-height:0;min-width:0}
[data-lumiverse-module="lorebook_workspace"] [data-lumiverse-lorebook-table],
[data-lumiverse-module="lorebook_workspace"] [data-lumiverse-lorebook-editor]{min-width:0;min-height:0}
@media (max-width:720px){[data-lumiverse-module="lorebook_workspace"]{grid-template-columns:1fr}}
`

type JsonRecord = Record<string, unknown>

type SurfaceHandle = {
  readonly update?: (props: JsonRecord) => void
  readonly destroy?: () => void
  readonly on?: (event: string, listener: (payload: unknown) => void) => (() => void)
}

type AppMountHandle = { readonly root: HTMLElement; readonly destroy?: () => void }
type InputActionHandle = {
  readonly onClick?: (listener: (payload?: unknown) => void) => (() => void)
  readonly destroy?: () => void
}

type HostWorkspace = {
  readonly surfaceId: typeof HALF_WORKSPACE_SURFACE_ID | typeof ENHANCED_WORKSPACE_SURFACE_ID
  readonly handle: SurfaceHandle
  readonly ownerToken: string
  generation: number
  invocation: number
  invocationId: string | null
}

type LorebookActionSource = 'entry_table' | 'half_editor' | 'settings'

type LorebookInvocationPayload = {
  readonly version: 1
  readonly bookId: string
  readonly entryId?: string
  readonly source: LorebookActionSource
  readonly invocationId?: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function extensionUuid(context: SuiteModuleContext): string | undefined {
  return readExtensionInstallationId(context.host)
}

function markOwned(node: HTMLElement, installedUuid: string | undefined): void {
  node.setAttribute('data-lumiverse-module', MODULE_ID)
  if (!installedUuid) return
  node.setAttribute('data-spindle-extension-root', installedUuid)
  node.setAttribute('data-spindle-ext', installedUuid)
  node.setAttribute('data-lumiverse-installed-uuid', installedUuid)
}

function sameSettings(left: LorebookWorkspaceSettings, right: LorebookWorkspaceSettings): boolean {
  return left.enabled === right.enabled && left.bookId === right.bookId && left.density === right.density
}

function sameStoredSettings(value: unknown, expected: LorebookWorkspaceSettings): boolean {
  try {
    return JSON.stringify(value) === JSON.stringify(expected)
  } catch {
    return false
  }
}

function selectedEntryId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return nonEmptyString(value.entryId ?? value.entry_id)
}

function selectedBook(value: unknown): { bookId: string | null; density?: LorebookWorkspaceDensity } | undefined {
  if (!isRecord(value)) return undefined
  const rawBookId = value.bookId ?? value.book_id
  const bookId = rawBookId === null ? null : nonEmptyString(rawBookId)
  if (rawBookId !== null && !bookId) return undefined
  const density = isLorebookWorkspaceDensity(value.density) ? value.density : undefined
  return { bookId: bookId ?? null, density }
}

function parseInvocationPayload(value: unknown, fallbackBookId: string | null): LorebookInvocationPayload | null {
  if (value === undefined) {
    return fallbackBookId
      ? { version: 1, bookId: fallbackBookId, source: 'settings' }
      : null
  }
  if (!isRecord(value) || value.version !== 1) return null
  const bookId = nonEmptyString(value.bookId)
  if (!bookId) return null
  const source = value.source
  if (source !== 'entry_table' && source !== 'half_editor' && source !== 'settings') return null
  const entryId = value.entryId === undefined ? undefined : nonEmptyString(value.entryId)
  if (value.entryId !== undefined && !entryId) return null
  const invocationId = value.invocationId === undefined ? undefined : nonEmptyString(value.invocationId)
  if (value.invocationId !== undefined && !invocationId) return null
  return { version: 1, bookId, ...(entryId ? { entryId } : {}), source, ...(invocationId ? { invocationId } : {}) }
}

function hostWorkspaceCommand(value: unknown, workspace: HostWorkspace): boolean {
  if (!isRecord(value) || value.command !== 'close') return false
  return value.ownerToken === workspace.ownerToken
    && value.generation === workspace.generation
    && value.invocationId === workspace.invocationId
}


export function createLorebookWorkspaceModule(): SuiteModule {
  let context: SuiteModuleContext | undefined
  let settings: SuiteSettingsAPI | undefined
  let running = false
  let starting = false
  let lifecycleGeneration = 0
  let current: LorebookWorkspaceSettings = defaultLorebookWorkspaceSettings()
  let stopSettingsWatch: (() => void) | undefined
  let stopBusListener: (() => void) | undefined
  let activeRoot: HTMLElement | undefined
  let tableTarget: HTMLElement | undefined
  let editorTarget: HTMLElement | undefined
  let tableHandle: SurfaceHandle | undefined
  let editorHandle: SurfaceHandle | undefined
  let selectedId: string | undefined
  let activeDisposers: Array<() => void> = []
  let stylesActive = false
  let editorPermission: 'unknown' | 'granted' | 'denied' = 'unknown'
  let pendingPermission: Promise<boolean> | undefined
  let hostWorkspaces: HostWorkspace[] = []
  let hostWorkspaceDisposers: Array<() => void> = []
  let stopContentResizeTracking: (() => void) | undefined
  let actionDisposers: Array<() => void> = []
  const inflightInvocationIds = new Set<string>()

  const isCurrent = (expectedGeneration: number, expectedContext: SuiteModuleContext): boolean => (
    running
    && current.enabled
    && lifecycleGeneration === expectedGeneration
    && context === expectedContext
  )

  const disposeActive = (): void => {
    lifecycleGeneration += 1
    selectedId = undefined
    editorPermission = 'unknown'
    pendingPermission = undefined
    for (const dispose of activeDisposers.splice(0).reverse()) {
      try { dispose() } catch { /* cleanup is best effort */ }
    }
    tableHandle = undefined
    editorHandle = undefined
    tableTarget = undefined
    editorTarget = undefined
    try { activeRoot?.remove() } catch { /* no-op */ }
    activeRoot = undefined
    if (stylesActive) {
      try { context?.styles.clear() } catch { /* no-op */ }
      stylesActive = false
    }
  }

  const closeHostWorkspace = (workspace: HostWorkspace): void => {
    workspace.generation += 1
    if (workspace.invocationId) inflightInvocationIds.delete(workspace.invocationId)
    workspace.invocationId = null
    try {
      workspace.handle.update?.({
        contractVersion: HOST_CONTRACT_VERSION,
        ownerToken: workspace.ownerToken,
        generation: workspace.generation,
        capabilities: ['close'],
        state: { open: false, bookId: null, entryId: null, invocationId: null, source: 'entry_table' satisfies LorebookActionSource },
      })
    } catch { /* a torn-down host surface is already closed */ }
  }

  const closeHostWorkspaces = (): void => {
    for (const workspace of hostWorkspaces) closeHostWorkspace(workspace)
  }

  const disposeHostWorkspaces = (): void => {
    closeHostWorkspaces()
    stopContentResizeTracking?.()
    stopContentResizeTracking = undefined
    for (const dispose of hostWorkspaceDisposers.splice(0).reverse()) {
      try { dispose() } catch { /* cleanup is best effort */ }
    }
    hostWorkspaces = []
    inflightInvocationIds.clear()
  }

  const disposeActions = (): void => {
    for (const dispose of actionDisposers.splice(0).reverse()) {
      try { dispose() } catch { /* cleanup is best effort */ }
    }
  }

  const openHostWorkspace = (
    surfaceId: typeof HALF_WORKSPACE_SURFACE_ID | typeof ENHANCED_WORKSPACE_SURFACE_ID,
    entryId: string | null = null,
    source: LorebookActionSource = 'settings',
    correlationId?: string,
  ): boolean => {
    const workspace = hostWorkspaces.find(candidate => candidate.surfaceId === surfaceId)
    if (!workspace || !running || !current.enabled || !current.bookId) return false
    for (const other of hostWorkspaces) {
      if (other !== workspace && other.invocationId) closeHostWorkspace(other)
    }
    if (workspace.invocationId) inflightInvocationIds.delete(workspace.invocationId)
    workspace.generation += 1
    workspace.invocation += 1
    workspace.invocationId = correlationId ?? `${surfaceId}:${workspace.generation}:${workspace.invocation}`
    try {
      workspace.handle.update?.({
        contractVersion: HOST_CONTRACT_VERSION,
        ownerToken: workspace.ownerToken,
        generation: workspace.generation,
        capabilities: ['close'],
        state: {
          open: true,
          bookId: current.bookId,
          entryId,
          invocationId: workspace.invocationId,
          source,
        },
      })
    } catch { /* the extension can be unloaded between a click and delivery */ }
    return true
  }

  const hostSurfaces = (host: SuiteHostContext) => {
    const mount = host.ui.mount
    const mountHostSurface = host.components.mountHostSurface
    if (typeof mount !== 'function' || typeof mountHostSurface !== 'function') return undefined
    return {
      mount: (point: string) => mount(asMount(point)),
      mountApp: host.ui.mountApp,
      mountHostSurface,
      geometry: host.ui.geometry,
    }
  }

  const installHostWorkspaces = (activationContext: SuiteModuleContext): void => {
    if (hostWorkspaces.length > 0) return
    const surfaces = hostSurfaces(activationContext.host)
    if (!surfaces) return
    let halfRoot: ScopedHostRoot
    try {
      halfRoot = requireScopedHostRoot(surfaces.mount('lorebook_half_workspace'), 'LOREBOOK_WORKSPACE_MOUNT_UNAVAILABLE')
    } catch {
      return
    }
    const doc = ownerDocumentOf(halfRoot)
    if (!doc) return
    const layoutElementRect = surfaces.geometry?.layoutElementRect
    stopContentResizeTracking ??= installLorebookContentResizeTracking(halfRoot, {
      layoutElementRect: layoutElementRect
        ? (element) => {
            const rect = layoutElementRect(element)
            return typeof rect.height === 'number' ? { height: rect.height } : { height: 0 }
          }
        : undefined,
    })
    const ownerToken = extensionUuid(activationContext) ?? MODULE_ID

    for (const surfaceId of [HALF_WORKSPACE_SURFACE_ID, ENHANCED_WORKSPACE_SURFACE_ID] as const) {
      try {
        let app: AppMountHandle | undefined
        let target: HTMLElement
        if (surfaceId === HALF_WORKSPACE_SURFACE_ID) {
          target = halfRoot
          target.style.display = 'contents'
        } else {
          if (typeof surfaces.mountApp !== 'function') continue
          app = surfaces.mountApp({ position: 'app-overlay', className: `lumiverse-${surfaceId}` }) as AppMountHandle
          if (!app?.root) throw new Error('LOREBOOK_WORKSPACE_APP_MOUNT_UNAVAILABLE')
          target = doc.createElement('div')
          markOwned(target, extensionUuid(activationContext))
          app.root.append(target)
        }
        const workspace: HostWorkspace = {
          surfaceId,
          handle: surfaces.mountHostSurface(target, surfaceId, {
            contractVersion: HOST_CONTRACT_VERSION,
            ownerToken,
            generation: 0,
            capabilities: ['close'],
              state: { open: false, bookId: null, entryId: null, invocationId: null, source: 'entry_table' satisfies LorebookActionSource },
          }) as SurfaceHandle,
          ownerToken,
          generation: 0,
          invocation: 0,
          invocationId: null,
        }
        const unsubscribe = workspace.handle.on?.('command', value => {
          if (!hostWorkspaceCommand(value, workspace)) return
          workspace.generation += 1
          if (workspace.invocationId) inflightInvocationIds.delete(workspace.invocationId)
          workspace.invocationId = null
          try {
            workspace.handle.update?.({
              contractVersion: HOST_CONTRACT_VERSION,
              ownerToken: workspace.ownerToken,
              generation: workspace.generation,
              capabilities: ['close'],
              state: { open: false, bookId: null, entryId: null, invocationId: null, source: 'entry_table' satisfies LorebookActionSource },
            })
          } catch { /* no-op */ }
        })
        hostWorkspaces.push(workspace)
        hostWorkspaceDisposers.push(() => {
          try { unsubscribe?.() } finally {
            workspace.handle.destroy?.()
            if (surfaceId === HALF_WORKSPACE_SURFACE_ID) target.style.display = ''
          }
        })
        if (app) hostWorkspaceDisposers.push(() => { try { app?.destroy?.() } catch { /* no-op */ } })
      } catch {
        disposeHostWorkspaces()
        return
      }
    }
  }

  const installActions = (activationContext: SuiteModuleContext): void => {
    if (actionDisposers.length > 0) return
    const registerInputBarAction = activationContext.host.ui.registerInputBarAction
    if (typeof registerInputBarAction !== 'function') return
    const actions: Array<{ id: string; label: string; tooltip: string; surfaceId: typeof HALF_WORKSPACE_SURFACE_ID | typeof ENHANCED_WORKSPACE_SURFACE_ID; after: string; order: number; icon: string }> = [
      {
        id: HALF_ACTION_ID,
        label: 'Half-Screen Lorebook Editor',
        tooltip: 'Half-Screen Lorebook Editor',
        surfaceId: HALF_WORKSPACE_SURFACE_ID,
        after: 'worldBookEditor',
        order: 50,
        icon: 'split-panel',
      },
      {
        id: ENHANCED_ACTION_ID,
        label: 'Full-Screen Lorebook Editor',
        tooltip: 'Full-Screen Lorebook Editor',
        surfaceId: ENHANCED_WORKSPACE_SURFACE_ID,
        after: HALF_ACTION_ID,
        order: 51,
        icon: 'workspace-maximize',
      },
    ]
    try {
      for (const descriptor of actions) {
        const action = registerInputBarAction({
          id: descriptor.id,
          label: descriptor.label,
          tooltip: descriptor.tooltip,
          placement: 'world_book.entry_toolbar',
          after: descriptor.after,
          iconName: descriptor.icon,
          enabled: true,
          order: descriptor.order,
          payloadVersion: 1,
          source: 'entry_table' satisfies LorebookActionSource,
        } as Parameters<typeof registerInputBarAction>[0]) as InputActionHandle
        const unsubscribe = action.onClick?.((payload?: unknown) => {
          const invocation = parseInvocationPayload(payload, current.bookId)
          if (!invocation) return
          if (invocation.invocationId && inflightInvocationIds.has(invocation.invocationId)) return
          if (invocation.bookId !== current.bookId) {
            current = normalizeLorebookWorkspaceSettings({ ...current, bookId: invocation.bookId })
            void settings?.set(LOREBOOK_WORKSPACE_SETTINGS_KEY, current).catch(() => undefined)
            disposeActive()
            if (running && current.enabled) activate()
          }
          const opened = openHostWorkspace(descriptor.surfaceId, invocation.entryId ?? null, invocation.source, invocation.invocationId)
          if (opened && invocation.invocationId) inflightInvocationIds.add(invocation.invocationId)
        })
        actionDisposers.push(() => { try { unsubscribe?.() } finally { action.destroy?.() } })
      }
    } catch {
      disposeActions()
    }
  }


  const updateSurfaceProps = (): void => {
    const bookId = current.bookId
    if (!bookId) return
    const table = tableHandle
    if (table?.update) {
      try {
        table.update({
          bookId,
          ...(selectedId ? { selectedEntryId: selectedId } : {}),
        })
      } catch { /* host surface may have been torn down */ }
    }
    const editor = editorHandle
    if (editor?.update && selectedId) {
      try {
        editor.update({ bookId, entryId: selectedId, density: current.density })
      } catch { /* host surface may have been torn down */ }
    }
  }

  const ensureEditorPermission = async (
    activationContext: SuiteModuleContext,
    expectedGeneration: number,
  ): Promise<boolean> => {
    if (!isCurrent(expectedGeneration, activationContext)) return false
    if (editorPermission === 'granted') return true
    if (pendingPermission) return pendingPermission

    const request = (async () => {
      try {
        const granted = await new PermissionBroker(activationContext.host).ensure(
          'world_books',
          'edit world-book entries in Lorebook Workspace',
        )
        if (!isCurrent(expectedGeneration, activationContext)) return false
        editorPermission = granted ? 'granted' : 'denied'
        return granted
      } catch {
        if (isCurrent(expectedGeneration, activationContext)) editorPermission = 'denied'
        return false
      }
    })()
    pendingPermission = request
    void request.finally(() => {
      if (pendingPermission === request) pendingPermission = undefined
    })
    return request
  }

  const mountEditorForSelection = async (
    activationContext: SuiteModuleContext,
    expectedGeneration: number,
  ): Promise<void> => {
    if (!isCurrent(expectedGeneration, activationContext) || !selectedId || !current.bookId) return
    if (!await ensureEditorPermission(activationContext, expectedGeneration)) return
    if (!isCurrent(expectedGeneration, activationContext) || !selectedId || !current.bookId) return
    const target = editorTarget
    const mountHostSurface = activationContext.host.components.mountHostSurface
    if (!target || typeof mountHostSurface !== 'function') return

    const bookId = current.bookId
    const entryId = selectedId
    if (editorHandle?.update) {
      try {
        editorHandle.update({ bookId, entryId, density: current.density })
        return
      } catch {
        editorHandle = undefined
      }
    }

    try {
      const mounted = mountHostSurface(target, EDITOR_SURFACE_ID, {
        bookId,
        entryId,
        density: current.density,
      })
      if (!isRecord(mounted)) return
      const handle = mounted as SurfaceHandle
      editorHandle = handle
      activeDisposers.push(() => {
        try { handle.destroy?.() } catch { /* no-op */ }
      })
    } catch {
      editorHandle = undefined
    }
  }

  const handleSelection = (
    payload: unknown,
    activationContext: SuiteModuleContext,
    expectedGeneration: number,
  ): void => {
    const entryId = selectedEntryId(payload)
    if (!entryId || !isCurrent(expectedGeneration, activationContext) || !current.bookId) return
    selectedId = entryId
    if (tableHandle?.update) {
      try {
        tableHandle.update({ bookId: current.bookId, selectedEntryId: entryId })
      } catch { /* no-op */ }
    }
    void mountEditorForSelection(activationContext, expectedGeneration)
  }

  const activate = (): void => {
    const activationContext = context
    if (!activationContext || !running || !current.enabled || activeRoot || !current.bookId) return
    const expectedGeneration = lifecycleGeneration
    const surfaces = hostSurfaces(activationContext.host)
    if (!surfaces) return
    let mountPoint: ScopedHostRoot
    try {
      mountPoint = requireScopedHostRoot(surfaces.mount(WORKSPACE_MOUNT_POINT), 'LOREBOOK_WORKSPACE_MOUNT_UNAVAILABLE')
    } catch {
      return
    }
    const doc = ownerDocumentOf(mountPoint)
    if (!doc) return

    const root = doc.createElement('section')
    markOwned(root, extensionUuid(activationContext))
    root.dataset.lumiverseLorebookWorkspace = 'true'
    const table = doc.createElement('div')
    table.dataset.lumiverseLorebookTable = 'true'
    markOwned(table, extensionUuid(activationContext))
    const editor = doc.createElement('div')
    editor.dataset.lumiverseLorebookEditor = 'true'
    markOwned(editor, extensionUuid(activationContext))
    root.append(table, editor)
    mountPoint.append(root)
    activeRoot = root
    tableTarget = table
    editorTarget = editor

    try {
      if (!stylesActive) {
        activationContext.styles.add(MODULE_STYLES, { scope: 'root' })
        stylesActive = true
      }
      const mountedTable = surfaces.mountHostSurface(table, TABLE_SURFACE_ID, {
        bookId: current.bookId,
      })
      if (!isRecord(mountedTable)) throw new Error('WORLD_BOOK_TABLE_SURFACE_UNAVAILABLE')
      const handle = mountedTable as SurfaceHandle
      tableHandle = handle
      activeDisposers.push(() => {
        try { handle.destroy?.() } catch { /* no-op */ }
      })
      const unsubscribe = handle.on?.(
        'select',
        payload => handleSelection(payload, activationContext, expectedGeneration),
      )
      if (unsubscribe) activeDisposers.push(unsubscribe)
    } catch {
      disposeActive()
    }
  }

  const applySettings = (value: unknown): void => {
    const next = normalizeLorebookWorkspaceSettings(value)
    if (sameSettings(current, next)) return
    current = next
    if (!running) return
    if (!current.enabled) {
      disposeActions()
      disposeHostWorkspaces()
      disposeActive()
      return
    }
    disposeActive()
    installHostWorkspaces(context!)
    installActions(context!)
    activate()
  }

  const applyBookSelection = (value: unknown): void => {
    const next = selectedBook(value)
    if (!next) return
    const nextSettings = normalizeLorebookWorkspaceSettings({
      ...current,
      bookId: next.bookId,
      density: next.density ?? current.density,
    })
    if (sameSettings(current, nextSettings)) return
    const bookChanged = current.bookId !== nextSettings.bookId
    current = nextSettings
    void settings?.set(LOREBOOK_WORKSPACE_SETTINGS_KEY, current).catch(() => undefined)
    if (!running) return
    if (bookChanged) {
      disposeActive()
      if (current.enabled) activate()
      return
    }
    updateSurfaceProps()
  }

  const loadSettings = async (settingsApi: SuiteSettingsAPI): Promise<{ saved: unknown; settings: LorebookWorkspaceSettings }> => {
    const saved = await settingsApi.get<unknown>(LOREBOOK_WORKSPACE_SETTINGS_KEY)
    return {
      saved,
      settings: saved === undefined
        ? defaultLorebookWorkspaceSettings()
        : normalizeLorebookWorkspaceSettings(saved),
    }
  }

  return {
    id: MODULE_ID,
    async start(nextContext?: SuiteModuleContext) {
      if (running || starting) return
      if (!nextContext) throw new Error('LOREBOOK_WORKSPACE_CONTEXT_REQUIRED')
      starting = true
      const startGeneration = ++lifecycleGeneration
      context = nextContext
      let settingsApi: SuiteSettingsAPI
      try {
        settingsApi = requireSuiteSettings(nextContext)
        const loaded = await loadSettings(settingsApi)
        if (startGeneration !== lifecycleGeneration || context !== nextContext) {
          starting = false
          return
        }
        current = loaded.settings
        if (!sameStoredSettings(loaded.saved, current)) {
          await settingsApi.set(LOREBOOK_WORKSPACE_SETTINGS_KEY, current)
          if (startGeneration !== lifecycleGeneration || context !== nextContext) {
            starting = false
            return
          }
        }
      } catch (error) {
        if (startGeneration === lifecycleGeneration && context === nextContext) {
          starting = false
          context = undefined
        }
        throw error
      }

      settings = settingsApi
      running = true
      starting = false
      stopSettingsWatch = settingsApi.watch<unknown>(LOREBOOK_WORKSPACE_SETTINGS_KEY, applySettings)
      stopBusListener = nextContext.bus?.on(BOOK_SELECTED_EVENT, applyBookSelection)
      if (current.enabled) {
        installHostWorkspaces(nextContext)
        installActions(nextContext)
        activate()
      }
    },
    stop() {
      if (!running && !starting && !context) return
      running = false
      starting = false
      lifecycleGeneration += 1
      // Disable ordering: reject new invocations, remove actions, destroy their
      // workspaces, then release subscriptions and remaining owned presentation.
      disposeActions()
      disposeHostWorkspaces()
      stopSettingsWatch?.()
      stopSettingsWatch = undefined
      stopBusListener?.()
      stopBusListener = undefined
      disposeActive()
      settings = undefined
      context = undefined
    },
  }
}

export {
  BOOK_SELECTED_EVENT as LOREBOOK_WORKSPACE_BOOK_SELECTED_EVENT,
  EDITOR_SURFACE_ID as LOREBOOK_WORKSPACE_EDITOR_SURFACE_ID,
  TABLE_SURFACE_ID as LOREBOOK_WORKSPACE_TABLE_SURFACE_ID,
}
export * from './types'
