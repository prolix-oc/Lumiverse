import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { SpindleManifest, SpindleHostDescriptorV1 } from 'lumiverse-spindle-types'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSpindleHostDescriptor, digestSpindleHostDescriptor } from './host-compatibility'

type FakeRoot = {
  parentElement: object | null
  removed: boolean
  setAttribute(name: string, value: string): void
  replaceChildren(): void
  remove(): void
}

type PermissionResult = { granted: string[] }
type LifecycleGlobals = typeof globalThis & Record<string, unknown>
type WindowListenerOptions = boolean | AddEventListenerOptions | undefined
type TrackedWindowHandler = {
  listener: EventListenerOrEventListenerObject
  options: WindowListenerOptions
}

const lifecycleGlobals = globalThis as LifecycleGlobals
const removedRoots: FakeRoot[] = []
const wsHandlers = new Map<string, Set<(payload: unknown) => void>>()
const windowHandlers = new Map<string, Set<TrackedWindowHandler>>()
const placementDestroyCalls: string[] = []
const uiEventDestroyAllCalls: string[] = []
const uiEventDestroyPermissionCalls: Array<{ extensionId: string; permission: string }> = []
let permissionPromise: Promise<PermissionResult> = Promise.resolve({ granted: [] })
let uuidSequence = 0
const macroCatalogMessages: unknown[] = []
const frontendProcessEvents: unknown[] = []
let objectUrlSequence = 0
const moduleDirectory = mkdtempSync(join(import.meta.dir, '.loader-lifecycle-'))
let accessCreations = 0
const presetEditorSubscribers = new Set<(state: unknown) => void>()
let presetEditorUnderlyingUnsubscribeCalls = 0
function publishPresetEditorChange(): void {
  for (const subscriber of [...presetEditorSubscribers]) subscriber({ revision: 1 })
}

function subscribePresetEditorState(handler: (state: unknown) => void): () => void {
  presetEditorSubscribers.add(handler)
  let active = true
  return () => {
    presetEditorUnderlyingUnsubscribeCalls += 1
    lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls = presetEditorUnderlyingUnsubscribeCalls
    if (!active) return
    active = false
    presetEditorSubscribers.delete(handler)
  }
}
lifecycleGlobals.__publishPresetEditorChange = publishPresetEditorChange
lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls = 0
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
  fetch: globalThis.fetch,
}
const originalGlobalDescriptors = new Map<string, PropertyDescriptor | undefined>(
  ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MutationObserver', 'fetch']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
)
const originalUrlDescriptors = new Map<string, PropertyDescriptor | undefined>(
  ['createObjectURL', 'revokeObjectURL']
    .map((key) => [key, Object.getOwnPropertyDescriptor(URL, key)]),
)
const windowMock = dom.window
const nativeWindowAddEventListener = windowMock.addEventListener.bind(windowMock)
const nativeWindowRemoveEventListener = windowMock.removeEventListener.bind(windowMock)
let trackWindowHandlers = false
const documentMock = dom.window.document
windowMock.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: WindowListenerOptions) => {
  nativeWindowAddEventListener(type, listener, options)
  if (!trackWindowHandlers || !type.startsWith('spindle:')) return
  const handlers = windowHandlers.get(type) ?? new Set<TrackedWindowHandler>()
  handlers.add({ listener, options })
  windowHandlers.set(type, handlers)
}) as typeof windowMock.addEventListener
windowMock.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: WindowListenerOptions) => {
  nativeWindowRemoveEventListener(type, listener, options)
  if (!trackWindowHandlers || !type.startsWith('spindle:')) return
  const handlers = windowHandlers.get(type)
  if (!handlers) return
  const capture = typeof options === 'boolean' ? options : options?.capture ?? false
  for (const handler of handlers) {
    const handlerCapture = typeof handler.options === 'boolean' ? handler.options : handler.options?.capture ?? false
    if (handler.listener === listener && handlerCapture === capture) handlers.delete(handler)
  }
  if (handlers.size === 0) windowHandlers.delete(type)
}) as typeof windowMock.removeEventListener
const nativeCreateElement = documentMock.createElement.bind(documentMock)
documentMock.createElement = ((tagName: string, options?: ElementCreationOptions) => {
  const root = nativeCreateElement(tagName, options)
  const trackedRoot = root as unknown as FakeRoot & { removed: boolean }
  trackedRoot.removed = false
  const nativeRemove = root.remove.bind(root)
  root.remove = () => {
    trackedRoot.removed = true
    nativeRemove()
  }
  removedRoots.push(trackedRoot)
  return root
}) as typeof documentMock.createElement
const warmupRoot = documentMock.createElement('div')
documentMock.body.appendChild(warmupRoot)
warmupRoot.remove()

