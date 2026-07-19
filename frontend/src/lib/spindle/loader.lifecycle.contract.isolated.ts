import type { SpindleManifest } from 'lumiverse-spindle-types'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { PendingConfirmRequest, SpindlePlacementSlice, SpindleSlice } from '@/types/store'
import { createSpindlePlacementSlice } from '@/store/slices/spindle-placement'
import {
  clearLiveRootsForExtension,
  getLiveRootRecord,
  getLiveRootRecordExact,
  registerLiveRoot,
  subscribeLiveRoot,
  unregisterLiveRoot,
} from './live-root-registry'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  Event: globalThis.Event,
  CustomEvent: globalThis.CustomEvent,
  MouseEvent: globalThis.MouseEvent,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  fetch: globalThis.fetch,
}
const originalGlobalDescriptors = new Map<string, PropertyDescriptor | undefined>(
  ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})
const confirmWindowListeners = new Set<EventListenerOrEventListenerObject>()
const nativeWindowAddEventListener = dom.window.addEventListener.bind(dom.window)
const nativeWindowRemoveEventListener = dom.window.removeEventListener.bind(dom.window)
dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  if (type === 'spindle:confirm-resolved') confirmWindowListeners.add(listener)
  nativeWindowAddEventListener(type, listener, options)
}) as typeof dom.window.addEventListener
dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  if (type === 'spindle:confirm-resolved') confirmWindowListeners.delete(listener)
  nativeWindowRemoveEventListener(type, listener, options)
}) as typeof dom.window.removeEventListener

type TestStoreState = SpindlePlacementSlice & SpindleSlice
const createPlacementStore = (): StoreApi<SpindlePlacementSlice> => createStore<SpindlePlacementSlice>(createSpindlePlacementSlice)
let placementStore: StoreApi<SpindlePlacementSlice> = createPlacementStore()
let spindleStore: StoreApi<SpindleSlice> | null = null
const confirmRequests: PendingConfirmRequest[] = []

function getSpindleStore(): StoreApi<SpindleSlice> {
  if (!spindleStore) throw new Error('Spindle store has not been initialized')
  return spindleStore
}

function readStoreState(): TestStoreState {
  return { ...placementStore.getState(), ...getSpindleStore().getState() }
}

const useStoreMock = Object.assign(
  <T>(selector?: (state: TestStoreState) => T): T | TestStoreState => {
    const state = readStoreState()
    return selector ? selector(state) : state
  },
  {
    getState: readStoreState,
    setState: (...args: Parameters<StoreApi<SpindleSlice>['setState']>) => getSpindleStore().setState(...args),
    subscribe: (...args: Parameters<StoreApi<SpindlePlacementSlice>['subscribe']>) => placementStore.subscribe(...args),
  },
)

const NullComponent = () => null
mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/components/shared/FormComponents', () => ({ TextInput: NullComponent, TextArea: NullComponent }))
mock.module('@/components/shared/FormComponents.module.css', () => ({ default: {} }))
mock.module('@/components/shared/NumericInput', () => ({ default: NullComponent }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/RangeSlider', () => ({ RangeSlider: NullComponent, LabeledRangeSlider: NullComponent }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: NullComponent }))
mock.module('@/components/shared/Badge', () => ({ Badge: NullComponent }))
mock.module('@/components/shared/Spinner', () => ({ Spinner: NullComponent }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: NullComponent }))
mock.module('@/components/shared/Pagination', () => ({ default: NullComponent }))
mock.module('@/components/shared/CollapsibleSection', () => ({ default: NullComponent }))
mock.module('@/components/shared/SearchableSelect', () => ({
  default: NullComponent,
  PORTAL_OWNER_ACTIVE_ATTRIBUTE: 'data-spindle-component-portal-owner-active',
  PORTAL_OWNER_ACTIVITY_EVENT: 'spindle:component-portal-owner-activity',
}))
mock.module('@/components/shared/FolderDropdown', () => ({ default: NullComponent }))
mock.module('@/components/panels/connection-manager/ModelCombobox', () => ({ default: NullComponent }))
mock.module('@/components/panels/LoomBuilder', () => ({ ControlledLoomBlockEditor: NullComponent }))
mock.module('@/api/connections', () => ({ connectionsApi: {} }))
mock.module('@/api/image-gen-connections', () => ({ imageGenConnectionsApi: {} }))
mock.module('@/api/tts-connections', () => ({ ttsConnectionsApi: {} }))
const loaderWsHandlers = new Map<string, Set<(payload: unknown) => void>>()
const loaderWsSends: unknown[] = []
const characterListeners = new Set<(state: unknown) => void>()
let permissionApiCalls = 0
let characterApiCalls = 0
let chatApiCalls = 0
let tagRegistrations = 0
let displayRegistrations = 0
let widgetRegistrations = 0
const loaderWsClient = {
  on(event: string, handler: (payload: unknown) => void) {
    const handlers = loaderWsHandlers.get(event) ?? new Set<(payload: unknown) => void>()
    handlers.add(handler)
    loaderWsHandlers.set(event, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0 && loaderWsHandlers.get(event) === handlers) loaderWsHandlers.delete(event)
    }
  },
  send(payload: unknown) {
    loaderWsSends.push(payload)
  },
}
let mockedGrantedPermissions = ['ui_panels', 'presets']
mock.module('@/ws/client', () => ({ wsClient: loaderWsClient }))
mock.module('@/api/spindle', () => ({
  spindleApi: {
    getPermissions: async () => {
      permissionApiCalls += 1
      return { granted: [...mockedGrantedPermissions] }
    },
  },
}))
mock.module('@/api/characters', () => ({
  charactersApi: {
    get: async () => {
      characterApiCalls += 1
      return null
    },
  },
}))
mock.module('@/api/chats', () => ({
  messagesApi: {
    update: async () => {
      chatApiCalls += 1
      return { id: 'message' }
    },
  },
}))
mock.module('./message-interceptors', () => ({
  registerTagInterceptor: () => {
    tagRegistrations += 1
    return () => {}
  },
  unregisterTagInterceptorsByExtension() {},
}))
mock.module('./display-resolver-registry', () => ({
  registerDisplayResolver: () => {
    displayRegistrations += 1
    return () => {}
  },
  unregisterDisplayResolver() {},
}))
mock.module('@/hooks/useDisplayRegex', () => ({ invalidateDisplayRegexCache() {}, invalidateDisplayRegexCacheForVars() {} }))
mock.module('./message-widgets', () => ({
  removeMessageWidgetsByExtension() {},
  upsertMessageWidget: () => {
    widgetRegistrations += 1
  },
  removeMessageWidget() {},
}))
mock.module('./character-editor-helper', () => ({
  getCharacterEditorState: () => ({}),
  subscribeCharacterEditorState: (handler: (state: unknown) => void) => {
    characterListeners.add(handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      characterListeners.delete(handler)
    }
  },
  setCharacterEditorExtensions() {},
  updateCharacterEditorExtensions() {},
  flushCharacterEditorExtensions: async () => {},
  setCharacterEditorActiveTab() {},
}))
mock.module('./navigation-guards', () => ({ installSpindleNavigationGuards() {} }))
mock.module('@/lib/drawer-tab-registry', () => ({ DRAWER_TABS: [], ensureRegistryRoot: () => undefined }))
mock.module('./browser-scheduler', () => ({ yieldToBrowser: async () => {}, scheduleSpindleDomTask: () => () => {} }))

