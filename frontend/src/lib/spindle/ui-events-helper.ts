import { useStore } from '@/store'
import {
  getLiveRootRecord,
  getLiveRootRecordExact,
  subscribeLiveRoot,
  type LiveRootPermission,
} from './live-root-registry'

type SpindleUIDomActionEventType = 'click' | 'pointerdown' | 'pointerup'

type SpindleUIKeyboardState = {
  visible: boolean
  insetBottom: number
  viewportWidth: number
  viewportHeight: number
}

type SpindleUIDrawerState = {
  open: boolean
  tabId: string | null
}

type SpindleUISettingsState = {
  open: boolean
  view: string
}

type SpindleUIDomActionDetail = {
  actionId: string
  eventType: SpindleUIDomActionEventType
  element: HTMLElement
  root: Element
  originalEvent: Event
}

type SpindleUIDomActionBindingOptions = {
  attribute?: string
  events?: SpindleUIDomActionEventType[]
}

export interface FrontendUIEventsHelper {
  getKeyboardState(): SpindleUIKeyboardState
  onKeyboardChange(handler: (state: SpindleUIKeyboardState) => void): () => void
  getDrawerState(): SpindleUIDrawerState
  onDrawerChange(handler: (state: SpindleUIDrawerState) => void): () => void
  getSettingsState(): SpindleUISettingsState
  onSettingsChange(handler: (state: SpindleUISettingsState) => void): () => void
  bindActionHandlers(
    target: string | Element,
    handlers: Record<string, (detail: SpindleUIDomActionDetail) => void>,
    options?: SpindleUIDomActionBindingOptions,
  ): () => void
}

const OWNED_ROOT_ATTRS = [
  'data-spindle-ext',
  'data-spindle-extension-root',
]

type UIEventGuard = () => void

interface TrackedActionBinding {
  ownerRoot: Element
  target: Element
  permission: LiveRootPermission
  dispose(): void
}

const actionBindingsByExtension = new Map<string, Set<TrackedActionBinding>>()
const actionBindingsByRoot = new Map<Element, Set<TrackedActionBinding>>()
const actionBindingsByPermission = new Map<
  string,
  Map<LiveRootPermission, Set<TrackedActionBinding>>
>()

const actionBindingObservers = new Map<string, MutationObserver>()

function stopActionBindingObserver(extensionId: string): void {
  const observer = actionBindingObservers.get(extensionId)
  if (!observer) return
  observer.disconnect()
  actionBindingObservers.delete(extensionId)
}


