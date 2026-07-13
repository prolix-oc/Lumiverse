import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { SpindleManifest } from 'lumiverse-spindle-types'

type FakeRoot = {
  parentElement: object | null
  removed: boolean
  setAttribute(name: string, value: string): void
  replaceChildren(): void
  remove(): void
}

type PermissionResult = { granted: string[] }
type LifecycleGlobals = typeof globalThis & Record<string, unknown>

const lifecycleGlobals = globalThis as LifecycleGlobals
const removedRoots: FakeRoot[] = []
const wsHandlers = new Map<string, Set<(payload: unknown) => void>>()
const windowHandlers = new Map<string, Set<EventListenerOrEventListenerObject>>()
const placementDestroyCalls: string[] = []
let permissionPromise: Promise<PermissionResult> = Promise.resolve({ granted: [] })
let objectUrlSequence = 0
let accessCreations = 0
const windowMock = {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const handlers = windowHandlers.get(type) ?? new Set<EventListenerOrEventListenerObject>()
    handlers.add(listener)
    windowHandlers.set(type, handlers)
  },
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    windowHandlers.get(type)?.delete(listener)
  },
  dispatchEvent(event: Event): boolean {
    for (const listener of windowHandlers.get(event.type) ?? []) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
    return true
  },
}

const documentMock = {
  body: {
    hasAttribute: () => false,
  },
  createElement: () => {
    const root: FakeRoot = {
      parentElement: null,
      removed: false,
      setAttribute() {},
      replaceChildren() {},
      remove() {
        root.removed = true
      },
    }
    removedRoots.push(root)
    return root
  },
  querySelector: () => null,
}

class FakeMutationObserver {
  constructor(_callback: MutationCallback) {}
  observe() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'window', { configurable: true, value: windowMock })
Object.defineProperty(globalThis, 'document', { configurable: true, value: documentMock })
Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: FakeMutationObserver })
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: () => {
    objectUrlSequence += 1
    const source = String(lifecycleGlobals.__lifecycleModuleSource ?? '')
    return `data:text/javascript,${encodeURIComponent(source)}?${objectUrlSequence}`
  },
})
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
const storeState = {
  pendingPermissionRequest: null as { id: string; extensionId: string } | null,
  showPermissionRequest(request: { id: string; extensionId: string }) {
    storeState.pendingPermissionRequest = request
  },
}
const useStoreMock = {
  getState: () => storeState,
  setState(update: { pendingPermissionRequest?: null } | ((state: typeof storeState) => Partial<typeof storeState>)) {
    const next = typeof update === 'function' ? update(storeState) : update
    Object.assign(storeState, next)
  },
}

const wsClientMock = {
  on(event: string, handler: (payload: unknown) => void) {
    const handlers = wsHandlers.get(`ws:${event}`) ?? new Set<(payload: unknown) => void>()
    handlers.add(handler)
    wsHandlers.set(`ws:${event}`, handlers)
    return () => handlers.delete(handler)
  },
  send() {},
}
function dispatchWs(event: string, payload: unknown): void {
  for (const handler of wsHandlers.get(`ws:${event}`) ?? []) handler(payload)
}
function dispatchWindow(event: string, detail: unknown): void {
  windowMock.dispatchEvent({ type: event, detail } as unknown as Event)
}

