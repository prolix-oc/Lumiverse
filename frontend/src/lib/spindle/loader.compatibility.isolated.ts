import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SpindleManifest } from 'lumiverse-spindle-types'
import {
  SPINDLE_HOST_CAPABILITIES,
  digestSpindleHostDescriptor,
  validateSpindleHostDescriptor,
} from './host-compatibility'

const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const APP_VERSION = '1.0.8'

type LoaderGlobals = {
  __APP_VERSION__?: unknown
  __loaderMode?: 'ok' | 'setup-reject' | 'async-teardown' | 'async-ready'
  __loaderSetupCalls?: number
  __loaderMountCalls?: number
  __loaderTeardownCalls?: number
  __loaderEvents?: string[]
  __loaderHost?: unknown
}

const globals = globalThis as typeof globalThis & LoaderGlobals
globals.__APP_VERSION__ = APP_VERSION

type EventHandler = (payload: unknown) => void
const wsHandlers = new Map<string, Set<EventHandler>>()
let handshakeCalls = 0
let bundleFetchCalls = 0
let handshakeFailure = false
let nextDescriptor = validateSpindleHostDescriptor({
  descriptorVersion: 1,
  lumiverseVersion: APP_VERSION,
  capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'future-capability-v2': 3 },
  extensionInstallationId: INSTALLATION_ID,
})
let tamperDigest = false

function sourceForMode(): string {
  if (globals.__loaderMode === 'setup-reject') {
    return `export async function setup(ctx) { globalThis.__loaderEvents.push('setup'); globalThis.__loaderMountCalls = Number(globalThis.__loaderMountCalls || 0) + 1; ctx.ui.mount('main'); throw new Error('setup rejected'); }`
  }
  if (globals.__loaderMode === 'async-teardown') {
    return `export async function setup() { globalThis.__loaderEvents.push('setup'); return async () => { globalThis.__loaderTeardownCalls = Number(globalThis.__loaderTeardownCalls || 0) + 1 } }`
  }
  if (globals.__loaderMode === 'async-ready') {
    return `export async function setup(ctx) { globalThis.__loaderEvents.push('setup'); globalThis.__loaderHost = ctx.host; ctx.deferReady(); await Promise.resolve(); ctx.ready() }`
  }
  return `export function setup(ctx) { globalThis.__loaderEvents.push('setup'); globalThis.__loaderHost = ctx.host; globalThis.__loaderSetupCalls = Number(globalThis.__loaderSetupCalls || 0) + 1; globalThis.__loaderMountCalls = Number(globalThis.__loaderMountCalls || 0) + 1; ctx.ui.mount('main'); globalThis.__loaderEvents.push('mount') }`
}

function responseForNonce(nonce: string): Promise<unknown> {
  globals.__loaderEvents?.push('handshake')
  return digestSpindleHostDescriptor(nextDescriptor).then((digest) => ({
    nonce,
    descriptor: nextDescriptor,
    digest: tamperDigest ? `${digest}x` : digest,
  }))
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
    CustomEvent: class {
      detail: unknown
      constructor(_type: string, init?: { detail?: unknown }) { this.detail = init?.detail }
    },
  },
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    body: {
      hasAttribute() { return false },
      appendChild() {},
    },
    createElement() {
      return {
        style: {},
        setAttribute() {},
        appendChild() {},
        remove() {},
        replaceChildren() {},
        addEventListener() {},
        removeEventListener() {},
      }
    },
    querySelector() { return null },
  },
})
Object.defineProperty(globalThis, 'MutationObserver', {
  configurable: true,
  value: class {
    observe() {}
    disconnect() {}
  },
})

globalThis.fetch = (async () => {
  globals.__loaderEvents?.push('bundle')
  bundleFetchCalls += 1
  return new Response(sourceForMode())
}) as unknown as typeof fetch
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: () => `data:text/javascript;base64,${Buffer.from(sourceForMode()).toString('base64')}`,
})
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })

mock.module('@/api/spindle', () => ({
  spindleApi: {
    compatibilityHandshake: async (_id: string, nonce: string) => {
      handshakeCalls += 1
      if (handshakeFailure) throw new Error('compatibility handshake timeout')
      return responseForNonce(nonce)
    },
    getPermissions: async () => ({ granted: [] }),
  },
}))
mock.module('@/store', () => ({
  useStore: {
    getState: () => ({ messages: [] }),
    setState() {},
  },
}))
mock.module('@/ws/client', () => ({
  wsClient: {
    on(event: string, handler: EventHandler) {
      const handlers = wsHandlers.get(event) ?? new Set<EventHandler>()
      handlers.add(handler)
      wsHandlers.set(event, handlers)
      return () => handlers.delete(handler)
    },
    send() {},
  },
}))
mock.module('@/api/characters', () => ({ charactersApi: { get: async () => null } }))
mock.module('@/api/chats', () => ({ messagesApi: { update: async () => ({ id: 'message' }) } }))
mock.module('./dom-helper', () => ({ createDOMHelper: () => ({ cleanup() {} }) }))
mock.module('./message-interceptors', () => ({ registerTagInterceptor: () => () => {}, unregisterTagInterceptorsByExtension() {} }))
mock.module('./display-resolver-registry', () => ({ registerDisplayResolver: () => () => {}, unregisterDisplayResolver() {} }))
mock.module('@/hooks/useDisplayRegex', () => ({ invalidateDisplayRegexCache() {}, invalidateDisplayRegexCacheForVars() {} }))
mock.module('./message-widgets', () => ({ removeMessageWidgetsByExtension() {}, upsertMessageWidget: () => () => {}, removeMessageWidget() {} }))
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
  destroyAllPlacementsForExtension() {},
  destroyPlacementsForExtensionPermission() {},
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
mock.module('./preset-editor-access', () => ({ createPresetEditorAccess: () => ({ acquire: () => ({}), dispose() {} }) }))
mock.module('./components-helper', () => ({
  createComponentsHelper: () => ({}),
  destroyComponentsForTarget() {},
  destroyAllComponentsForExtension() {},
  destroyComponentsForExtensionPermission() {},
}))
mock.module('@/lib/uuid', () => ({ generateUUID: () => 'request-id' }))
mock.module('./navigation-guards', () => ({ installSpindleNavigationGuards() {} }))
mock.module('@/lib/drawer-tab-registry', () => ({ DRAWER_TABS: [], ensureRegistryRoot: () => undefined }))
mock.module('./ui-events-helper', () => ({
  createUIEventsHelper: () => ({}),
  destroyAllUIEventBindingsForExtension() {},
  destroyUIEventBindingsForExtensionPermission() {},
}))
mock.module('./browser-scheduler', () => ({ yieldToBrowser: async () => {} }))
mock.module('./live-root-registry', () => ({ registerLiveRoot: () => () => {}, clearLiveRootsForExtension() {} }))
mock.module('./frontend-extension-cleanup', () => ({
  createFrontendExtensionCleanup: (resources: Record<string, () => void>) => {
    let cleaned = false
    return () => {
      if (cleaned) return
      cleaned = true
      resources.deactivatePresetEditor()
      resources.clearPresetEditorSubscriptions()
      resources.destroyPlacements()
      resources.cleanupProcesses()
      resources.teardown?.()
      resources.drainEventSubscriptions()
      resources.cleanupDomAndMounts()
      resources.cleanupRegistries()
    }
  },
  finalizeFrontendLoadFailure: (cleanup: () => void) => cleanup(),
  isPermissionBootstrapCurrent: () => true,
}))

const manifest: SpindleManifest = {
  version: '1.0.0',
  name: 'Compatibility test',
  identifier: 'compatibility_test',
  author: 'test',
  github: 'https://example.test/compatibility',
  homepage: 'https://example.test/compatibility',
  permissions: [],
}

const { getLoadedExtensions, loadFrontendExtension, unloadFrontendExtension } = await import('./loader')

beforeEach(() => {
  globals.__APP_VERSION__ = APP_VERSION
  globals.__loaderMode = 'ok'
  globals.__loaderSetupCalls = 0
  globals.__loaderMountCalls = 0
  globals.__loaderTeardownCalls = 0
  globals.__loaderEvents = []
  globals.__loaderHost = undefined
  handshakeFailure = false
  tamperDigest = false
  nextDescriptor = validateSpindleHostDescriptor({
    descriptorVersion: 1,
    lumiverseVersion: APP_VERSION,
    capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'future-capability-v2': 3 },
    extensionInstallationId: INSTALLATION_ID,
  })
})

afterAll(async () => {
  await unloadFrontendExtension(INSTALLATION_ID)
})