Object.assign(globalThis, {
  window: windowMock,
  document: documentMock,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
})
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: () => {
    objectUrlSequence += 1
    const source = String(lifecycleGlobals.__lifecycleModuleSource ?? '')
    const modulePath = join(moduleDirectory, `frontend-${objectUrlSequence}.mjs`)
    writeFileSync(modulePath, source)
    return pathToFileURL(modulePath).href
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
  send(payload: unknown) {
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'type' in payload &&
      payload.type === 'SPINDLE_FRONTEND_PROCESS_EVENT'
    ) {
      frontendProcessEvents.push(payload)
    }
    macroCatalogMessages.push(payload)
  },
}
function dispatchWs(event: string, payload: unknown): void {
  const routedPayload = payload !== null
    && typeof payload === 'object'
    && 'extensionId' in payload
    && typeof payload.extensionId === 'string'
    ? { ...payload, extensionId: canonicalInstallationId(payload.extensionId) }
    : payload
  for (const handler of wsHandlers.get(`ws:${event}`) ?? []) handler(routedPayload)
}
function dispatchWindow(event: string, detail: unknown): void {
  windowMock.dispatchEvent(new windowMock.CustomEvent(event, { detail }))
}

const presetAccessMock = {
  createPresetEditorAccess: (
    _extensionIdentifier: string,
    getGrantedPermissions: () => readonly string[],
    trackSubscription: (unsubscribe: () => void) => () => void,
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
          onChange(handler: (state: unknown) => void) {
            if (disposed) throw new Error('PRESET_EDITOR_DISPOSED')
            if (!getGrantedPermissions().includes('presets')) throw new Error('PERMISSION_DENIED:presets')
            return trackSubscription(subscribePresetEditorState(handler))
          },
        }
      },
      dispose() {
        disposed = true
      },
    }
  },
}