// These factories intentionally load after the narrow store and visual-component
// mocks; the real production helpers retain the mocked boundary references.
const {
  createComponentsHelper,
  destroyAllComponentsForExtension,
  destroyComponentsForExtensionPermission,
} = await import('./components-helper')
const { createDOMHelper } = await import('./dom-helper')
const {
  createDrawerTabHandle,
  createCharacterEditorTabHandle,
  createPresetEditorTabHandle,
  createPresetEditorToolbarItemHandle,
  createFloatWidgetHandle,
  createDockPanelHandle,
  createAppMountHandle,
  createInputBarActionHandle,
  destroyAllPlacementsForExtension,
  destroyPlacementsForExtensionPermission,
} = await import('./placement-helper')
const {
  createUIEventsHelper,
  destroyAllUIEventBindingsForExtension,
  destroyUIEventBindingsForExtensionPermission,
} = await import('./ui-events-helper')
const extensionId = 'lifecycle-contract-extension'
const generation = 11
const nextGeneration = 12

function resetStore(): void {
  placementStore = createPlacementStore()
  spindleStore = createSpindleStore()
  confirmRequests.length = 0
  placementStore.setState({
    drawerOpen: false,
    drawerTab: null,
    settingsModalOpen: false,
    settingsActiveView: 'general',
  } as never)
}
// The loader is intentionally loaded after boundary mocks so this test exercises
// its real lifecycle orchestration without importing the application graph.
const {
  loadFrontendExtension,
  unloadFrontendExtension,
  getLoadedExtensions,
  routeBackendMessage,
  routeFrontendProcessEvent,
} = await import('./loader')

// Keep this import after the boundary mocks: loading the real spindle slice statically
// would initialize the loader before its test-only store and UI replacements exist.
const { createSpindleSlice } = await import('@/store/slices/spindle')
const createSpindleStore = (): StoreApi<SpindleSlice> => {
  const store = createStore<SpindleSlice>(createSpindleSlice)
  store.subscribe((state, previous) => {
    if (state.pendingConfirm && state.pendingConfirm !== previous.pendingConfirm) {
      confirmRequests.push(state.pendingConfirm)
    }
  })
  return store
}

function resetResources(): void {
  if (!spindleStore) spindleStore = createSpindleStore()
  mockedGrantedPermissions = ['ui_panels', 'presets']
  loaderWsSends.length = 0
  characterListeners.clear()
  permissionApiCalls = 0
  characterApiCalls = 0
  chatApiCalls = 0
  tagRegistrations = 0
  displayRegistrations = 0
  widgetRegistrations = 0
  destroyAllComponentsForExtension(extensionId)
  destroyAllPlacementsForExtension(extensionId)
  destroyAllUIEventBindingsForExtension(extensionId)
  clearLiveRootsForExtension(extensionId)
  document.body.replaceChildren()
  resetStore()
}

beforeEach(resetResources)
afterEach(() => {
  resetResources()
  expect(loaderWsHandlers.size).toBe(0)
  expect(confirmWindowListeners.size).toBe(0)
})
afterAll(async () => {
  expect(loaderWsHandlers.size).toBe(0)
  mock.restore()
  await new Promise<void>((resolve) => setImmediate(resolve))
  Object.assign(globalThis, originalGlobals)
  for (const [key, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor)
  }
  expect(globalThis.window).toBe(originalGlobals.window)
  expect(globalThis.document).toBe(originalGlobals.document)
  expect(globalThis.fetch).toBe(originalGlobals.fetch)
})

describe('live-root generation and ownership contract', () => {
  test('records producer metadata and rejects unversioned or mismatched exact generations', () => {
    const root = document.createElement('section')
    document.body.append(root)
    const unregister = registerLiveRoot(extensionId, root, 'presets', generation)

    expect(getLiveRootRecordExact(extensionId, root)).toMatchObject({
      extensionId,
      permission: 'presets',
      generation,
    })
    expect(getLiveRootRecord(extensionId, root, generation)?.root).toBe(root)
    expect(getLiveRootRecord(extensionId, root, generation - 1)).toBeNull()
    expect(getLiveRootRecord(extensionId, root)).toMatchObject({ generation })
    unregisterLiveRoot(root, 'foreign-owner', generation)
    expect(getLiveRootRecordExact(extensionId, root, generation)?.root).toBe(root)
    unregisterLiveRoot(root, extensionId, generation - 1)
    expect(getLiveRootRecordExact(extensionId, root, generation)?.root).toBe(root)
    unregisterLiveRoot(root, extensionId, generation)
    expect(getLiveRootRecordExact(extensionId, root, generation)).toBeNull()

    const unversioned = document.createElement('div')
    document.body.append(unversioned)
    expect(() => registerLiveRoot(extensionId, unversioned, 'ui_panels')).toThrow('SPINDLE_ROOT_GENERATION_REQUIRED')
    const legacy = document.createElement('div')
    document.body.append(legacy)
    const unregisterLegacy = registerLiveRoot(extensionId, legacy, null)
    expect(getLiveRootRecord(extensionId, legacy, generation)).toBeNull()
    unregisterLegacy()
    expect(getLiveRootRecordExact(extensionId, legacy)).toBeNull()

    unregister()
    unregister()
    expect(getLiveRootRecordExact(extensionId, root, generation)).toBeNull()
  })

  test('notifies observable root subscribers once and clears callbacks with the root', () => {
    const firstRoot = document.createElement('section')
    const secondRoot = document.createElement('section')
    document.body.append(firstRoot, secondRoot)
    const notifications: string[] = []
    const unsubscribeFirst = subscribeLiveRoot(firstRoot, () => notifications.push('first'))
    const unregisterFirst = registerLiveRoot(extensionId, firstRoot, null, generation)

    unregisterFirst()
    unregisterFirst()
    expect(notifications).toEqual(['first'])
    unsubscribeFirst()
    unsubscribeFirst()

    const unsubscribeSecond = subscribeLiveRoot(secondRoot, () => notifications.push('second'))
    registerLiveRoot(extensionId, secondRoot, null, generation)
    clearLiveRootsForExtension(extensionId)
    expect(notifications).toEqual(['first', 'second'])
    clearLiveRootsForExtension(extensionId)
    expect(notifications).toEqual(['first', 'second'])
    unsubscribeSecond()
    unsubscribeSecond()
  })
  test('treats a nearer stale-generation root as a hard ownership boundary', () => {
    const outer = document.createElement('section')
    const inner = document.createElement('div')
    outer.append(inner)
    document.body.append(outer)
    registerLiveRoot(extensionId, outer, null, nextGeneration)
    registerLiveRoot(extensionId, inner, null, generation)

    expect(getLiveRootRecord(extensionId, inner, nextGeneration)).toBeNull()
    expect(getLiveRootRecordExact(extensionId, inner, nextGeneration)).toBeNull()
    clearLiveRootsForExtension(extensionId)
  })
})
describe('loader-owned roots', () => {
  test('stamps mount, modal, and injected roots, then unload removes them and invalidates the context', async () => {
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const loaderRootContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__loaderRootContext')
    const loaderMountDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__loaderMount')
    const loaderModalDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__loaderModal')
    const loaderInjectionDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__loaderInjection')
    const extensionId = 'loader-root-contract'
    const manifest: SpindleManifest = {
      version: '1.0.0',
      name: 'Loader root contract',
      identifier: extensionId,
      author: 'test',
      github: 'https://example.test/loader-root',
      homepage: 'https://example.test/loader-root',
      permissions: ['ui_panels'],
    }
    const source = `
      export function setup(context) {
        globalThis.__loaderRootContext = context;
        context.events.on('lifecycle', () => {});
        globalThis.__loaderMount = context.ui.mount('main');
        globalThis.__loaderModal = context.ui.showModal({ title: 'Contract', persistent: true });
        globalThis.__loaderInjection = context.dom.inject(document.body, '<span id="contract-injection">safe</span>');
      }
    `
    const mountTarget = document.createElement('div')
    mountTarget.setAttribute('data-spindle-mount', 'main')
    document.body.append(mountTarget)
    const originalFetch = globalThis.fetch
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', {
      value: originalCreateObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
    globalThis.fetch = (async () => new Response(source)) as unknown as typeof fetch
    try {
      await loadFrontendExtension(extensionId, manifest)
      const loaded = getLoadedExtensions().get(extensionId)
      const rootGeneration = loaded?.generation
      const loaderContext = loaderGlobals.__loaderRootContext as {
        events: { on(event: string, handler: (payload: unknown) => void): () => void }
        ui: {
          mount(point: string): Element
          registerDrawerTab(options: { id: string; title: string }): unknown
          showModal(options: { title: string; persistent: boolean }): { root: Element; dismiss(): void }
        }
      }
      const mountRoot = loaderGlobals.__loaderMount as Element
      const modal = loaderGlobals.__loaderModal as { root: Element; dismiss(): void }
      const injected = loaderGlobals.__loaderInjection as Element

      expect(rootGeneration).toBe(1)
      expect(loaderWsHandlers.get('lifecycle')?.size).toBe(1)
      expect(getLiveRootRecordExact(extensionId, mountRoot, rootGeneration)).toMatchObject({ permission: null, generation: rootGeneration })
      expect(getLiveRootRecordExact(extensionId, modal.root, rootGeneration)).toMatchObject({ permission: null, generation: rootGeneration })
      expect(getLiveRootRecordExact(extensionId, injected, rootGeneration)).toMatchObject({ permission: null, generation: rootGeneration })
      expect(mountRoot.parentElement).toBe(mountTarget)
      expect(document.body.contains(modal.root)).toBe(true)
      expect(document.body.contains(injected)).toBe(true)

      const rootNotifications: string[] = []
      const unsubscribeRoot = subscribeLiveRoot(mountRoot, () => rootNotifications.push('unregistered'))
      await unloadFrontendExtension(extensionId)
      expect(loaderWsHandlers.size).toBe(0)
      expect(getLoadedExtensions().has(extensionId)).toBe(false)
      expect(getLiveRootRecordExact(extensionId, mountRoot, rootGeneration)).toBeNull()
      expect(getLiveRootRecordExact(extensionId, modal.root, rootGeneration)).toBeNull()
      expect(getLiveRootRecordExact(extensionId, injected, rootGeneration)).toBeNull()
      expect(document.body.contains(modal.root)).toBe(false)
      expect(document.body.contains(injected)).toBe(false)
      expect(rootNotifications).toEqual(['unregistered'])
      expect(() => loaderContext.ui.mount('main')).toThrow('SPINDLE_FRONTEND_INACTIVE')
      expect(() => loaderContext.ui.showModal({ title: 'stale', persistent: true })).toThrow('SPINDLE_FRONTEND_INACTIVE')
      expect(() => loaderContext.ui.registerDrawerTab({ id: 'stale', title: 'stale' })).toThrow('SPINDLE_FRONTEND_INACTIVE')
      expect(() => loaderContext.events.on('stale', () => {})).toThrow('SPINDLE_FRONTEND_INACTIVE')
      unsubscribeRoot()

      await loadFrontendExtension(extensionId, manifest)
      const reloaded = getLoadedExtensions().get(extensionId)
      expect(reloaded?.generation).toBeGreaterThan(rootGeneration!)
      expect(() => loaderContext.ui.registerDrawerTab({ id: 'stale-after-reload', title: 'stale' })).toThrow('SPINDLE_FRONTEND_INACTIVE')
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
      await unloadFrontendExtension(extensionId)
      expect(loaderWsHandlers.size).toBe(0)
      restoreGlobalProperty('__loaderRootContext', loaderRootContextDescriptor)
      restoreGlobalProperty('__loaderMount', loaderMountDescriptor)
      restoreGlobalProperty('__loaderModal', loaderModalDescriptor)
      restoreGlobalProperty('__loaderInjection', loaderInjectionDescriptor)
    }
  })
})