describe('frontend loader host handshake', () => {
  test('rejects malformed or too-new inputs before the handshake and bundle fetch', async () => {
    const beforeHandshakes = handshakeCalls
    const beforeBundles = bundleFetchCalls
    await expect(loadFrontendExtension('not-a-uuid', manifest)).rejects.toMatchObject({ code: 'SPINDLE_COMPATIBILITY_ERROR' })
    await expect(loadFrontendExtension(INSTALLATION_ID, { ...manifest, minimum_lumiverse_version: '1.0.9' })).rejects.toMatchObject({ code: 'SPINDLE_COMPATIBILITY_ERROR' })
    expect(handshakeCalls).toBe(beforeHandshakes)
    expect(bundleFetchCalls).toBe(beforeBundles)
  })

  test('rejects nonce or digest mismatch before importing or setting up the bundle', async () => {
    tamperDigest = true
    const beforeBundles = bundleFetchCalls
    await expect(loadFrontendExtension(INSTALLATION_ID, manifest)).rejects.toMatchObject({ code: 'SPINDLE_COMPATIBILITY_ERROR' })
    expect(bundleFetchCalls).toBe(beforeBundles)
    expect(globals.__loaderSetupCalls).toBe(0)
    expect(getLoadedExtensions().has(INSTALLATION_ID)).toBe(false)
  })
  test('rejects handshake transport failure before bundle or setup work', async () => {
    handshakeFailure = true
    const beforeBundles = bundleFetchCalls
    await expect(loadFrontendExtension(INSTALLATION_ID, manifest)).rejects.toMatchObject({ code: 'SPINDLE_COMPATIBILITY_ERROR' })
    expect(bundleFetchCalls).toBe(beforeBundles)
    expect(globals.__loaderSetupCalls).toBe(0)
    expect(globals.__loaderMountCalls).toBe(0)
    expect(getLoadedExtensions().has(INSTALLATION_ID)).toBe(false)
  })
  test('rejects stale local versions and mixed host descriptors before bundle or setup work', async () => {
    globals.__APP_VERSION__ = '1.0.7'
    const beforeBundles = bundleFetchCalls
    await expect(loadFrontendExtension(INSTALLATION_ID, manifest)).rejects.toMatchObject({ code: 'SPINDLE_COMPATIBILITY_ERROR' })
    expect(bundleFetchCalls).toBe(beforeBundles)
    globals.__APP_VERSION__ = APP_VERSION
    nextDescriptor = validateSpindleHostDescriptor({
      descriptorVersion: 1,
      lumiverseVersion: '1.0.9',
      capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'future-capability-v2': 3 },
      extensionInstallationId: INSTALLATION_ID,
    })
    await expect(loadFrontendExtension(INSTALLATION_ID, manifest)).rejects.toMatchObject({ code: 'SPINDLE_COMPATIBILITY_ERROR' })
    expect(bundleFetchCalls).toBe(beforeBundles)
  })

  test('uses the validated immutable descriptor and awaits async setup/readiness', async () => {
    const beforeHandshakes = handshakeCalls
    globals.__loaderMode = 'async-ready'
    await loadFrontendExtension(INSTALLATION_ID, manifest)
    const loaded = getLoadedExtensions().get(INSTALLATION_ID)
    const host = loaded?.context.host
    expect(host?.extensionInstallationId).toBe(INSTALLATION_ID)
    expect(host?.capabilities['future-capability-v2']).toBe(3)
    expect(Object.isFrozen(host)).toBe(true)
    expect(Object.isFrozen(host?.capabilities)).toBe(true)
    expect(loaded?.isReady).toBe(true)
    expect(handshakeCalls).toBe(beforeHandshakes + 1)
    expect(globals.__loaderHost).toBe(host)
    await unloadFrontendExtension(INSTALLATION_ID)
    expect(getLoadedExtensions().has(INSTALLATION_ID)).toBe(false)
    expect(globals.__loaderEvents).toEqual(['handshake', 'bundle', 'setup'])
  })

  test('cleans every resource and rejects setup failures', async () => {
    globals.__loaderMode = 'setup-reject'
    await expect(loadFrontendExtension(INSTALLATION_ID, manifest)).rejects.toThrow('setup rejected')
    expect(getLoadedExtensions().has(INSTALLATION_ID)).toBe(false)
    expect(wsHandlers.get('SPINDLE_PERMISSION_CHANGED')?.size ?? 0).toBe(0)
  })

  test('awaits async teardown and keeps teardown idempotent', async () => {
    globals.__loaderMode = 'async-teardown'
    await loadFrontendExtension(INSTALLATION_ID, manifest)
    await unloadFrontendExtension(INSTALLATION_ID)
    await unloadFrontendExtension(INSTALLATION_ID)
    expect(globals.__loaderTeardownCalls).toBe(1)
  })
})
