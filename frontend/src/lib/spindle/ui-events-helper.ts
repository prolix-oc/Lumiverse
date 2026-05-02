import { useStore } from '@/store'

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

  return {
    visible: insetBottom > 0,
    insetBottom,
    viewportWidth,
    viewportHeight,
  }
}

function sameKeyboardState(a: SpindleUIKeyboardState, b: SpindleUIKeyboardState): boolean {
  return a.visible === b.visible
    && a.insetBottom === b.insetBottom
    && a.viewportWidth === b.viewportWidth
    && a.viewportHeight === b.viewportHeight
}

function getDrawerState(): SpindleUIDrawerState {
  const state = useStore.getState()
  return {
    open: state.drawerOpen,
    tabId: state.drawerTab,
  }
}

function sameDrawerState(a: SpindleUIDrawerState, b: SpindleUIDrawerState): boolean {
  return a.open === b.open && a.tabId === b.tabId
}

function getSettingsState(): SpindleUISettingsState {
  const state = useStore.getState()
  return {
    open: state.settingsModalOpen,
    view: state.settingsActiveView,
  }
}

function sameSettingsState(a: SpindleUISettingsState, b: SpindleUISettingsState): boolean {
  return a.open === b.open && a.view === b.view
}

function isOwnedByExtension(extensionId: string, element: Element): boolean {
  for (const attr of OWNED_ROOT_ATTRS) {
    if (element.getAttribute(attr) === extensionId) return true
    if (element.closest(`[${attr}="${extensionId}"]`)) return true
  }
  return false
}

function getOwnedTarget(extensionId: string, target: string | Element): Element {
  const resolved = typeof target === 'string'
    ? document.querySelector(target)
    : target

  if (!(resolved instanceof Element)) {
    throw new Error(`Target not found: ${target}`)
  }

  if (!isOwnedByExtension(extensionId, resolved)) {
    throw new Error('bindActionHandlers target must be inside DOM owned by the current extension')
  }

  return resolved
}

function getActionSelector(attribute: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(attribute)) {
    throw new Error(`Invalid action attribute: ${attribute}`)
  }
  return attribute === 'id' ? '[id]' : `[${attribute}]`
}

export function createUIEventsHelper(extensionId: string): FrontendUIEventsHelper {
  return {
    getKeyboardState,

    onKeyboardChange(handler) {
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
      const root = getOwnedTarget(extensionId, target)
      const attribute = options?.attribute?.trim() || 'id'
      const eventNames = options?.events?.length ? [...new Set(options.events)] : ['click']
      const actionSelector = getActionSelector(attribute)

      const listener = (originalEvent: Event) => {
        const origin = originalEvent.target
        if (!(origin instanceof Element)) return

        const actionElement = origin.closest(actionSelector)
        if (!(actionElement instanceof HTMLElement) || !root.contains(actionElement)) return

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
          root,
          originalEvent,
        })
      }

      for (const eventName of eventNames) {
        root.addEventListener(eventName, listener)
      }

      return () => {
        for (const eventName of eventNames) {
          root.removeEventListener(eventName, listener)
        }
      }
    },
  }
}