type PlacementBundleHandles = {
  drawer: { root: Element; setBadge(text: string | null): void; destroy(): void }
  input: { setLabel(label: string): void; destroy(): void }
}

function placementManifest(identifier: string): SpindleManifest {
  return {
    version: '1.0.0',
    name: 'Free placement contract',
    identifier,
    author: 'test',
    github: `https://example.test/${identifier}`,
    homepage: `https://example.test/${identifier}`,
    permissions: [],
  }
}

async function loadPlacementBundle(
  extensionId: string,
  manifest: SpindleManifest,
  source: string,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalRevokeObjectURL = URL.revokeObjectURL
  globalThis.fetch = (async () => new Response(source)) as unknown as typeof fetch
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  try {
    await loadFrontendExtension(extensionId, manifest)
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
  }
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}
function restoreGlobalProperty(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  else Reflect.deleteProperty(globalThis, key)
}

describe('startup queue and force-load lifecycle', () => {
  test('replays backend and process events queued during one active bootstrap exactly once', async () => {
    const queueId = 'startup-queue-generation-contract'
    const manifest = placementManifest(queueId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, any>
    const source = `
      export function setup(context) {
        globalThis.__startupQueueEvents = { backend: [], process: [] };
        context.deferReady();
        context.onBackendMessage((payload) => {
          globalThis.__startupQueueEvents.backend.push(payload);
        });
        context.processes.register('queued-process', (process) => {
          globalThis.__startupQueueEvents.process.push(process.payload);
          process.ready();
        });
        globalThis.__startupQueueReady = () => context.ready();
      }
    `
    const originalFetch = globalThis.fetch
    const originalRevokeObjectURL = URL.revokeObjectURL
    const startupEventsDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__startupQueueEvents')
    const startupReadyDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__startupQueueReady')
    let releaseFetch!: (response: Response) => void
    let fetchStarted = false
    let fetchReleased = false
    let loadPromise: Promise<void> | undefined
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve
    })
    globalThis.fetch = (async () => {
      fetchStarted = true
      return fetchGate
    }) as unknown as typeof fetch
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })

    try {
      loadPromise = loadFrontendExtension(queueId, manifest)
      await flushMicrotasks(2)
      expect(fetchStarted).toBe(true)

      routeBackendMessage(queueId, { kind: 'queued-backend', value: 1 })
      routeFrontendProcessEvent(queueId, {
        action: 'spawn',
        processId: 'queued-process-1',
        kind: 'queued-process',
        payload: { kind: 'queued-process', value: 2 },
      })
      expect(loaderGlobals.__startupQueueEvents).toBeUndefined()

      fetchReleased = true
      releaseFetch(new Response(source))
      await loadPromise
      const loaded = getLoadedExtensions().get(queueId)
      expect(loaded?.isReady).toBe(false)
      expect(loaderGlobals.__startupQueueEvents).toEqual({ backend: [], process: [] })

      loaderGlobals.__startupQueueReady()
      await flushMicrotasks()
      expect(loaderGlobals.__startupQueueEvents).toEqual({
        backend: [{ kind: 'queued-backend', value: 1 }],
        process: [{ kind: 'queued-process', value: 2 }],
      })

      loaderGlobals.__startupQueueReady()
      await flushMicrotasks()
      expect(loaderGlobals.__startupQueueEvents).toEqual({
        backend: [{ kind: 'queued-backend', value: 1 }],
        process: [{ kind: 'queued-process', value: 2 }],
      })
    } finally {
      if (!fetchReleased) {
        fetchReleased = true
        releaseFetch(new Response(source))
      }
      if (loadPromise) await loadPromise
      await unloadFrontendExtension(queueId)
      globalThis.fetch = originalFetch
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
      restoreGlobalProperty('__startupQueueEvents', startupEventsDescriptor)
      restoreGlobalProperty('__startupQueueReady', startupReadyDescriptor)
    }
  })

  test('does not deliver late backend or process events queued after unload to a reload', async () => {
    const lateId = 'startup-queue-late-event-contract'
    const manifest = placementManifest(lateId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, any>
    const lateEventsDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__lateQueueEvents')
    const source = `
      export function setup(context) {
        context.onBackendMessage((payload) => {
          globalThis.__lateQueueEvents.backend.push(payload);
        });
        context.processes.register('late-process', (process) => {
          globalThis.__lateQueueEvents.process.push(process.payload);
          process.complete();
        });
      }
    `
    loaderGlobals.__lateQueueEvents = { backend: [], process: [] }

    try {
      await loadPlacementBundle(lateId, manifest, source)
      await unloadFrontendExtension(lateId)

      routeBackendMessage(lateId, { kind: 'late-backend' })
      routeFrontendProcessEvent(lateId, {
        action: 'spawn',
        processId: 'late-process-1',
        kind: 'late-process',
        payload: { kind: 'late-process' },
      })
      await loadPlacementBundle(lateId, manifest, source)
      await flushMicrotasks()

      expect(loaderGlobals.__lateQueueEvents).toEqual({ backend: [], process: [] })
    } finally {
      await unloadFrontendExtension(lateId)
      restoreGlobalProperty('__lateQueueEvents', lateEventsDescriptor)
    }
  })

  test('reloads a same-signature force load after unload inside the dedupe window', async () => {
    const forceId = 'force-reload-dedupe-contract'
    const manifest = placementManifest(forceId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, any>
    const forceSetupDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__forceSetupCount')
    const source = `
      export function setup() {
        globalThis.__forceSetupCount = (globalThis.__forceSetupCount || 0) + 1;
      }
    `
    const originalFetch = globalThis.fetch
    const originalRevokeObjectURL = URL.revokeObjectURL
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(source)
    }) as unknown as typeof fetch
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })

    try {
      await loadFrontendExtension(forceId, manifest, true)
      expect(fetchCalls).toBe(1)
      expect(loaderGlobals.__forceSetupCount).toBe(1)
      await unloadFrontendExtension(forceId)

      await loadFrontendExtension(forceId, manifest, true)
      expect(fetchCalls).toBe(2)
      expect(loaderGlobals.__forceSetupCount).toBe(2)
      expect(getLoadedExtensions().has(forceId)).toBe(true)
    } finally {
      await unloadFrontendExtension(forceId)
      restoreGlobalProperty('__forceSetupCount', forceSetupDescriptor)
      globalThis.fetch = originalFetch
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  test('retries a failed force load when no frontend was loaded', async () => {
    const retryId = 'force-failed-retry-contract'
    const manifest = placementManifest(retryId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, any>
    const forceRetryDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__forceRetrySetupCount')
    const source = `
      export function setup() {
        globalThis.__forceRetrySetupCount = (globalThis.__forceRetrySetupCount || 0) + 1;
      }
    `
    const originalFetch = globalThis.fetch
    const originalRevokeObjectURL = URL.revokeObjectURL
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return fetchCalls === 1 ? new Response('failed', { status: 500 }) : new Response(source)
    }) as unknown as typeof fetch
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })

    try {
      await loadFrontendExtension(retryId, manifest, true)
      expect(fetchCalls).toBe(1)
      expect(getLoadedExtensions().has(retryId)).toBe(false)

      await loadFrontendExtension(retryId, manifest, true)
      expect(fetchCalls).toBe(2)
      expect(loaderGlobals.__forceRetrySetupCount).toBe(1)
      expect(getLoadedExtensions().has(retryId)).toBe(true)
    } finally {
      await unloadFrontendExtension(retryId)
      restoreGlobalProperty('__forceRetrySetupCount', forceRetryDescriptor)
      globalThis.fetch = originalFetch
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })
})