function ensureActionBindingObserver(extensionId: string): void {
  if (actionBindingObservers.has(extensionId)) return
  if (window.MutationObserver === undefined) return
  const observer = new window.MutationObserver((records) => {
    const bindings = actionBindingsByExtension.get(extensionId)
    if (!bindings || bindings.size === 0) {
      stopActionBindingObserver(extensionId)
      return
    }
    for (const binding of [...bindings]) {
      if (
        isConnectedToDocument(binding.ownerRoot) === false
        || isConnectedToDocument(binding.target) === false
        || binding.ownerRoot.contains(binding.target) === false
      ) {
        binding.dispose()
      }
    }
    if (actionBindingsByExtension.get(extensionId)?.size === 0) {
      stopActionBindingObserver(extensionId)
    }
  })
  const observationTarget = document.documentElement ?? document
  observer.observe(observationTarget, { childList: true, subtree: true })
  actionBindingObservers.set(extensionId, observer)
}
function readCssPixelVar(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

function getKeyboardState(): SpindleUIKeyboardState {
  const viewport = window.visualViewport
  const viewportWidth = readCssPixelVar('--app-viewport-width', Math.round(viewport?.width ?? window.innerWidth))
  const viewportHeight = readCssPixelVar('--app-viewport-height', Math.round(viewport?.height ?? window.innerHeight))
  const insetBottom = readCssPixelVar('--app-keyboard-inset-bottom', 0)
  return { visible: insetBottom > 0, insetBottom, viewportWidth, viewportHeight }
}

function sameKeyboardState(a: SpindleUIKeyboardState, b: SpindleUIKeyboardState): boolean {
  return a.visible === b.visible
    && a.insetBottom === b.insetBottom
    && a.viewportWidth === b.viewportWidth
    && a.viewportHeight === b.viewportHeight
}

function getDrawerState(): SpindleUIDrawerState {
  const state = useStore.getState()
  return { open: state.drawerOpen, tabId: state.drawerTab }
}

function sameDrawerState(a: SpindleUIDrawerState, b: SpindleUIDrawerState): boolean {
  return a.open === b.open && a.tabId === b.tabId
}

function getSettingsState(): SpindleUISettingsState {
  const state = useStore.getState()
  return { open: state.settingsModalOpen, view: state.settingsActiveView }
}

function sameSettingsState(a: SpindleUISettingsState, b: SpindleUISettingsState): boolean {
  return a.open === b.open && a.view === b.view
}

function ownershipBoundary(element: Element): Element | null {
  let current: Element | null = element
  while (current) {
    for (const attr of OWNED_ROOT_ATTRS) {
      if (current.hasAttribute(attr)) return current
    }
    current = current.parentElement
  }
  return null
}

function isConnectedToDocument(element: Element): boolean {
  if (!element.isConnected) return false
  const documentElement = document.documentElement
  return documentElement ? documentElement.contains(element) : true
}

function isOwnedByExtension(extensionId: string, element: Element): boolean {
  const boundary = ownershipBoundary(element)
  if (!boundary) return false
  return OWNED_ROOT_ATTRS.some((attr) => boundary.getAttribute(attr) === extensionId)
}

function getPlacementRootRecord(extensionId: string, element: Element, generation?: number) {
  return getLiveRootRecord(extensionId, element, generation)
}

function registeredPlacementRoot(extensionId: string, element: Element, generation?: number): Element | null {
  return getPlacementRootRecord(extensionId, element, generation)?.root ?? null
}

function getOwnedTarget(extensionId: string, target: string | Element, generation?: number): Element {
  const selectorTarget = typeof target === 'string'
  let resolved: Element | null
  if (selectorTarget) {
    let matches: NodeListOf<Element>
    try {
      matches = document.querySelectorAll(target)
    } catch {
      throw new Error(`Invalid target selector: ${target}`)
    }
    const ownedMatches = Array.from(matches).filter((candidate) =>
      isConnectedToDocument(candidate)
      && isOwnedByExtension(extensionId, candidate)
      && registeredPlacementRoot(extensionId, candidate, generation) !== null,
    )
    if (ownedMatches.length !== 1) {
      throw new Error(
        ownedMatches.length === 0
          ? `Target not found: ${target}`
          : `Target selector is ambiguous: ${target}`,
      )
    }
    resolved = ownedMatches[0] ?? null
  } else {
    resolved = target
  }

  if (!(resolved instanceof Element) || !isConnectedToDocument(resolved)) {
    throw new Error(`Target not found: ${String(target)}`)
  }

  if (!isOwnedByExtension(extensionId, resolved)) {
    throw new Error('bindActionHandlers target must be inside DOM owned by the current extension')
  }
  if (!registeredPlacementRoot(extensionId, resolved, generation)) {
    throw new Error('bindActionHandlers target must be inside a registered placement owned by the current extension')
  }

  return resolved
}

function getActionSelector(attribute: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(attribute)) {
    throw new Error(`Invalid action attribute: ${attribute}`)
  }
  return attribute === 'id' ? '[id]' : `[${attribute}]`
}

export function destroyUIEventBindingsForExtensionPermission(
  extensionId: string,
  permission: Exclude<LiveRootPermission, null>,
): void {
  const bindings = actionBindingsByPermission.get(extensionId)?.get(permission)
  if (!bindings) return
  for (const binding of [...bindings]) binding.dispose()
}

export function destroyAllUIEventBindingsForExtension(extensionId: string): void {
  const bindings = actionBindingsByExtension.get(extensionId)
  if (!bindings) {
    stopActionBindingObserver(extensionId)
    return
  }
  for (const binding of [...bindings]) binding.dispose()
  stopActionBindingObserver(extensionId)
}