const presetAccessMock = {
  createPresetEditorAccess: (
    _extensionIdentifier: string,
    getGrantedPermissions: () => readonly string[],
  ) => {
    accessCreations += 1
    let disposed = false
    const accessId = accessCreations
    return {
      acquire() {
        if (disposed) throw new Error('PRESET_EDITOR_DISPOSED')
        if (!getGrantedPermissions().includes('presets')) throw new Error('PERMISSION_DENIED:presets')
        return {
          getState() {
            if (disposed) throw new Error('PRESET_EDITOR_DISPOSED')
            return { accessId }
          },
        }
      },
      dispose() {
        disposed = true
      },
    }
  },
}

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/ws/client', () => ({ wsClient: wsClientMock }))
mock.module('@/api/spindle', () => ({ spindleApi: { getPermissions: () => permissionPromise } }))
mock.module('@/api/characters', () => ({ charactersApi: { get: async () => null } }))
mock.module('@/api/chats', () => ({ messagesApi: { update: async () => ({ id: 'message' }) } }))
mock.module('./dom-helper', () => ({ createDOMHelper: () => ({ cleanup() {} }) }))
mock.module('./message-interceptors', () => ({ registerTagInterceptor: () => () => {}, unregisterTagInterceptorsByExtension() {} }))
mock.module('./display-resolver-registry', () => ({ registerDisplayResolver: () => () => {}, unregisterDisplayResolver() {} }))
mock.module('@/hooks/useDisplayRegex', () => ({ invalidateDisplayRegexCache() {}, invalidateDisplayRegexCacheForVars() {} }))
mock.module('./message-widgets', () => ({ removeMessageWidgetsByExtension() {}, upsertMessageWidget: () => {}, removeMessageWidget() {} }))
mock.module('./placement-helper', () => ({
  createDrawerTabHandle: () => ({ destroy() {} }),
  createCharacterEditorTabHandle: () => ({ destroy() {} }),
  createPresetEditorTabHandle: () => ({ destroy() {} }),
  createPresetEditorToolbarItemHandle: () => ({ destroy() {} }),
  createFloatWidgetHandle: () => ({ destroy() {} }),
  createDockPanelHandle: () => ({ destroy() {} }),
  createAppMountHandle: () => ({ destroy() {} }),
  createInputBarActionHandle: () => ({ destroy() {} }),
  createTabMobilityHandle: () => ({ requestTabLocation() {} }),
  clearTabMobilityHandle() {},
  destroyAllPlacementsForExtension(extensionId: string) { placementDestroyCalls.push(extensionId) },
  destroyPresetEditorPlacementsForExtension(extensionId: string) { placementDestroyCalls.push(`preset:${extensionId}`) },
}))
mock.module('./character-editor-helper', () => ({
  getCharacterEditorState: () => ({}),
  subscribeCharacterEditorState: () => () => {},
  setCharacterEditorExtensions() {},
  updateCharacterEditorExtensions() {},
  flushCharacterEditorExtensions: async () => {},
}))
mock.module('./preset-editor-helper', () => ({
  getPresetEditorState: () => ({}),
  subscribePresetEditorState: () => () => {},
  updatePresetEditorDraft() {},
  flushPresetEditorDraft: async () => {},
}))
mock.module('./preset-editor-access', () => presetAccessMock)
mock.module('./components-helper', () => ({ createComponentsHelper: () => ({}), destroyAllComponentsForExtension() {} }))
mock.module('@/lib/uuid', () => ({ generateUUID: () => 'request-id' }))
mock.module('./navigation-guards', () => ({ installSpindleNavigationGuards() {} }))
mock.module('@/lib/drawer-tab-registry', () => ({ DRAWER_TABS: [], ensureRegistryRoot: () => undefined }))
mock.module('./ui-events-helper', () => ({ createUIEventsHelper: () => ({}) }))
mock.module('./browser-scheduler', () => ({ yieldToBrowser: async () => {} }))

const lifecycleModuleSource = `
  export function teardown() {
    globalThis["__lifecycleTeardownCalls"] = Number(globalThis["__lifecycleTeardownCalls"] || 0) + 1;
  }
  export function setup(context) {
    globalThis["__lifecycleContext"] = context;
    if (globalThis["__lifecycleCaptureHelper"]) {
      globalThis["__lifecycleRetainedHelper"] = context["ui"]["presetEditor"]["extension"];
    }
    if (globalThis["__lifecycleMount"]) context["ui"]["mount"]('main');
    const result = globalThis["__lifecycleSetupResult"];
    if (globalThis["__lifecycleReturnStaticTeardown"] && result && typeof result["then"] === 'function') {
      return result["then"](() => teardown);
    }
    return result;
  }
`
lifecycleGlobals.__lifecycleModuleSource = lifecycleModuleSource