const SUPPORTED_LUMIVERSE_VERSION = '1.0.8'
const CANONICAL_INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const installationIds = new Map<string, string>()
function canonicalInstallationId(label: string): string {
  if (CANONICAL_INSTALLATION_ID.test(label)) return label
  const cached = installationIds.get(label)
  if (cached) return cached
  const words = [0, 1, 2, 3].map((seed) => {
    let hash = (2166136261 ^ (seed * 0x9e3779b9)) >>> 0
    for (let index = 0; index < label.length; index += 1) {
      hash = Math.imul(hash ^ label.charCodeAt(index), 16777619) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  })
  const raw = words.join('')
  const id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}`
  installationIds.set(label, id)
  return id
}
function lifecycleHostDescriptor(extensionId: string): SpindleHostDescriptorV1 {
  return createSpindleHostDescriptor(canonicalInstallationId(extensionId), SUPPORTED_LUMIVERSE_VERSION)
}
lifecycleGlobals.__APP_VERSION__ = SUPPORTED_LUMIVERSE_VERSION

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/ws/client', () => ({ wsClient: wsClientMock }))
mock.module('@/api/spindle', () => ({
  spindleApi: {
    getPermissions: () => permissionPromise,
    compatibilityHandshake: async (extensionId: string, nonce: string) => {
      const descriptor = lifecycleHostDescriptor(extensionId)
      return { nonce, descriptor, digest: await digestSpindleHostDescriptor(descriptor) }
    },
  },
}))
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
  destroyPlacementsForExtensionPermission(extensionId: string, permission: string) {
    placementDestroyCalls.push(`${permission}:${extensionId}`)
  },
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
mock.module('./components-helper', () => ({
  createComponentsHelper: (_extensionId: string, _identifier: string, getCatalog: () => Promise<unknown>) => {
    lifecycleGlobals.__catalogProvider = getCatalog
    return {}
  },
  destroyAllComponentsForExtension() {},
  destroyComponentsForTarget() {},
  destroyComponentsForExtensionPermission() {},
}))
mock.module('@/lib/uuid', () => ({
  generateUUID: () => {
    uuidSequence += 1
    return uuidSequence === 1 ? 'request-id' : `request-id-${uuidSequence}`
  },
}))
mock.module('./navigation-guards', () => ({ installSpindleNavigationGuards() {} }))
mock.module('@/lib/drawer-tab-registry', () => ({ DRAWER_TABS: [], ensureRegistryRoot: () => undefined }))
mock.module('./ui-events-helper', () => ({
  createUIEventsHelper: () => ({}),
  destroyAllUIEventBindingsForExtension(extensionId: string) {
    uiEventDestroyAllCalls.push(extensionId)
  },
  destroyUIEventBindingsForExtensionPermission(extensionId: string, permission: string) {
    uiEventDestroyPermissionCalls.push({ extensionId, permission })
  },
}))
mock.module('./browser-scheduler', () => ({ yieldToBrowser: async () => {} }))

const lifecycleModuleSource = `
  export function teardown() {
    globalThis["__lifecycleTeardownCalls"] = Number(globalThis["__lifecycleTeardownCalls"] || 0) + 1;
  }
  export function setup(context) {
    globalThis["__lifecycleContext"] = context;
    if (globalThis["__lifecycleRegisterPresetEditor"]) globalThis["__lifecycleRegisterPresetEditor"](context);
    if (globalThis["__lifecycleRegisterProcess"]) globalThis["__lifecycleRegisterProcess"](context);
    if (globalThis["__lifecycleExerciseSetup"]) globalThis["__lifecycleExerciseSetup"](context);
    if (globalThis["__lifecycleRequestCatalog"]) {
      const provider = globalThis["__catalogProvider"];
      globalThis["__catalogPromise"] = provider();
    }
    if (globalThis["__lifecycleMount"]) context["ui"]["mount"]('main');
    const result = globalThis["__lifecycleSetupResult"];
    if (globalThis["__lifecycleReturnStaticTeardown"] && result && typeof result["then"] === 'function') {
      return result["then"](() => teardown);
    }
    if (globalThis["__lifecycleThrowSetup"]) throw new Error("sync setup failure");
    return result;
  }
`
lifecycleGlobals.__lifecycleModuleSource = lifecycleModuleSource

globalThis.fetch = (async () => new Response(lifecycleModuleSource)) as unknown as typeof fetch



const {
  getLoadedExtensions,
  loadFrontendExtension: loadRawFrontendExtension,
  unloadFrontendExtension: unloadRawFrontendExtension,
  routeBackendMessage: routeBackendMessageRaw,
  routeFrontendProcessEvent: routeFrontendProcessEventRaw,
} = await import('./loader')
async function loadFrontendExtension(extensionId: string, extensionManifest: SpindleManifest, force = false): Promise<void> {
  return loadRawFrontendExtension(canonicalInstallationId(extensionId), extensionManifest, force)
}
async function unloadFrontendExtension(extensionId: string, options: { invalidateGeneration?: boolean } = {}): Promise<void> {
  return unloadRawFrontendExtension(canonicalInstallationId(extensionId), options)
}
function routeBackendMessage(extensionId: string, payload: unknown): void {
  routeBackendMessageRaw(canonicalInstallationId(extensionId), payload)
}
function routeFrontendProcessEvent(extensionId: string, payload: Parameters<typeof routeFrontendProcessEventRaw>[1]): void {
  routeFrontendProcessEventRaw(canonicalInstallationId(extensionId), payload)
}
mock.restore()
trackWindowHandlers = true

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
  ready(): void
  ui: {
    mount(point: string): FakeRoot
    presetEditor: {
      extension: {
        getState(): unknown
        onChange(handler: (state: unknown) => void): () => void
      }
    }
  }
  processes: {
    register(kind: string, handler: (process: ProcessContext) => void | (() => void)): () => void
  }
  permissions: {
    request(permissions: string[]): Promise<string[]>
  }
}
type ProcessContext = {
  processId: string
  ready(): void
  onMessage(handler: (payload: unknown) => void): () => void
  onStop(handler: (detail: { reason?: string }) => void): () => void
}

type LifecycleProcessRegistration = (context: LifecycleContext) => void
lifecycleGlobals.__lifecycleRegisterPresetEditor = (context: LifecycleContext) => {
  if (!lifecycleGlobals.__lifecycleCaptureHelper && !lifecycleGlobals.__lifecycleSubscribePresetEditor) return
  const helper = context.ui.presetEditor.extension
  lifecycleGlobals.__lifecycleRetainedHelper = helper
  if (lifecycleGlobals.__lifecycleSubscribePresetEditor) {
    const countChange = (index: number) => () => {
      const calls = lifecycleGlobals.__lifecyclePresetEditorCallbackCalls as number[]
      calls[index] += 1
    }
    lifecycleGlobals.__lifecycleRetainedPresetEditorUnsubscribes = [
      helper.onChange(countChange(0)),
      helper.onChange(countChange(1)),
    ]
  }
}

function clearTrackedWindowHandlers(): void {
  for (const [type, handlers] of windowHandlers) {
    for (const { listener, options } of handlers) {
      nativeWindowRemoveEventListener(type, listener, options)
    }
  }
  windowHandlers.clear()
}

function assertNoTrackedWindowHandlers(): void {
  const leakedHandlers = [...windowHandlers].flatMap(([type, handlers]) =>
    [...handlers].map(({ listener, options }) => ({ type, listener, options })),
  )
  try {
    expect(leakedHandlers).toEqual([])
  } finally {
    clearTrackedWindowHandlers()
  }
}

function resetHarness(): void {
  lifecycleGlobals.__APP_VERSION__ = SUPPORTED_LUMIVERSE_VERSION
  permissionPromise = Promise.resolve({ granted: [] })
  lifecycleGlobals.__lifecycleSetupResult = undefined
  lifecycleGlobals.__lifecycleModuleSource = lifecycleModuleSource
  lifecycleGlobals.__lifecycleContext = undefined
  lifecycleGlobals.__lifecycleCaptureHelper = false
  lifecycleGlobals.__lifecycleSubscribePresetEditor = false
  lifecycleGlobals.__lifecycleRetainedHelper = undefined
  lifecycleGlobals.__lifecycleRetainedPresetEditorUnsubscribes = undefined
  lifecycleGlobals.__lifecyclePresetEditorCallbackCalls = [0, 0]
  lifecycleGlobals.__lifecycleMount = false
  lifecycleGlobals.__lifecycleReturnStaticTeardown = false
  lifecycleGlobals.__lifecycleRequestCatalog = false
  lifecycleGlobals.__lifecycleExerciseSetup = undefined
  lifecycleGlobals.__lifecycleThrowSetup = false
  lifecycleGlobals.__catalogProvider = undefined
lifecycleGlobals.__lifecycleRegisterProcess = undefined
  lifecycleGlobals.__catalogPromise = undefined
  lifecycleGlobals.__lifecycleTeardownCalls = 0
  lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls = 0
  storeState.pendingPermissionRequest = null
  wsHandlers.clear()
  clearTrackedWindowHandlers()
  uuidSequence = 0
  macroCatalogMessages.splice(0)
  removedRoots.splice(0)
  frontendProcessEvents.splice(0)
  placementDestroyCalls.splice(0)
  uiEventDestroyAllCalls.splice(0)
  uiEventDestroyPermissionCalls.splice(0)
  accessCreations = 0
  presetEditorUnderlyingUnsubscribeCalls = 0
}

async function flushLifecycleTasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
async function waitForLifecycle(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function assertFailedLoadCleanup(extensionId: string, expectResources: boolean): void {
  const installationId = canonicalInstallationId(extensionId)
  expect(getLoadedExtensions().has(installationId)).toBe(false)
  expect([...wsHandlers.values()].every((handlers) => handlers.size === 0)).toBe(true)
  expect([...windowHandlers.values()].every((handlers) => handlers.size === 0)).toBe(true)
  expect([...presetEditorSubscribers]).toEqual([])
  if (expectResources) {
    expect(removedRoots.length).toBeGreaterThan(0)
    expect(removedRoots.every((root) => root.removed)).toBe(true)
    expect(placementDestroyCalls).toContain(installationId)
  } else {
    expect(removedRoots).toEqual([])
  }
}

function installFailureResources(
  extensionId: string,
  processId: string,
  processCleanupCalls: { value: number },
): void {
  lifecycleGlobals.__lifecycleExerciseSetup = (context: LifecycleContext) => {
    context.ui.mount('main')
    context.ui.presetEditor.extension.onChange(() => {})
    void context.permissions.request(['ui_panels']).catch(() => {})
    context.processes.register('failure-process', (process) => {
      process.ready()
      process.onMessage(() => {})
      process.onStop(() => {})
      return () => {
        processCleanupCalls.value += 1
      }
    })
    context.ready()
    routeFrontendProcessEvent(extensionId, {
      action: 'spawn',
      processId,
      kind: 'failure-process',
      payload: { source: 'failure-contract' },
    })
  }
}

beforeAll(() => resetHarness())
afterEach(async () => {
  try {
    assertNoTrackedWindowHandlers()
  } finally {
    for (const extensionId of [...getLoadedExtensions().keys()]) {
      await unloadFrontendExtension(extensionId)
    }
    expect([...presetEditorSubscribers]).toEqual([])
    resetHarness()
  }
})

afterAll(async () => {
  mock.restore()
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const [key, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor)
  }
  for (const [key, descriptor] of originalUrlDescriptors) {
    if (descriptor) Object.defineProperty(URL, key, descriptor)
    else Reflect.deleteProperty(URL, key)
    expect(Object.getOwnPropertyDescriptor(URL, key)).toEqual(descriptor)
  }
  expect(globalThis.window).toBe(originalGlobals.window)
  expect(globalThis.document).toBe(originalGlobals.document)
  expect(globalThis.Element).toBe(originalGlobals.Element)
  expect(globalThis.HTMLElement).toBe(originalGlobals.HTMLElement)
  expect(globalThis.Node).toBe(originalGlobals.Node)
  expect(globalThis.MutationObserver).toBe(originalGlobals.MutationObserver)
  expect(globalThis.fetch).toBe(originalGlobals.fetch)
  rmSync(moduleDirectory, { recursive: true, force: true })
  dom.window.close()
})

describe('loader lifecycle orchestration', () => {
  test('force-stop cleans up when onStop returns without completing', async () => {
    const extensionId = 'stalled_stop'
    const installationId = canonicalInstallationId(extensionId)
    let stopCalls = 0
    let cleanupCalls = 0
    let messageCalls = 0
    lifecycleGlobals.__lifecycleRegisterProcess = ((context: LifecycleContext) => {
      context.processes.register('stalled-stop', (process) => {
        process.ready()
        process.onMessage(() => {
          messageCalls += 1
        })
        // onStop is synchronous and void; returning without process.complete models no acknowledgement.
        // An infinite synchronous handler would block later browser events, so a non-completing return is the testable watchdog case.
        process.onStop(() => {
          stopCalls += 1
        })
        return () => {
          cleanupCalls += 1
        }
      })
    }) as LifecycleProcessRegistration

    await loadFrontendExtension(extensionId, { ...manifest, identifier: extensionId })
    routeFrontendProcessEvent(extensionId, {
      action: 'spawn',
      processId: 'stalled-process',
      kind: 'stalled-stop',
      payload: { source: 'test' },
    })
    await flushLifecycleTasks()
    expect(getLoadedExtensions().get(installationId)?.activeProcesses.has('stalled-process')).toBe(true)
    expect(frontendProcessEvents).toContainEqual({
      type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
      extensionId: installationId,
      processId: 'stalled-process',
      event: 'ready',
    })

    routeFrontendProcessEvent(extensionId, {
      action: 'stop',
      processId: 'stalled-process',
      reason: 'graceful-stop',
    })
    await flushLifecycleTasks()
    expect(stopCalls).toBe(1)
    expect(cleanupCalls).toBe(0)
    expect(frontendProcessEvents.filter((event) =>
      typeof event === 'object' &&
      event !== null &&
      'processId' in event &&
      event.processId === 'stalled-process' &&
      'event' in event &&
      event.event === 'complete',
    )).toHaveLength(0)

    routeFrontendProcessEvent(extensionId, {
      action: 'message',
      processId: 'stalled-process',
      payload: { stillActive: true },
    })
    expect(messageCalls).toBe(1)

    routeFrontendProcessEvent(extensionId, {
      action: 'stop',
      processId: 'stalled-process',
      reason: 'Frontend process force-stopped after stop timeout',
      force: true,
    })
    await flushLifecycleTasks()
    expect(getLoadedExtensions().get(installationId)?.activeProcesses.has('stalled-process')).toBe(false)
    expect(cleanupCalls).toBe(1)
    expect(frontendProcessEvents.filter((event) =>
      typeof event === 'object' &&
      event !== null &&
      'processId' in event &&
      event.processId === 'stalled-process' &&
      'event' in event &&
      event.event === 'complete',
    )).toEqual([
      {
        type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
        extensionId: installationId,
        processId: 'stalled-process',
        event: 'complete',
      },
    ])

    routeFrontendProcessEvent(extensionId, {
      action: 'message',
      processId: 'stalled-process',
      payload: { late: true },
    })
    routeFrontendProcessEvent(extensionId, {
      action: 'stop',
      processId: 'stalled-process',
      reason: 'late-graceful-stop',
    })
    routeFrontendProcessEvent(extensionId, {
      action: 'stop',
      processId: 'stalled-process',
      reason: 'late-force-stop',
      force: true,
    })
    await flushLifecycleTasks()
    expect(messageCalls).toBe(1)
    expect(stopCalls).toBe(1)
    expect(cleanupCalls).toBe(1)
    expect(frontendProcessEvents.filter((event) =>
      typeof event === 'object' &&
      event !== null &&
      'processId' in event &&
      event.processId === 'stalled-process' &&
      'event' in event &&
      event.event === 'complete',
    )).toHaveLength(1)
    await unloadFrontendExtension(extensionId)
  })
  test('revocation observed before GET resolution wins, then a WS regrant creates fresh access', async () => {
    let resolvePermissions!: (result: PermissionResult) => void
    permissionPromise = new Promise<PermissionResult>((resolve) => {
      resolvePermissions = resolve
    })
    const loading = loadFrontendExtension('revoke_before_get', manifest)
    await waitForLifecycle(
      () => (wsHandlers.get('ws:SPINDLE_PERMISSION_CHANGED')?.size ?? 0) > 0,
      'the permission-change listener',
    )
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
    let resolveFirstFetch: ((response: Response) => void) | undefined
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
      await waitForLifecycle(() => resolveFirstFetch !== undefined, 'the first frontend bundle fetch')
      await unloadFrontendExtension('reload_after_invalidation')

      const second = loadFrontendExtension('reload_after_invalidation', {
        ...manifest,
        identifier: 'reload_after_invalidation',
      })
      if (!resolveFirstFetch) throw new Error('First frontend bundle fetch did not start')
      resolveFirstFetch(new Response(lifecycleModuleSource))
      await Promise.all([first, second])

      expect(fetchCount).toBe(2)
      expect(getLoadedExtensions().has(canonicalInstallationId('reload_after_invalidation'))).toBe(true)
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
    expect(uiEventDestroyPermissionCalls).toEqual([{ extensionId: canonicalInstallationId('request_regrant'), permission: 'presets' }])
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
    expect(windowHandlers.get('spindle:permission-resolved')?.size ?? 0).toBe(0)
    expect(uiEventDestroyAllCalls.length).toBeGreaterThan(0)
    expect(uiEventDestroyAllCalls.every((extensionId) => extensionId === canonicalInstallationId('request_regrant'))).toBe(true)
  })

  test('revoking presets disposes the retained subscription and makes its helper unusable', async () => {
    permissionPromise = Promise.resolve({ granted: ['presets'] })
    lifecycleGlobals.__lifecycleSubscribePresetEditor = true
    await loadFrontendExtension('subscription_revoke', { ...manifest, identifier: 'subscription_revoke' })

    const retained = lifecycleGlobals.__lifecycleRetainedHelper as LifecycleContext['ui']['presetEditor']['extension']
    const publish = lifecycleGlobals.__publishPresetEditorChange as () => void
    const lateUnsubscribes = lifecycleGlobals.__lifecycleRetainedPresetEditorUnsubscribes as Array<() => void>
    publish()
    expect(lifecycleGlobals.__lifecyclePresetEditorCallbackCalls).toEqual([1, 1])

    dispatchWs('SPINDLE_PERMISSION_CHANGED', {
      extensionId: 'subscription_revoke',
      allGranted: [],
    })
    expect(lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls).toBe(2)
    expect(() => retained.getState()).toThrow('PRESET_EDITOR_DISPOSED')
    expect(() => retained.onChange(() => {})).toThrow('PRESET_EDITOR_DISPOSED')

    publish()
    expect(lifecycleGlobals.__lifecyclePresetEditorCallbackCalls).toEqual([1, 1])
    for (const unsubscribe of lateUnsubscribes) {
      unsubscribe()
      unsubscribe()
    }
    expect(lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls).toBe(2)
    await unloadFrontendExtension('subscription_revoke')
  })

  test('unloading disposes the retained subscription exactly once and blocks later publications', async () => {
    permissionPromise = Promise.resolve({ granted: ['presets'] })
    lifecycleGlobals.__lifecycleSubscribePresetEditor = true
    await loadFrontendExtension('subscription_unload', { ...manifest, identifier: 'subscription_unload' })
    const retained = lifecycleGlobals.__lifecycleRetainedHelper as LifecycleContext['ui']['presetEditor']['extension']
    const publish = lifecycleGlobals.__publishPresetEditorChange as () => void
    const lateUnsubscribes = lifecycleGlobals.__lifecycleRetainedPresetEditorUnsubscribes as Array<() => void>
    publish()
    expect(lifecycleGlobals.__lifecyclePresetEditorCallbackCalls).toEqual([1, 1])

    await unloadFrontendExtension('subscription_unload')
    expect(lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls).toBe(2)
    expect(() => retained.getState()).toThrow('PRESET_EDITOR_DISPOSED')
    expect(() => retained.onChange(() => {})).toThrow('PRESET_EDITOR_DISPOSED')

    publish()
    expect(lifecycleGlobals.__lifecyclePresetEditorCallbackCalls).toEqual([1, 1])
    for (const unsubscribe of lateUnsubscribes) {
      unsubscribe()
      unsubscribe()
    }
    expect(lifecycleGlobals.__presetEditorUnderlyingUnsubscribeCalls).toBe(2)
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
    expect(windowHandlers.get('spindle:permission-resolved')?.size ?? 0).toBe(0)
  })

  test('late setup rejection unloads roots, placements, and permission listeners', async () => {
    let rejectSetup!: (error: Error) => void
    lifecycleGlobals.__lifecycleSetupResult = new Promise<unknown>((_resolve, reject) => {
      rejectSetup = reject
    })
    lifecycleGlobals.__lifecycleMount = true
    const loading = loadFrontendExtension('late_setup_failure', { ...manifest, identifier: 'late_setup_failure' })
    await waitForLifecycle(
      () => getLoadedExtensions().has(canonicalInstallationId('late_setup_failure')),
      'late setup registration',
    )
    rejectSetup(new Error('late setup failure'))
    await expect(loading).rejects.toThrow('late setup failure')
    await flushLifecycleTasks()

    expect(getLoadedExtensions().has(canonicalInstallationId('late_setup_failure'))).toBe(false)
    expect(placementDestroyCalls).toContain(canonicalInstallationId('late_setup_failure'))
    expect(removedRoots.some((root) => root.removed)).toBe(true)
    expect(wsHandlers.get('ws:SPINDLE_PERMISSION_CHANGED')?.size ?? 0).toBe(0)
    expect(windowHandlers.get('spindle:permission-resolved')?.size ?? 0).toBe(0)
  })

  test('late async setup teardown matching claimed static teardown runs once', async () => {
    let resolveSetup!: () => void
    lifecycleGlobals.__lifecycleReturnStaticTeardown = true
    lifecycleGlobals.__lifecycleSetupResult = new Promise<void>((resolve) => {
      resolveSetup = resolve
    })
    const loading = loadFrontendExtension('same_teardown', { ...manifest, identifier: 'same_teardown' })
    await waitForLifecycle(
      () => getLoadedExtensions().has(canonicalInstallationId('same_teardown')),
      'async setup registration',
    )
    await unloadFrontendExtension('same_teardown')
    resolveSetup()
    await loading
    await flushLifecycleTasks()

    expect(lifecycleGlobals.__lifecycleTeardownCalls).toBe(1)
  })
  test('resolves a current-generation macro catalog response by request id', async () => {
    lifecycleGlobals.__lifecycleRequestCatalog = true
    await loadFrontendExtension('catalog_current', { ...manifest, identifier: 'catalog_current' })

    const request = lifecycleGlobals.__catalogPromise as Promise<unknown>
    const sent = macroCatalogMessages[0] as { payload: { requestId: string } }
    expect(sent.payload.requestId).toBe('request-id')
    routeBackendMessage('catalog_current', {
      type: '__loom_macro_catalog_response',
      requestId: sent.payload.requestId,
      catalog: { categories: [] },
    })
    await expect(request).resolves.toEqual({ categories: [] })
    await unloadFrontendExtension('catalog_current')
  })

  test('drops a late catalog response from an unloaded generation', async () => {
    lifecycleGlobals.__lifecycleRequestCatalog = true
    await loadFrontendExtension('catalog_reload', { ...manifest, identifier: 'catalog_reload' })
    const first = lifecycleGlobals.__catalogPromise as Promise<unknown>
    const firstRequest = (macroCatalogMessages[0] as { payload: { requestId: string } }).payload
    await unloadFrontendExtension('catalog_reload')
    await expect(first).rejects.toThrow('Macro catalog request cancelled')

    await loadFrontendExtension('catalog_reload', { ...manifest, identifier: 'catalog_reload' })
    const second = lifecycleGlobals.__catalogPromise as Promise<unknown>
    const secondRequest = (macroCatalogMessages.at(-1) as { payload: { requestId: string } }).payload
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId)

    let secondResolved = false
    void second.then(() => { secondResolved = true })
    routeBackendMessage('catalog_reload', {
      type: '__loom_macro_catalog_response',
      requestId: firstRequest.requestId,
      catalog: { categories: [] },
    })
    await flushLifecycleTasks()
    expect(secondResolved).toBe(false)

    routeBackendMessage('catalog_reload', {
      type: '__loom_macro_catalog_response',
      requestId: secondRequest.requestId,
      catalog: { categories: [] },
    })
    await expect(second).resolves.toEqual({ categories: [] })
    await unloadFrontendExtension('catalog_reload')
  })
  test('HTTP load failure rejects without leaving lifecycle residue', async () => {
    const extensionId = 'http_failure'
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch
    try {
      await expect(loadFrontendExtension(extensionId, { ...manifest, identifier: extensionId })).rejects.toThrow('503')
      assertFailedLoadCleanup(extensionId, false)

      const eventCount = frontendProcessEvents.length
      routeFrontendProcessEvent(extensionId, {
        action: 'message',
        processId: 'late-process',
        payload: { late: true },
      })
      routeFrontendProcessEvent(extensionId, {
        action: 'stop',
        processId: 'late-process',
        reason: 'late-stop',
      })
      await flushLifecycleTasks()
      expect(frontendProcessEvents).toHaveLength(eventCount)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('missing and invalid setup exports reject without leaving lifecycle residue', async () => {
    const cases = [
      ['missing_setup', 'export const value = 1;'],
      ['invalid_setup', 'export const setup = 42;'],
    ] as const
    const previousSource = lifecycleGlobals.__lifecycleModuleSource
    try {
      for (const [suffix, source] of cases) {
        const extensionId = `setup_export_${suffix}`
        lifecycleGlobals.__lifecycleModuleSource = source
        await expect(loadFrontendExtension(extensionId, { ...manifest, identifier: extensionId })).rejects.toThrow('must export a setup() function')
        assertFailedLoadCleanup(extensionId, false)

        const eventCount = frontendProcessEvents.length
        routeFrontendProcessEvent(extensionId, {
          action: 'spawn',
          processId: 'late-process',
          kind: 'late-kind',
          payload: {},
        })
        await flushLifecycleTasks()
        expect(frontendProcessEvents).toHaveLength(eventCount)
      }
    } finally {
      lifecycleGlobals.__lifecycleModuleSource = previousSource
    }
  })

  test('synchronous setup throw rejects after cleaning every owned resource', async () => {
    const extensionId = 'sync_setup_failure'
    const processId = 'sync-failure-process'
    const processCleanupCalls = { value: 0 }
    permissionPromise = Promise.resolve({ granted: ['presets'] })
    installFailureResources(extensionId, processId, processCleanupCalls)
    lifecycleGlobals.__lifecycleThrowSetup = true

    await expect(loadFrontendExtension(extensionId, { ...manifest, identifier: extensionId })).rejects.toThrow('sync setup failure')
    await flushLifecycleTasks()

    assertFailedLoadCleanup(extensionId, true)
    expect(processCleanupCalls.value).toBe(1)
    expect(frontendProcessEvents).toContainEqual({
      type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
      extensionId: canonicalInstallationId(extensionId),
      processId,
      event: 'frontend_unloaded',
    })

    const eventCount = frontendProcessEvents.length
    routeFrontendProcessEvent(extensionId, {
      action: 'message',
      processId,
      payload: { late: true },
    })
    routeFrontendProcessEvent(extensionId, {
      action: 'stop',
      processId,
      reason: 'late-stop',
    })
    await flushLifecycleTasks()
    expect(frontendProcessEvents).toHaveLength(eventCount)
  })

  test('asynchronous setup rejection rejects and cleans every owned resource', async () => {
    const extensionId = 'async_setup_failure'
    const processId = 'async-failure-process'
    const processCleanupCalls = { value: 0 }
    let rejectSetup!: (error: Error) => void
    permissionPromise = Promise.resolve({ granted: ['presets'] })
    lifecycleGlobals.__lifecycleSetupResult = new Promise<unknown>((_resolve, reject) => {
      rejectSetup = reject
    })
    installFailureResources(extensionId, processId, processCleanupCalls)

    const loading = loadFrontendExtension(extensionId, { ...manifest, identifier: extensionId })
    await waitForLifecycle(
      () => getLoadedExtensions().has(canonicalInstallationId(extensionId)),
      'async setup failure registration',
    )
    expect(getLoadedExtensions().get(canonicalInstallationId(extensionId))?.activeProcesses.has(processId)).toBe(true)
    expect([...presetEditorSubscribers]).not.toEqual([])
    expect(windowHandlers.get('spindle:permission-resolved')?.size ?? 0).toBe(1)

    rejectSetup(new Error('async setup failure'))
    await expect(loading).rejects.toThrow('async setup failure')
    await flushLifecycleTasks()

    assertFailedLoadCleanup(extensionId, true)
    expect(processCleanupCalls.value).toBe(1)
    expect(frontendProcessEvents).toContainEqual({
      type: 'SPINDLE_FRONTEND_PROCESS_EVENT',
      extensionId: canonicalInstallationId(extensionId),
      processId,
      event: 'frontend_unloaded',
    })

    const eventCount = frontendProcessEvents.length
    routeFrontendProcessEvent(extensionId, {
      action: 'message',
      processId,
      payload: { late: true },
    })
    routeFrontendProcessEvent(extensionId, {
      action: 'stop',
      processId,
      reason: 'late-stop',
    })
    await flushLifecycleTasks()
    expect(frontendProcessEvents).toHaveLength(eventCount)
  })
})