export function createUIEventsHelper(
  extensionId: string,
  assertActive: UIEventGuard = () => {},
  generation?: number,
): FrontendUIEventsHelper {
  return {
    getKeyboardState,

    onKeyboardChange(handler) {
      assertActive()
      let last = getKeyboardState()
      let frame = 0
      const emitIfChanged = () => {
        const next = getKeyboardState()
        if (sameKeyboardState(last, next)) return
        last = next
        handler(next)
      }
      const scheduleEmitIfChanged = () => {
        cancelAnimationFrame(frame)
        frame = window.requestAnimationFrame(emitIfChanged)
      }

      window.addEventListener('resize', scheduleEmitIfChanged, { passive: true })
      window.visualViewport?.addEventListener('resize', scheduleEmitIfChanged)
      window.visualViewport?.addEventListener('scroll', scheduleEmitIfChanged)

      return () => {
        cancelAnimationFrame(frame)
        window.removeEventListener('resize', scheduleEmitIfChanged)
        window.visualViewport?.removeEventListener('resize', scheduleEmitIfChanged)
        window.visualViewport?.removeEventListener('scroll', scheduleEmitIfChanged)
      }
    },

    getDrawerState,

    onDrawerChange(handler) {
      assertActive()
      let last = getDrawerState()
      return useStore.subscribe((state) => {
        const next: SpindleUIDrawerState = {
          open: state.drawerOpen,
          tabId: state.drawerTab,
        }
        if (sameDrawerState(last, next)) return
        last = next
        handler(next)
      })
    },

    getSettingsState,

    onSettingsChange(handler) {
      assertActive()
      let last = getSettingsState()
      return useStore.subscribe((state) => {
        const next: SpindleUISettingsState = {
          open: state.settingsModalOpen,
          view: state.settingsActiveView,
        }
        if (sameSettingsState(last, next)) return
        last = next
        handler(next)
      })
    },

    bindActionHandlers(target, handlers, options) {
      assertActive()
      const delegatedTarget = getOwnedTarget(extensionId, target, generation)
      const ownerRecord = getPlacementRootRecord(extensionId, delegatedTarget, generation)
      if (!ownerRecord) {
        throw new Error('bindActionHandlers target root was unregistered during binding')
      }
      const ownerRoot = ownerRecord.root
      const attribute = options?.attribute?.trim() || 'id'
      const eventNames = options?.events?.length ? [...new Set(options.events)] : ['click']
      const actionSelector = getActionSelector(attribute)

      const listener = (originalEvent: Event) => {
        if (
          !isConnectedToDocument(delegatedTarget)
          || !isOwnedByExtension(extensionId, delegatedTarget)
          || !getLiveRootRecordExact(extensionId, ownerRoot, generation)
        ) return
        const origin = originalEvent.target
        if (!(origin instanceof Element) || !isConnectedToDocument(origin)) return

        const actionElement = origin.closest(actionSelector)
        if (
          !(actionElement instanceof HTMLElement)
          || !isConnectedToDocument(actionElement)
          || !delegatedTarget.contains(actionElement)
          || !isOwnedByExtension(extensionId, actionElement)
        ) return
        const actionRecord = getLiveRootRecord(extensionId, actionElement, generation)
        if (!actionRecord || actionRecord.root !== ownerRoot) return

        const actionId = attribute === 'id'
          ? actionElement.id
          : actionElement.getAttribute(attribute)
        if (!actionId) return

        const handler = handlers[actionId]
        if (!handler) return

        handler({
          actionId,
          eventType: originalEvent.type as SpindleUIDomActionEventType,
          element: actionElement,
          root: delegatedTarget,
          originalEvent,
        })
      }

      let active = true
      let unsubscribeOwner = () => {}
      const binding: TrackedActionBinding = {
        ownerRoot,
        target: delegatedTarget,
        permission: ownerRecord.permission,
        dispose() {
          if (!active) return
          active = false
          unsubscribeOwner()
          for (const eventName of eventNames) {
            delegatedTarget.removeEventListener(eventName, listener)
          }
          actionBindingsByExtension.get(extensionId)?.delete(binding)
          const rootBindings = actionBindingsByRoot.get(ownerRoot)
          rootBindings?.delete(binding)
          if (rootBindings && rootBindings.size === 0) actionBindingsByRoot.delete(ownerRoot)
          const permissionBindings = actionBindingsByPermission.get(extensionId)?.get(binding.permission)
          permissionBindings?.delete(binding)
          const permissionMap = actionBindingsByPermission.get(extensionId)
          if (permissionBindings && permissionBindings.size === 0) permissionMap?.delete(binding.permission)
          if (permissionMap && permissionMap.size === 0) actionBindingsByPermission.delete(extensionId)
          const extensionBindings = actionBindingsByExtension.get(extensionId)
          if (extensionBindings && extensionBindings.size === 0) {
            actionBindingsByExtension.delete(extensionId)
            stopActionBindingObserver(extensionId)
          }
        },
      }
      for (const eventName of eventNames) {
        delegatedTarget.addEventListener(eventName, listener)
      }
      const bindings = actionBindingsByExtension.get(extensionId) ?? new Set<TrackedActionBinding>()
      bindings.add(binding)
      actionBindingsByExtension.set(extensionId, bindings)
      ensureActionBindingObserver(extensionId)
      const rootBindings = actionBindingsByRoot.get(ownerRoot) ?? new Set<TrackedActionBinding>()
      rootBindings.add(binding)
      actionBindingsByRoot.set(ownerRoot, rootBindings)
      const permissionMap = actionBindingsByPermission.get(extensionId) ?? new Map<LiveRootPermission, Set<TrackedActionBinding>>()
      const permissionBindings = permissionMap.get(binding.permission) ?? new Set<TrackedActionBinding>()
      permissionBindings.add(binding)
      permissionMap.set(binding.permission, permissionBindings)
      actionBindingsByPermission.set(extensionId, permissionMap)
      unsubscribeOwner = subscribeLiveRoot(ownerRoot, binding.dispose)
      return binding.dispose
    },
  }
}