globalThis.fetch = (async () => new Response(lifecycleModuleSource)) as unknown as typeof fetch

const { getLoadedExtensions, loadFrontendExtension, unloadFrontendExtension } = await import('./loader')
mock.restore()

const manifest: SpindleManifest = {
  version: '1.0.0',
  name: 'Lifecycle test',
  identifier: 'lifecycle_test',
  author: 'test',
  github: 'https://example.test/lifecycle',
  homepage: 'https://example.test/lifecycle',
  permissions: ['presets'],
}

type LifecycleContext = {
  ui: {
    mount(point: string): FakeRoot
    presetEditor: {
      extension: {
        getState(): unknown
      }
    }
  }
  permissions: {
    request(permissions: string[]): Promise<string[]>
  }
}

function resetHarness(): void {
  permissionPromise = Promise.resolve({ granted: [] })
  lifecycleGlobals.__lifecycleSetupResult = undefined
  lifecycleGlobals.__lifecycleContext = undefined
  lifecycleGlobals.__lifecycleCaptureHelper = false
  lifecycleGlobals.__lifecycleRetainedHelper = undefined
  lifecycleGlobals.__lifecycleMount = false
  lifecycleGlobals.__lifecycleReturnStaticTeardown = false
  lifecycleGlobals.__lifecycleTeardownCalls = 0
  storeState.pendingPermissionRequest = null
  wsHandlers.clear()
  windowHandlers.clear()
  removedRoots.splice(0)
  placementDestroyCalls.splice(0)
  accessCreations = 0
}

async function flushLifecycleTasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeAll(() => resetHarness())
afterEach(() => resetHarness())

