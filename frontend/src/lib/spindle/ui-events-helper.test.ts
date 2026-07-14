import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { clearLiveRootsForExtension, registerLiveRoot } from './live-root-registry'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
})
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalElement = globalThis.Element
const originalHTMLElement = globalThis.HTMLElement
const originalEvent = globalThis.Event
const originalMouseEvent = globalThis.MouseEvent
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
})

afterAll(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    Element: originalElement,
    HTMLElement: originalHTMLElement,
    Event: originalEvent,
    MouseEvent: originalMouseEvent,
  })
})

interface TestUIStore {
  drawerOpen: boolean
  drawerTab: string | null
  settingsModalOpen: boolean
  settingsActiveView: string
  drawerTabs: Array<{ root: Element; extensionId: string }>
  characterEditorTabs: Array<{ root: Element; extensionId: string }>
  presetEditorTabs: Array<{ root: Element; extensionId: string }>
  presetEditorToolbarItems: Array<{ root: Element; extensionId: string }>
  floatWidgets: Array<{ root: Element; extensionId: string }>
  dockPanels: Array<{ root: Element; extensionId: string }>
  appMounts: Array<{ root: Element; extensionId: string }>
}

const storeFactory = createStore<TestUIStore>()
let uiStore: StoreApi<TestUIStore> = storeFactory(() => ({
  drawerOpen: false,
  drawerTab: null,
  settingsModalOpen: false,
  settingsActiveView: 'general',
  drawerTabs: [],
  characterEditorTabs: [],
  presetEditorTabs: [],
  presetEditorToolbarItems: [],
  floatWidgets: [],
  dockPanels: [],
  appMounts: [],
}))
const mockedUseStore = {
  getState: () => uiStore.getState(),
  subscribe: (...args: Parameters<StoreApi<TestUIStore>['subscribe']>) => uiStore.subscribe(...args),
}
mock.module('@/store', () => ({ useStore: mockedUseStore }))

// Import after the narrow store facade is registered so this test does not load
// the full application store and its Vite-only module graph.
const {
  createUIEventsHelper,
  destroyAllUIEventBindingsForExtension,
  destroyUIEventBindingsForExtensionPermission,
} = await import('./ui-events-helper')

const extensionId = 'selector-extension-a'

const generation = 1
const registeredExtensions = new Set<string>()
const unregisterRoots: Array<() => void> = []

function registerPlacementRoot(extensionId: string, root: Element): void {
  registeredExtensions.add(extensionId)
  unregisterRoots.push(registerLiveRoot(extensionId, root, 'ui_panels', generation))
}

afterEach(() => {
  for (const unregister of unregisterRoots.splice(0)) unregister()
  for (const extensionId of registeredExtensions) clearLiveRootsForExtension(extensionId, generation)
  registeredExtensions.clear()
  document.body.replaceChildren()
  uiStore = storeFactory(() => ({
    drawerOpen: false,
    drawerTab: null,
    settingsModalOpen: false,
    settingsActiveView: 'general',
    drawerTabs: [],
    characterEditorTabs: [],
    presetEditorTabs: [],
    presetEditorToolbarItems: [],
    floatWidgets: [],
    dockPanels: [],
    appMounts: [],
  }))
  mock.restore()
})