describe('permission-free drawer and input placements', () => {
  test('registers drawer tabs and input actions when ui_panels is not granted', async () => {
    mockedGrantedPermissions = []
    const extensionId = 'free-placement-registration'
    const manifest = placementManifest(extensionId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const freePlacementDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__freePlacementHandles')
    const source = `
      export function setup(context) {
        globalThis.__freePlacementHandles = {
          drawer: context.ui.registerDrawerTab({ id: 'free-drawer', title: 'Free drawer' }),
          input: context.ui.registerInputBarAction({ id: 'free-input', label: 'Free input', enabled: true }),
        };
      }
    `

    try {
      await loadPlacementBundle(extensionId, manifest, source)
      const handles = loaderGlobals.__freePlacementHandles as PlacementBundleHandles
      expect(placementStore.getState().drawerTabs).toEqual([
        expect.objectContaining({ extensionId, title: 'Free drawer' }),
      ])
      expect(placementStore.getState().inputBarActions).toEqual([
        expect.objectContaining({ extensionId, label: 'Free input', enabled: true }),
      ])
      expect(handles.drawer.root).toBeInstanceOf(Element)
    } finally {
      await unloadFrontendExtension(extensionId)
      restoreGlobalProperty('__freePlacementHandles', freePlacementDescriptor)
    }
  })

  test('keeps drawer tabs and input actions after unrelated privileged permission revoke cleanup passes', async () => {
    mockedGrantedPermissions = ['ui_panels', 'app_manipulation']
    const extensionId = 'free-placement-revoke'
    const manifest = placementManifest(extensionId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const revokePlacementDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__revokePlacementHandles')
    const source = `
      export function setup(context) {
        globalThis.__revokePlacementHandles = {
          drawer: context.ui.registerDrawerTab({ id: 'revoke-drawer', title: 'Revoke drawer' }),
          input: context.ui.registerInputBarAction({ id: 'revoke-input', label: 'Revoke input', enabled: true }),
        };
      }
    `

    try {
      await loadPlacementBundle(extensionId, manifest, source)
      const handles = loaderGlobals.__revokePlacementHandles as PlacementBundleHandles
      expect(placementStore.getState().drawerTabs).toHaveLength(1)
      expect(placementStore.getState().inputBarActions).toHaveLength(1)

      const permissionHandlers = loaderWsHandlers.get('SPINDLE_PERMISSION_CHANGED') ?? []
      expect(permissionHandlers).toHaveLength(1)
      const permissionSets: string[][] = [['app_manipulation'], []]
      for (const allGranted of permissionSets) {
        for (const handler of permissionHandlers) {
          handler({ extensionId, allGranted })
        }

        handles.drawer.setBadge('still-present')
        handles.input.setLabel('Still present')
        expect(placementStore.getState().drawerTabs).toEqual([
          expect.objectContaining({ extensionId, title: 'Revoke drawer', badge: 'still-present' }),
        ])
        expect(placementStore.getState().inputBarActions).toEqual([
          expect.objectContaining({ extensionId, label: 'Still present' }),
        ])
      }
    } finally {
      await unloadFrontendExtension(extensionId)
      restoreGlobalProperty('__revokePlacementHandles', revokePlacementDescriptor)
    }
  })

  test('removes free placements on unload and starts a clean set on reload', async () => {
    mockedGrantedPermissions = []
    const extensionId = 'free-placement-reload'
    const manifest = placementManifest(extensionId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const reloadPlacementDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__reloadPlacementHandles')
    const source = `
      export function setup(context) {
        globalThis.__reloadPlacementHandles = {
          drawer: context.ui.registerDrawerTab({ id: 'reload-drawer', title: 'Reload drawer' }),
          input: context.ui.registerInputBarAction({ id: 'reload-input', label: 'Reload input', enabled: true }),
        };
      }
    `

    try {
      await loadPlacementBundle(extensionId, manifest, source)
      const first = loaderGlobals.__reloadPlacementHandles as PlacementBundleHandles
      const firstRoot = first.drawer.root
      expect(placementStore.getState().drawerTabs).toHaveLength(1)
      expect(placementStore.getState().inputBarActions).toHaveLength(1)

      await unloadFrontendExtension(extensionId)
      expect(placementStore.getState().drawerTabs).toHaveLength(0)
      expect(placementStore.getState().inputBarActions).toHaveLength(0)
      expect(() => first.drawer.setBadge('stale')).toThrow()
      expect(() => first.input.setLabel('stale')).toThrow()

      await loadPlacementBundle(extensionId, manifest, source)
      const second = loaderGlobals.__reloadPlacementHandles as PlacementBundleHandles
      expect(placementStore.getState().drawerTabs).toHaveLength(1)
      expect(placementStore.getState().inputBarActions).toHaveLength(1)
      expect(second.drawer.root).not.toBe(firstRoot)
      first.drawer.destroy()
      first.input.destroy()
      expect(placementStore.getState().drawerTabs).toHaveLength(1)
      expect(placementStore.getState().inputBarActions).toHaveLength(1)
    } finally {
      await unloadFrontendExtension(extensionId)
      restoreGlobalProperty('__reloadPlacementHandles', reloadPlacementDescriptor)
    }
  })

  test('keeps every privileged placement and mobility gate closed without permissions', async () => {
    mockedGrantedPermissions = []
    const extensionId = 'privileged-placement-gate'
    const manifest = placementManifest(extensionId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const privilegedDeniedDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__privilegedPlacementDenied')
    const source = `
      export function setup(context) {
        let denied = 0;
        const expectDenied = (operation) => {
          try {
            operation();
          } catch {
            denied += 1;
          }
        };
        expectDenied(() => context.ui.createFloatWidget({ initialPosition: { x: 10, y: 20 } }));
        expectDenied(() => context.ui.requestDockPanel({ title: 'Privileged dock', edge: 'left', size: 240 }));
        expectDenied(() => context.ui.mountApp());
        expectDenied(() => context.ui.registerCharacterEditorTab({ id: 'character', title: 'Character' }));
        expectDenied(() => context.ui.registerPresetEditorTab({ id: 'preset', title: 'Preset' }));
        expectDenied(() => context.ui.registerPresetEditorToolbarItem({ id: 'toolbar', ariaLabel: 'Toolbar' }));
        expectDenied(() => context.ui.requestTabLocation('profile', { kind: 'main-drawer' }));
        globalThis.__privilegedPlacementDenied = denied;
      }
    `

    try {
      await loadPlacementBundle(extensionId, manifest, source)
      expect(loaderGlobals.__privilegedPlacementDenied).toBe(7)
      expect(placementStore.getState().floatWidgets).toHaveLength(0)
      expect(placementStore.getState().dockPanels).toHaveLength(0)
      expect(placementStore.getState().appMounts).toHaveLength(0)
      expect(placementStore.getState().characterEditorTabs).toHaveLength(0)
      expect(placementStore.getState().presetEditorTabs).toHaveLength(0)
      expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(0)
    } finally {
      await unloadFrontendExtension(extensionId)
      restoreGlobalProperty('__privilegedPlacementDenied', privilegedDeniedDescriptor)
    }
  })
})

describe('tab mobility permission gate', () => {
  test('allows tab movement with app_manipulation only', async () => {
    mockedGrantedPermissions = ['app_manipulation']
    const extensionId = 'mobility-app-manipulation'
    const manifest = placementManifest(extensionId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const mobilityDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__appMobilityTab')
    const source = `
      export function setup(context) {
        const tab = context.ui.registerDrawerTab({ id: 'mobility', title: 'Mobility' });
        globalThis.__appMobilityTab = tab.tabId;
        context.ui.requestTabLocation(tab.tabId, { kind: 'container', containerId: 'app-container' });
      }
    `

    try {
      await loadPlacementBundle(extensionId, manifest, source)
      const tabId = loaderGlobals.__appMobilityTab as string
      expect(placementStore.getState().tabLocations[tabId]).toEqual({
        kind: 'container',
        containerId: 'app-container',
      })
    } finally {
      await unloadFrontendExtension(extensionId)
      restoreGlobalProperty('__appMobilityTab', mobilityDescriptor)
    }
  })

  test('allows tab movement with ui_panels only', async () => {
    mockedGrantedPermissions = ['ui_panels']
    const extensionId = 'mobility-ui-panels'
    const manifest = placementManifest(extensionId)
    const loaderGlobals = globalThis as typeof globalThis & Record<string, unknown>
    const mobilityDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__uiPanelsMobilityTab')
    const source = `
      export function setup(context) {
        const tab = context.ui.registerDrawerTab({ id: 'mobility', title: 'Mobility' });
        globalThis.__uiPanelsMobilityTab = tab.tabId;
        context.ui.requestTabLocation(tab.tabId, { kind: 'container', containerId: 'panels-container' });
      }
    `

    try {
      await loadPlacementBundle(extensionId, manifest, source)
      const tabId = loaderGlobals.__uiPanelsMobilityTab as string
      expect(placementStore.getState().tabLocations[tabId]).toEqual({
        kind: 'container',
        containerId: 'panels-container',
      })
    } finally {
      await unloadFrontendExtension(extensionId)
      restoreGlobalProperty('__uiPanelsMobilityTab', mobilityDescriptor)
    }
  })
})

describe('public root producers', () => {
  test('stamps every placement root with its permission and loader generation', () => {
    const drawer = createDrawerTabHandle(extensionId, { id: 'drawer', title: 'Drawer' }, () => {}, generation)
    const character = createCharacterEditorTabHandle(extensionId, { id: 'character', title: 'Character' }, () => {}, generation)
    const preset = createPresetEditorTabHandle(extensionId, { id: 'preset', title: 'Preset' }, () => {}, generation)
    const toolbar = createPresetEditorToolbarItemHandle(extensionId, { id: 'toolbar', ariaLabel: 'Toolbar' }, () => {}, generation)
    const float = createFloatWidgetHandle(extensionId, { initialPosition: { x: 1, y: 2 } }, () => {}, generation)
    const dock = createDockPanelHandle(extensionId, { title: 'Dock', edge: 'left', size: 240 }, () => {}, generation)
    const app = createAppMountHandle(extensionId, { position: 'app-overlay' }, () => {}, generation)
    const action = createInputBarActionHandle(extensionId, 'Lifecycle', { id: 'input', label: 'Input' }, () => {}, generation)
    const roots = [
      [placementStore.getState().drawerTabs[0]?.root, null],
      [placementStore.getState().characterEditorTabs[0]?.root, 'characters'],
      [placementStore.getState().presetEditorTabs[0]?.root, 'presets'],
      [placementStore.getState().presetEditorToolbarItems[0]?.root, 'presets'],
      [placementStore.getState().floatWidgets[0]?.root, 'ui_panels'],
      [placementStore.getState().dockPanels[0]?.root, 'ui_panels'],
      [placementStore.getState().appMounts[0]?.root, 'app_manipulation'],
    ] as const

    for (const [root, permission] of roots) {
      expect(root).toBeInstanceOf(Element)
      expect(getLiveRootRecordExact(extensionId, root!, generation)).toMatchObject({
        permission,
        generation,
      })
    }
    expect(action.actionId).toContain('input')
    expect(placementStore.getState().inputBarActions).toHaveLength(1)

    drawer.destroy(); character.destroy(); preset.destroy(); toolbar.destroy(); float.destroy(); dock.destroy(); app.destroy(); action.destroy()
    expect(placementStore.getState().drawerTabs).toHaveLength(0)
    expect(placementStore.getState().characterEditorTabs).toHaveLength(0)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(0)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(0)
    expect(placementStore.getState().floatWidgets).toHaveLength(0)
    expect(placementStore.getState().dockPanels).toHaveLength(0)
    expect(placementStore.getState().appMounts).toHaveLength(0)
    expect(placementStore.getState().inputBarActions).toHaveLength(0)
  })

  test('inject and mount roots carry generation metadata and stale factories cannot register', () => {
    let active = true
    const domHelper = createDOMHelper(extensionId, undefined, undefined, () => {
      if (!active) throw new Error('SPINDLE_FRONTEND_INACTIVE')
    }, generation)
    const target = document.createElement('section')
    target.id = 'injection-target'
    document.body.append(target)
    const injected = domHelper.inject(target, '<button id="injected">safe</button>')
    expect(getLiveRootRecordExact(extensionId, injected, generation)).toMatchObject({ permission: null, generation })

    const oldComponents = createComponentsHelper(extensionId, extensionId, async () => ({ categories: [] }), generation)
    const oldUI = createUIEventsHelper(extensionId, () => {
      if (!active) throw new Error('SPINDLE_FRONTEND_INACTIVE')
    }, generation)
    createComponentsHelper(extensionId, extensionId, async () => ({ categories: [] }), nextGeneration)
    active = false
    expect(() => oldComponents.mountTextInput(injected, { value: 'stale' })).toThrow(/generation|registered placement/)
    expect(() => oldUI.bindActionHandlers(injected, { click: () => {} })).toThrow(/target must be inside|generation|INACTIVE/)
    domHelper.uninject(injected)
    expect(() => domHelper.inject(target, '<b>stale</b>')).toThrow('SPINDLE_FRONTEND_INACTIVE')
    expect(getLiveRootRecordExact(extensionId, injected, generation)).toBeNull()
    domHelper.cleanup()
  })
})

describe('permission-scoped component and action lifecycle', () => {
  test('component inherits root permission and only matching revocation destroys it', () => {
    const panelsRoot = document.createElement('section')
    const charactersRoot = document.createElement('section')
    panelsRoot.setAttribute('data-spindle-extension-root', extensionId)
    charactersRoot.setAttribute('data-spindle-extension-root', extensionId)
    panelsRoot.id = 'panels-root'
    charactersRoot.id = 'characters-root'
    document.body.append(panelsRoot, charactersRoot)
    registerLiveRoot(extensionId, panelsRoot, 'ui_panels', generation)
    registerLiveRoot(extensionId, charactersRoot, 'characters', generation)
    const helper = createComponentsHelper(extensionId, extensionId, async () => ({ categories: [] }), generation)
    const panelHandle = helper.mountTextInput(panelsRoot, { value: 'panel' })
    const characterHandle = helper.mountTextInput(charactersRoot, { value: 'character' })

    destroyComponentsForExtensionPermission(extensionId, 'ui_panels')
    expect(() => panelHandle.getValue()).toThrow('COMPONENT_DESTROYED')
    expect(characterHandle.getValue()).toBe('character')
    expect(() => characterHandle.update({ value: 'updated' })).not.toThrow()

    destroyComponentsForExtensionPermission(extensionId, 'characters')
    expect(() => characterHandle.getValue()).toThrow('COMPONENT_DESTROYED')
  })

  test('action listeners are removed on root teardown and unrelated roots survive', () => {
    const panelsRoot = document.createElement('section')
    const presetsRoot = document.createElement('section')
    const panelAction = document.createElement('button')
    const presetAction = document.createElement('button')
    panelsRoot.append(panelAction)
    presetsRoot.append(presetAction)
    document.body.append(panelsRoot, presetsRoot)
    panelAction.id = 'panels'
    presetAction.id = 'presets'
    panelsRoot.setAttribute('data-spindle-extension-root', extensionId)
    presetsRoot.setAttribute('data-spindle-extension-root', extensionId)
    registerLiveRoot(extensionId, panelsRoot, 'ui_panels', generation)
    registerLiveRoot(extensionId, presetsRoot, 'presets', generation)
    const received: string[] = []
    const helper = createUIEventsHelper(extensionId, () => {}, generation)
    const unbindPanels = helper.bindActionHandlers(panelsRoot, { panels: () => received.push('panels') })
    const unbindPresets = helper.bindActionHandlers(presetsRoot, { presets: () => received.push('presets') })

    panelAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    presetAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual(['panels', 'presets'])
    destroyUIEventBindingsForExtensionPermission(extensionId, 'ui_panels')
    panelAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    presetAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual(['panels', 'presets', 'presets'])

    destroyUIEventBindingsForExtensionPermission(extensionId, 'presets')
    panelAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    presetAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual(['panels', 'presets', 'presets'])
    destroyAllUIEventBindingsForExtension(extensionId)
    unbindPanels(); unbindPanels(); unbindPresets(); unbindPresets()
  })

  test('repeated root and permission teardown is idempotent and removes all placement state', () => {
    const handle = createDrawerTabHandle(extensionId, { id: 'revoke', title: 'Revoke' }, () => {}, generation)
    const root = placementStore.getState().drawerTabs[0]!.root
    expect(getLiveRootRecordExact(extensionId, root, generation)).not.toBeNull()

    destroyPlacementsForExtensionPermission(extensionId, 'ui_panels')
    destroyPlacementsForExtensionPermission(extensionId, 'ui_panels')
    destroyAllPlacementsForExtension(extensionId)
    destroyAllPlacementsForExtension(extensionId)
    expect(placementStore.getState().drawerTabs).toHaveLength(0)
    expect(getLiveRootRecordExact(extensionId, root, generation)).toBeNull()
    expect(() => handle.destroy()).not.toThrow()
  })
})

describe('generation rollover', () => {
  test('old generation rejects placement, UI, and root subscriptions after rollover and unload cleanup', () => {
    const root = document.createElement('section')
    root.id = 'generation-root'
    root.setAttribute('data-spindle-extension-root', extensionId)
    document.body.append(root)
    registerLiveRoot(extensionId, root, 'ui_panels', nextGeneration)
    let oldActive = true
    const oldGuard = () => {
      if (!oldActive) throw new Error('SPINDLE_FRONTEND_INACTIVE')
    }
    const rootNotifications: string[] = []
    const unsubscribeRoot = subscribeLiveRoot(root, () => rootNotifications.push('unregistered'))
    const oldComponents = createComponentsHelper(extensionId, extensionId, async () => ({ categories: [] }), generation)
    const oldEvents = createUIEventsHelper(extensionId, oldGuard, generation)
    expect(() => oldComponents.mountTextInput(root, { value: 'old' })).toThrow(/generation|registered placement/)
    expect(() => oldEvents.bindActionHandlers(root, { click: () => {} })).toThrow(/target must be inside|generation/)
    oldActive = false
    expect(() => createDrawerTabHandle(extensionId, { id: 'stale', title: 'stale' }, oldGuard, generation)).toThrow('SPINDLE_FRONTEND_INACTIVE')
    expect(getLiveRootRecord(extensionId, root, generation)).toBeNull()
    expect(getLiveRootRecord(extensionId, root, nextGeneration)?.permission).toBe('ui_panels')

    clearLiveRootsForExtension(extensionId)
    expect(rootNotifications).toEqual(['unregistered'])
    expect(getLiveRootRecordExact(extensionId, root, nextGeneration)).toBeNull()
    unsubscribeRoot()
    unsubscribeRoot()
  })
})
describe('retained non-UI context lifecycle', () => {
  test('rejects every retained generation-A capability after unload/reload without host side effects', async () => {
    const retainedId = 'retained-context-contract'
    const manifest: SpindleManifest = {
      version: '1.0.0',
      name: 'Retained context contract',
      identifier: retainedId,
      author: 'test',
      github: `https://example.test/${retainedId}`,
      homepage: `https://example.test/${retainedId}`,
      permissions: ['characters', 'ui_panels', 'app_manipulation', 'presets', 'unsafe_eval'],
    }
    const source = `
      export function setup(context) {
        globalThis.__retainedContext = context;
      }
    `
    const loaderGlobals = globalThis as typeof globalThis & Record<string, any>
    const retainedContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__retainedContext')
    try {
      await loadPlacementBundle(retainedId, manifest, source)
      const firstContext = loaderGlobals.__retainedContext
      expect(firstContext).toBeDefined()
      await unloadFrontendExtension(retainedId)
      await loadPlacementBundle(retainedId, manifest, source)
      expect(loaderGlobals.__retainedContext).not.toBe(firstContext)

      const staleSyncCalls: Array<[string, () => unknown]> = [
        ['events.on', () => firstContext.events.on('stale', () => {})],
        ['events.emit', () => firstContext.events.emit('stale', {})],
        ['dom.inject', () => firstContext.dom.inject(document.body, '<b>stale</b>')],
        ['dom.addStyle', () => firstContext.dom.addStyle('body { color: red }')],
        ['ui.mount', () => firstContext.ui.mount('sidebar')],
        ['ui.registerDrawerTab', () => firstContext.ui.registerDrawerTab({ id: 'stale', title: 'stale' })],
        ['ui.registerCharacterEditorTab', () => firstContext.ui.registerCharacterEditorTab({ id: 'stale-character', title: 'stale' })],
        ['ui.registerPresetEditorTab', () => firstContext.ui.registerPresetEditorTab({ id: 'stale-preset', title: 'stale' })],
        ['ui.registerPresetEditorToolbarItem', () => firstContext.ui.registerPresetEditorToolbarItem({ id: 'stale-toolbar', ariaLabel: 'stale' })],
        ['ui.createFloatWidget', () => firstContext.ui.createFloatWidget()],
        ['ui.requestDockPanel', () => firstContext.ui.requestDockPanel({ title: 'stale', edge: 'left', size: 200 })],
        ['ui.mountApp', () => firstContext.ui.mountApp()],
        ['ui.registerInputBarAction', () => firstContext.ui.registerInputBarAction({ id: 'stale', label: 'stale', enabled: true })],
        ['ui.requestTabLocation', () => firstContext.ui.requestTabLocation('stale', { kind: 'main-drawer' })],
        ['ui.getBuiltInTabRoot', () => firstContext.ui.getBuiltInTabRoot('stale')],
        ['ui.getBuiltInTabTitle', () => firstContext.ui.getBuiltInTabTitle('stale')],
        ['ui.getTabLocation', () => firstContext.ui.getTabLocation('stale')],
        ['ui.showModal', () => firstContext.ui.showModal({ title: 'stale', persistent: true })],
        ['ui.events.onKeyboardChange', () => firstContext.ui.events.onKeyboardChange(() => {})],
        ['sendToBackend', () => firstContext.sendToBackend({ stale: true })],
        ['onBackendMessage', () => firstContext.onBackendMessage(() => {})],
        ['processes.register', () => firstContext.processes.register('stale', () => {})],
        ['messages.registerTagInterceptor', () => firstContext.messages.registerTagInterceptor({ tag: 'stale' }, () => {})],
        ['messages.renderWidget', () => firstContext.messages.renderWidget({ messageId: 'm', widgetId: 'w', html: '<b>stale</b>' })],
        ['messages.removeWidget', () => firstContext.messages.removeWidget('m', 'w')],
        ['messages.getLatestMessageId', () => firstContext.messages.getLatestMessageId()],
        ['messages.getMessageIdAtIndex', () => firstContext.messages.getMessageIdAtIndex(0)],
        ['messages.listMessageIds', () => firstContext.messages.listMessageIds()],
        ['display.registerResolver', () => firstContext.display.registerResolver({ resolveTemplates: async () => null, applyScripts: async () => null })],
        ['display.invalidate', () => firstContext.display.invalidate(['stale'])],
        ['containers.registerContainer', () => firstContext.containers.registerContainer({ id: 'stale', side: 'left', element: document.createElement('div') })],
        ['containers.unregisterContainer', () => firstContext.containers.unregisterContainer('stale')],
        ['getActiveChat', () => firstContext.getActiveChat()],
        ['ready', () => firstContext.ready()],
        ['getState', () => firstContext.ui.characterEditor.getState()],
        ['onChange', () => firstContext.ui.characterEditor.onChange(() => {})],
        ['setExtensions', () => firstContext.ui.characterEditor.setExtensions({ stale: true })],
        ['updateExtensions', () => firstContext.ui.characterEditor.updateExtensions(() => ({ stale: true }))],
        ['flush', () => firstContext.ui.characterEditor.flush()],
        ['components.mountTextInput', () => firstContext.components.mountTextInput(document.body, { value: 'stale' })],
        ['uploads.pickFile', () => firstContext.uploads.pickFile()],
        ['permissions.getGranted', () => firstContext.permissions.getGranted()],
        ['permissions.request', () => firstContext.permissions.request(['ui_panels'])],
        ['characters.get', () => firstContext.characters.get('stale')],
        ['chats.updateMessage', () => firstContext.chats.updateMessage('chat', 'message', { content: 'stale' })],
      ]
      const beforeSends = loaderWsSends.length
      const beforePermissionCalls = permissionApiCalls
      const beforeCharacterCalls = characterApiCalls
      const beforeChatCalls = chatApiCalls
      const beforeRegistrations = { tag: tagRegistrations, display: displayRegistrations, widget: widgetRegistrations }
      const beforeWsHandlers = [...loaderWsHandlers.entries()].map(([event, handlers]) => [event, handlers.size])
      const beforePlacement = [
        placementStore.getState().drawerTabs.length,
        placementStore.getState().characterEditorTabs.length,
        placementStore.getState().presetEditorTabs.length,
        placementStore.getState().presetEditorToolbarItems.length,
        placementStore.getState().floatWidgets.length,
        placementStore.getState().dockPanels.length,
        placementStore.getState().appMounts.length,
        placementStore.getState().inputBarActions.length,
        placementStore.getState().extensionCommands.length,
      ]
      const beforeRoots = document.querySelectorAll('[data-spindle-extension-root], [data-spindle-ext]').length
      for (const [name, call] of staleSyncCalls) {
        await expect(Promise.resolve().then(call), name).rejects.toThrow(/SPINDLE_FRONTEND_INACTIVE|generation is no longer active/)
      }
      expect(loaderWsSends.length).toBe(beforeSends)
      expect(permissionApiCalls).toBe(beforePermissionCalls)
      expect(characterApiCalls).toBe(beforeCharacterCalls)
      expect(chatApiCalls).toBe(beforeChatCalls)
      expect({ tag: tagRegistrations, display: displayRegistrations, widget: widgetRegistrations }).toEqual(beforeRegistrations)
      expect([...loaderWsHandlers.entries()].map(([event, handlers]) => [event, handlers.size])).toEqual(beforeWsHandlers)
      expect([
        placementStore.getState().drawerTabs.length,
        placementStore.getState().characterEditorTabs.length,
        placementStore.getState().presetEditorTabs.length,
        placementStore.getState().presetEditorToolbarItems.length,
        placementStore.getState().floatWidgets.length,
        placementStore.getState().dockPanels.length,
        placementStore.getState().appMounts.length,
        placementStore.getState().inputBarActions.length,
        placementStore.getState().extensionCommands.length,
      ]).toEqual(beforePlacement)
      expect(document.querySelectorAll('[data-spindle-extension-root], [data-spindle-ext]').length).toBe(beforeRoots)
    } finally {
      await unloadFrontendExtension(retainedId)
      restoreGlobalProperty('__retainedContext', retainedContextDescriptor)
    }
  })

  test('settles overlapping showConfirm requests independently and releases modal capacity', async () => {
    const confirmId = 'overlapping-confirm-contract'
    const manifest = placementManifest(confirmId)
    const source = `
      export function setup(context) {
        globalThis.__confirmContext = context;
        globalThis.__confirmCalls = [
          context.ui.showConfirm({ title: 'First confirm', message: 'first' }),
          context.ui.showConfirm({ title: 'Second confirm', message: 'second' }),
        ];
      }
    `
    type ConfirmContext = {
      ui: {
        showConfirm(options: { title: string; message: string }): Promise<{ confirmed: boolean }>
      }
    }
    type ConfirmGlobals = typeof globalThis & {
      __confirmContext?: ConfirmContext
      __confirmCalls?: [Promise<{ confirmed: boolean }>, Promise<{ confirmed: boolean }>]
    }
    const loaderGlobals = globalThis as ConfirmGlobals
    const confirmContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__confirmContext')
    const confirmCallsDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__confirmCalls')
    let thirdPromise: Promise<{ confirmed: boolean }> | undefined
    const confirmSendsStart = loaderWsSends.length
    try {
      try {
      await loadPlacementBundle(confirmId, manifest, source)
      const context = loaderGlobals.__confirmContext
      const calls = loaderGlobals.__confirmCalls
      if (!context || !calls) throw new Error('Confirm fixture did not initialize')
      expect(confirmRequests).toHaveLength(2)
      const [firstRequest, secondRequest] = confirmRequests
      expect(useStoreMock.getState().pendingConfirm).toEqual(secondRequest)

      await expect(calls[0]).resolves.toEqual({ confirmed: false })
      expect(useStoreMock.getState().pendingConfirm).toEqual(secondRequest)
      expect(loaderWsSends.slice(confirmSendsStart)).toEqual([
        { type: 'SPINDLE_CONFIRM_RESULT', requestId: firstRequest.requestId, confirmed: false },
      ])

      useStoreMock.getState().closeSpindleConfirm(firstRequest.requestId, true)
      expect(useStoreMock.getState().pendingConfirm).toEqual(secondRequest)
      expect(loaderWsSends.slice(confirmSendsStart)).toEqual([
        { type: 'SPINDLE_CONFIRM_RESULT', requestId: firstRequest.requestId, confirmed: false },
      ])
      expect(confirmWindowListeners.size).toBe(1)

      useStoreMock.getState().closeSpindleConfirm(secondRequest.requestId, true)
      await expect(calls[1]).resolves.toEqual({ confirmed: true })
      expect(useStoreMock.getState().pendingConfirm).toBeNull()
      expect(loaderWsSends.slice(confirmSendsStart)).toEqual([
        { type: 'SPINDLE_CONFIRM_RESULT', requestId: firstRequest.requestId, confirmed: false },
        { type: 'SPINDLE_CONFIRM_RESULT', requestId: secondRequest.requestId, confirmed: true },
      ])
      thirdPromise = context.ui.showConfirm({ title: 'Third confirm', message: 'third' })
      const thirdRequest = confirmRequests[2]
      if (!thirdRequest) throw new Error('Third confirm request was not opened')
      expect(useStoreMock.getState().pendingConfirm).toEqual(thirdRequest)
      expect(confirmWindowListeners.size).toBe(1)
      await unloadFrontendExtension(confirmId)
      await expect(thirdPromise).resolves.toEqual({ confirmed: false })
      expect(useStoreMock.getState().pendingConfirm).toBeNull()
      expect(confirmWindowListeners.size).toBe(0)
      } finally {
        try {
          await unloadFrontendExtension(confirmId)
        } finally {
          if (thirdPromise) await thirdPromise
        }
      }
    } finally {
      restoreGlobalProperty('__confirmContext', confirmContextDescriptor)
      restoreGlobalProperty('__confirmCalls', confirmCallsDescriptor)
      expect(Object.getOwnPropertyDescriptor(globalThis, '__confirmContext')).toEqual(confirmContextDescriptor)
      expect(Object.getOwnPropertyDescriptor(globalThis, '__confirmCalls')).toEqual(confirmCallsDescriptor)
    }
  })

  test('drains character onChange subscriptions on revoke/unload and regrants a fresh listener', async () => {
    const characterId = 'character-subscription-contract'
    mockedGrantedPermissions = ['characters']
    const manifest: SpindleManifest = { ...placementManifest(characterId), permissions: ['characters'] }
    const source = `
      export function setup(context) {
        globalThis.__characterContext = context;
        globalThis.__characterCalls = 0;
        globalThis.__characterUnsubs = [
          context.ui.characterEditor.onChange(() => { globalThis.__characterCalls += 1; }),
          context.ui.characterEditor.onChange(() => { globalThis.__characterCalls += 1; }),
        ];
      }
    `
    const loaderGlobals = globalThis as typeof globalThis & Record<string, any>
    let freshUnsub: () => void = () => {}
    try {
      await loadPlacementBundle(characterId, manifest, source)
      const context = loaderGlobals.__characterContext
      const firstUnsub = loaderGlobals.__characterUnsubs[0]
      const secondUnsub = loaderGlobals.__characterUnsubs[1]
      expect(characterListeners.size).toBe(2)
      for (const handler of characterListeners) handler({})
      expect(loaderGlobals.__characterCalls).toBe(2)
      firstUnsub()
      firstUnsub()
      expect(characterListeners.size).toBe(1)

      const permissionHandlers = loaderWsHandlers.get('SPINDLE_PERMISSION_CHANGED') ?? new Set()
      for (const handler of permissionHandlers) handler({ extensionId: characterId, allGranted: [] })
      expect(characterListeners.size).toBe(0)
      const callsAfterRevoke = loaderGlobals.__characterCalls
      for (const handler of characterListeners) handler({})
      expect(loaderGlobals.__characterCalls).toBe(callsAfterRevoke)
      expect(() => secondUnsub()).not.toThrow()
      expect(() => secondUnsub()).not.toThrow()

      for (const handler of loaderWsHandlers.get('SPINDLE_PERMISSION_CHANGED') ?? []) {
        handler({ extensionId: characterId, allGranted: ['characters'] })
      }
      freshUnsub = context.ui.characterEditor.onChange(() => { loaderGlobals.__characterCalls += 1 })
      expect(characterListeners.size).toBe(1)
      for (const handler of characterListeners) handler({})
      expect(loaderGlobals.__characterCalls).toBe(3)
    } finally {
      const callsBeforeUnload = loaderGlobals.__characterCalls
      await unloadFrontendExtension(characterId)
      expect(characterListeners.size).toBe(0)
      for (const handler of characterListeners) handler({})
      expect(loaderGlobals.__characterCalls).toBe(callsBeforeUnload)
      expect(() => freshUnsub()).not.toThrow()
      expect(() => freshUnsub()).not.toThrow()
      loaderGlobals.__characterContext = undefined
      loaderGlobals.__characterUnsubs = undefined
      loaderGlobals.__characterCalls = undefined
    }
  })
})