describe('loader lifecycle orchestration', () => {
  test('revocation observed before GET resolution wins, then a WS regrant creates fresh access', async () => {
    let resolvePermissions!: (result: PermissionResult) => void
    permissionPromise = new Promise<PermissionResult>((resolve) => {
      resolvePermissions = resolve
    })
    const loading = loadFrontendExtension('revoke_before_get', manifest)
    await Promise.resolve()
    await Promise.resolve()
    dispatchWs('SPINDLE_PERMISSION_CHANGED', {
      extensionId: 'revoke_before_get',
      allGranted: [],
    })
    resolvePermissions({ granted: ['presets'] })
    await loading

    const context = lifecycleGlobals.__lifecycleContext as LifecycleContext
    expect(() => context.ui.presetEditor.extension).toThrow('PERMISSION_DENIED:presets')
    dispatchWs('SPINDLE_PERMISSION_CHANGED', {
      extensionId: 'revoke_before_get',
      allGranted: ['presets'],
    })
    const fresh = context.ui.presetEditor.extension
    expect(fresh.getState()).toMatchObject({ accessId: 2 })
    await unloadFrontendExtension('revoke_before_get')
  })

  test('starts a fresh generation after unload invalidates a pending load', async () => {
    const originalFetch = globalThis.fetch
    let resolveFirstFetch!: (response: Response) => void
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return new Promise<Response>((resolve) => { resolveFirstFetch = resolve })
      }
      return new Response(lifecycleModuleSource)
    }) as unknown as typeof fetch

    try {
      permissionPromise = Promise.resolve({ granted: [] })
      const first = loadFrontendExtension('reload_after_invalidation', {
        ...manifest,
        identifier: 'reload_after_invalidation',
      })
      await Promise.resolve()
      await Promise.resolve()
      await unloadFrontendExtension('reload_after_invalidation')

      const second = loadFrontendExtension('reload_after_invalidation', {
        ...manifest,
        identifier: 'reload_after_invalidation',
      })
      resolveFirstFetch(new Response(lifecycleModuleSource))
      await Promise.all([first, second])

      expect(fetchCount).toBe(2)
      expect(getLoadedExtensions().has('reload_after_invalidation')).toBe(true)
      await unloadFrontendExtension('reload_after_invalidation')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('permission-request approval recreates access and rejects the retained helper', async () => {
    permissionPromise = Promise.resolve({ granted: ['presets'] })
    lifecycleGlobals.__lifecycleCaptureHelper = true
    await loadFrontendExtension('request_regrant', { ...manifest, identifier: 'request_regrant' })

    const context = lifecycleGlobals.__lifecycleContext as LifecycleContext
    const retained = lifecycleGlobals.__lifecycleRetainedHelper as LifecycleContext['ui']['presetEditor']['extension']
    dispatchWs('SPINDLE_PERMISSION_CHANGED', {
      extensionId: 'request_regrant',
      allGranted: [],
    })
    expect(() => retained.getState()).toThrow('PRESET_EDITOR_DISPOSED')

    const request = context.permissions.request(['presets'])
    dispatchWindow('spindle:permission-resolved', {
      requestId: 'request-id',
      approved: true,
      granted: ['presets'],
    })
    await request
    const fresh = context.ui.presetEditor.extension
    expect(fresh.getState()).toMatchObject({ accessId: 2 })
    await unloadFrontendExtension('request_regrant')
  })

  test('stale permission approval cannot restore access after a newer revoke', async () => {
    permissionPromise = Promise.resolve({ granted: ['presets'] })
    await loadFrontendExtension('stale_request', { ...manifest, identifier: 'stale_request' })

    const context = lifecycleGlobals.__lifecycleContext as LifecycleContext
    dispatchWs('SPINDLE_PERMISSION_CHANGED', {
      extensionId: 'stale_request',
      allGranted: [],
    })
    const request = context.permissions.request(['presets'])
    dispatchWs('SPINDLE_PERMISSION_CHANGED', {
      extensionId: 'stale_request',
      allGranted: [],
    })
    dispatchWindow('spindle:permission-resolved', {
      requestId: 'request-id',
      approved: true,
      granted: ['presets'],
    })

    expect(await request).toEqual([])
    expect(() => context.ui.presetEditor.extension).toThrow('PERMISSION_DENIED:presets')
    await unloadFrontendExtension('stale_request')
  })

  test('late setup rejection unloads roots, placements, and permission listeners', async () => {
    let rejectSetup!: (error: Error) => void
    lifecycleGlobals.__lifecycleSetupResult = new Promise<unknown>((_resolve, reject) => {
      rejectSetup = reject
    })
    lifecycleGlobals.__lifecycleMount = true
    const loading = loadFrontendExtension('late_setup_failure', { ...manifest, identifier: 'late_setup_failure' })
    await loading
    rejectSetup(new Error('late setup failure'))
    await flushLifecycleTasks()

    expect(getLoadedExtensions().has('late_setup_failure')).toBe(false)
    expect(placementDestroyCalls).toContain('late_setup_failure')
    expect(removedRoots.some((root) => root.removed)).toBe(true)
    expect(wsHandlers.get('ws:SPINDLE_PERMISSION_CHANGED')?.size ?? 0).toBe(0)
  })

  test('late async setup teardown matching claimed static teardown runs once', async () => {
    let resolveSetup!: () => void
    lifecycleGlobals.__lifecycleReturnStaticTeardown = true
    lifecycleGlobals.__lifecycleSetupResult = new Promise<void>((resolve) => {
      resolveSetup = resolve
    })
    await loadFrontendExtension('same_teardown', { ...manifest, identifier: 'same_teardown' })
    await unloadFrontendExtension('same_teardown')
    resolveSetup()
    await flushLifecycleTasks()

    expect(lifecycleGlobals.__lifecycleTeardownCalls).toBe(1)
  })
})