describe('UI action target ownership', () => {
  test('filters duplicate document selectors to the current extension before resolving', () => {
    const extensionRoot = document.createElement('section')
    extensionRoot.setAttribute('data-spindle-extension-root', extensionId)
    extensionRoot.id = 'shared-target'
    const extensionAction = document.createElement('button')
    extensionAction.id = 'save'
    extensionRoot.append(extensionAction)
    const otherRoot = document.createElement('section')
    otherRoot.setAttribute('data-spindle-extension-root', 'selector-extension-b')
    otherRoot.id = 'shared-target'
    const otherAction = document.createElement('button')
    otherAction.id = 'save'
    otherRoot.append(otherAction)
    registerPlacementRoot(extensionId, extensionRoot)

    document.body.append(extensionRoot, otherRoot)
    registerPlacementRoot('selector-extension-b', otherRoot)
    uiStore.getState().drawerTabs.push({ root: extensionRoot, extensionId })
    uiStore.getState().drawerTabs.push({ root: otherRoot, extensionId: 'selector-extension-b' })

    const received: HTMLElement[] = []
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      '#shared-target',
      { save: ({ element }) => received.push(element) },
    )

    extensionAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    otherAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(received).toEqual([extensionAction])
    unbind()
    const ambiguousFirst = document.createElement('section')
    ambiguousFirst.setAttribute('data-spindle-extension-root', extensionId)
    ambiguousFirst.id = 'ambiguous-target'
    const ambiguousSecond = document.createElement('section')
    ambiguousSecond.setAttribute('data-spindle-extension-root', extensionId)
    ambiguousSecond.id = 'ambiguous-target'
    document.body.append(ambiguousFirst, ambiguousSecond)
    registerPlacementRoot(extensionId, ambiguousFirst)
    registerPlacementRoot(extensionId, ambiguousSecond)
    uiStore.getState().drawerTabs.push({ root: ambiguousFirst, extensionId })
    uiStore.getState().drawerTabs.push({ root: ambiguousSecond, extensionId })
    expect(() => createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      '#ambiguous-target',
      { save: () => {} },
    )).toThrow('Target selector is ambiguous: #ambiguous-target')
  })

  test('delegates descendants with the target root and revokes binding on owner removal', () => {
    const ownerRoot = document.createElement('section')
    ownerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const delegatedTarget = document.createElement('div')
    const action = document.createElement('button')
    action.id = 'save'
    delegatedTarget.append(action)
    ownerRoot.append(delegatedTarget)
    document.body.append(ownerRoot)
    registeredExtensions.add(extensionId)
    const unregisterOwner = registerLiveRoot(extensionId, ownerRoot, 'ui_panels', generation)
    unregisterRoots.push(unregisterOwner)

    const received: Array<{ element: Element; root: Element }> = []
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      delegatedTarget,
      { save: ({ element, root }) => received.push({ element, root }) },
    )

    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual([{ element: action, root: delegatedTarget }])

    unregisterOwner()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toHaveLength(1)

    expect(() => {
      unbind()
      unbind()
      destroyUIEventBindingsForExtensionPermission(extensionId, 'ui_panels')
      destroyUIEventBindingsForExtensionPermission(extensionId, 'ui_panels')
      destroyAllUIEventBindingsForExtension(extensionId)
      destroyAllUIEventBindingsForExtension(extensionId)
    }).not.toThrow()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toHaveLength(1)
  })
  test('preserves a delegated binding when owner root and target move together synchronously', async () => {
    const ownerRoot = document.createElement('section')
    ownerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const delegatedTarget = document.createElement('div')
    const action = document.createElement('button')
    action.id = 'save'
    delegatedTarget.append(action)
    ownerRoot.append(delegatedTarget)
    const relocationHost = document.createElement('main')
    document.body.append(ownerRoot, relocationHost)
    registerPlacementRoot(extensionId, ownerRoot)

    const received: HTMLElement[] = []
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      delegatedTarget,
      { save: ({ element }) => received.push(element) },
    )

    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual([action])

    relocationHost.append(ownerRoot)
    expect(ownerRoot.isConnected).toBe(true)
    expect(delegatedTarget.isConnected).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual([action, action])

    unbind()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual([action, action])
  })
  test('preserves a delegated binding when its target reparents within the connected owner root', async () => {
    const ownerRoot = document.createElement('section')
    ownerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const firstSubtree = document.createElement('div')
    const secondSubtree = document.createElement('div')
    const delegatedTarget = document.createElement('div')
    const action = document.createElement('button')
    action.id = 'save'
    delegatedTarget.append(action)
    firstSubtree.append(delegatedTarget)
    ownerRoot.append(firstSubtree, secondSubtree)
    document.body.append(ownerRoot)
    registerPlacementRoot(extensionId, ownerRoot)

    let calls = 0
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      delegatedTarget,
      { save: () => { calls += 1 } },
    )

    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    secondSubtree.append(delegatedTarget)
    expect(ownerRoot.isConnected).toBe(true)
    expect(delegatedTarget.isConnected).toBe(true)
    expect(ownerRoot.contains(delegatedTarget)).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(2)

    unbind()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(2)
  })


  test('permanently disposes a delegated binding when only its target moves to another connected subtree', async () => {
    const ownerRoot = document.createElement('section')
    ownerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const delegatedTarget = document.createElement('div')
    const action = document.createElement('button')
    action.id = 'save'
    delegatedTarget.append(action)
    ownerRoot.append(delegatedTarget)
    const alternateSubtree = document.createElement('aside')
    alternateSubtree.setAttribute('data-spindle-extension-root', extensionId)
    document.body.append(ownerRoot, alternateSubtree)
    registerPlacementRoot(extensionId, ownerRoot)

    let calls = 0
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      delegatedTarget,
      { save: () => { calls += 1 } },
    )

    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    alternateSubtree.append(delegatedTarget)
    expect(ownerRoot.isConnected).toBe(true)
    expect(delegatedTarget.isConnected).toBe(true)
    expect(ownerRoot.contains(delegatedTarget)).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    ownerRoot.append(delegatedTarget)
    await Promise.resolve()
    await Promise.resolve()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    unbind()
    unbind()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
  })

  test('does not dispatch an outer binding for actions inside a nested live root', () => {
    const outerRoot = document.createElement('section')
    outerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const outerAction = document.createElement('button')
    outerAction.id = 'save'
    const innerRoot = document.createElement('section')
    innerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const innerAction = document.createElement('button')
    innerAction.id = 'save'
    outerRoot.append(outerAction, innerRoot)
    innerRoot.append(innerAction)
    document.body.append(outerRoot)
    registerPlacementRoot(extensionId, outerRoot)
    registerPlacementRoot(extensionId, innerRoot)

    const received: HTMLElement[] = []
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      outerRoot,
      { save: ({ element }) => received.push(element) },
    )

    outerAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    innerAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual([outerAction])

    unbind()
    outerAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(received).toEqual([outerAction])
  })

  test('explicit unbind removes a live listener and is idempotent', () => {
    const root = document.createElement('section')
    root.setAttribute('data-spindle-extension-root', extensionId)
    const action = document.createElement('button')
    action.id = 'save'
    root.append(action)
    document.body.append(root)
    registerPlacementRoot(extensionId, root)

    let calls = 0
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      root,
      { save: () => { calls += 1 } },
    )
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    expect(() => {
      unbind()
      unbind()
    }).not.toThrow()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
  })

  test('permission cleanup removes a live listener and is idempotent', () => {
    const root = document.createElement('section')
    root.setAttribute('data-spindle-extension-root', extensionId)
    const action = document.createElement('button')
    action.id = 'save'
    root.append(action)
    document.body.append(root)
    registerPlacementRoot(extensionId, root)

    let calls = 0
    createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      root,
      { save: () => { calls += 1 } },
    )
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    destroyUIEventBindingsForExtensionPermission(extensionId, 'ui_panels')
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
    expect(() => destroyUIEventBindingsForExtensionPermission(extensionId, 'ui_panels')).not.toThrow()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
  })

  test('extension cleanup removes a live listener and is idempotent', () => {
    const root = document.createElement('section')
    root.setAttribute('data-spindle-extension-root', extensionId)
    const action = document.createElement('button')
    action.id = 'save'
    root.append(action)
    document.body.append(root)
    registerPlacementRoot(extensionId, root)

    let calls = 0
    createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      root,
      { save: () => { calls += 1 } },
    )
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    destroyAllUIEventBindingsForExtension(extensionId)
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
    expect(() => destroyAllUIEventBindingsForExtension(extensionId)).not.toThrow()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
  })
  test('permanently destroys a delegated binding when its raw owner root detaches and reattaches', async () => {
    const ownerRoot = document.createElement('section')
    ownerRoot.setAttribute('data-spindle-extension-root', extensionId)
    const action = document.createElement('button')
    action.id = 'save'
    ownerRoot.append(action)
    document.body.append(ownerRoot)
    registerPlacementRoot(extensionId, ownerRoot)

    let calls = 0
    const unbind = createUIEventsHelper(extensionId, () => {}, generation).bindActionHandlers(
      ownerRoot,
      { save: () => { calls += 1 } },
    )
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)

    ownerRoot.remove()
    await Promise.resolve()
    await Promise.resolve()
    document.body.append(ownerRoot)
    await Promise.resolve()
    await Promise.resolve()
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
    unbind()
    unbind()
  })
})
