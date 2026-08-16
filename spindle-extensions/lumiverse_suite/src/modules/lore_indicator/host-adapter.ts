import type { SuiteHostContext } from '../../suite'
import type { LoreGeometryPort, LoreFloatPort, LoreOverlayPort } from './variants'
import { clearLoreIndicatorNodes, markLoreIndicatorNode } from './mounts'
import { asMount, readExtensionInstallationId } from '../../shared/public-sdk'

type Dispose = () => void

const EXTENSION_ROOT_ATTRIBUTE = 'data-spindle-extension-root'

export interface LoreDrawerRegistration {
  readonly root: HTMLElement
  destroy(): void
}

export interface LoreSettingsRegistration {
  readonly root: HTMLElement
  destroy(): void
}

export interface LoreFloatRegistration extends LoreFloatPort {
  destroy(): void
}

export interface LoreOverlayRegistration extends LoreOverlayPort {
  destroy(): void
}

export interface LoreHostAdapter {
  mount(point: string): HTMLElement
  registerDrawerTab(): LoreDrawerRegistration
  registerSettingsTab(): LoreSettingsRegistration
  createFloat(): LoreFloatRegistration | undefined
  createOverlay(): LoreOverlayRegistration
  subscribeActivation(listener: (payload: unknown) => void): Dispose
  openLorebook(): void
  geometry: LoreGeometryPort
}

function elementFrom(value: unknown): HTMLElement | undefined {
  if (value instanceof HTMLElement) return value
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { root?: unknown; element?: unknown }
  if (candidate.root instanceof HTMLElement) return candidate.root
  if (candidate.element instanceof HTMLElement) return candidate.element
  return undefined
}

function destroyHandle(handle: { destroy?: () => void; dispose?: () => void } | undefined): void {
  try {
    handle?.destroy?.()
  } finally {
    handle?.dispose?.()
  }
}

function markOwnedNode(node: HTMLElement, extensionUuid: string | undefined, variant: string): HTMLElement {
  if (!extensionUuid) throw new Error('LORE_INDICATOR_EXTENSION_UUID_UNAVAILABLE')
  markLoreIndicatorNode(node, variant)
  node.setAttribute(EXTENSION_ROOT_ATTRIBUTE, extensionUuid)
  node.setAttribute('data-spindle-ext', extensionUuid)
  return node
}

type V2Geometry = {
  layoutViewportSize?(): { width: number; height: number }
  toLayoutPx?(value: number): number
  layoutElementRect?(element: Element): { x?: number; y?: number; width?: number; height?: number } | null
}

function safeMount(ctx: SuiteHostContext, point: string): HTMLElement {
  const mounted = ctx.ui.mount(asMount(point))
  if (mounted instanceof HTMLElement) return mounted
  throw new Error('LORE_INDICATOR_MOUNT_UNAVAILABLE')
}

function geometryFor(ctx: SuiteHostContext): LoreGeometryPort {
  const geometry = ctx.ui.geometry as V2Geometry | undefined
  const viewport = () => geometry?.layoutViewportSize?.() ?? { width: 1280, height: 800 }
  const rect = (element: Element) => {
    try {
      const measured = geometry?.layoutElementRect?.(element)
      const x = typeof measured?.x === 'number' ? measured.x : 0
      const y = typeof measured?.y === 'number' ? measured.y : 0
      const width = typeof measured?.width === 'number' ? measured.width : 72
      const height = typeof measured?.height === 'number' ? measured.height : 32
      return { x, y, width, height }
    } catch {
      return { x: 0, y: 0, width: 72, height: 32 }
    }
  }
  const toLayoutPx = (value: number) => geometry?.toLayoutPx?.(value) ?? value
  return {
    layoutViewportSize: viewport,
    layoutElementRect(element) {
      return rect(element)
    },
    layoutElementSize(element, fallback) {
      try {
        const measured = rect(element)
        return { width: measured.width, height: measured.height }
      } catch {
        return fallback
      }
    },
    readPointer(event) {
      const { clientX, clientY } = event
      return { x: toLayoutPx(clientX), y: toLayoutPx(clientY) }
    },
  }
}

export function createLoreHostAdapter(ctx: SuiteHostContext): LoreHostAdapter {
  const extensionUuid = readExtensionInstallationId(ctx)
  const geometry = geometryFor(ctx)

  return {
    mount(point) {
      return safeMount(ctx, point)
    },
    registerDrawerTab() {
      const handle = ctx.ui.registerDrawerTab({
        id: 'activated-lore',
        title: 'Activated lore',
        shortName: 'Lore',
        description: 'Activated lore from the latest generation',
        keywords: ['lore', 'activated', 'world info'],
      })
      markOwnedNode(handle.root, extensionUuid, 'drawer')
      return {
        root: handle.root,
        destroy() {
          clearLoreIndicatorNodes(handle.root, extensionUuid)
          handle.destroy()
        },
      }
    },
    registerSettingsTab() {
      const handle = ctx.ui.registerSettingsTab?.({
        id: 'productivity',
        title: 'UI Productivity',
      })
      if (!handle) throw new Error('LORE_INDICATOR_SETTINGS_TAB_UNAVAILABLE')
      markOwnedNode(handle.root, extensionUuid, 'settings')
      return {
        root: handle.root,
        destroy() {
          clearLoreIndicatorNodes(handle.root, extensionUuid)
          handle.destroy()
        },
      }
    },
    createFloat() {
      let handle: ReturnType<SuiteHostContext['ui']['createFloatWidget']> | undefined
      try {
        handle = ctx.ui.createFloatWidget({
          id: 'activated-lore',
          title: 'Activated lore',
        } as Parameters<SuiteHostContext['ui']['createFloatWidget']>[0])
      } catch {
        handle = undefined
      }
      const root = elementFrom(handle)
      if (!root || !handle) return undefined
      markOwnedNode(root, extensionUuid, 'v2-compact')
      return {
        root,
        getPosition: () => ({ x: 24, y: 24 }),
        moveTo: () => undefined,
        setSize: () => undefined,
        onDragEnd: () => () => undefined,
        destroy: () => {
          clearLoreIndicatorNodes(root, extensionUuid)
          destroyHandle(handle)
        },
      }
    },
    createOverlay() {
      const handle = ctx.ui.mountApp({ position: 'app-overlay' })
      markOwnedNode(handle.root, extensionUuid, 'v5-command-palette')
      return {
        root: handle.root,
        setVisible: visible => {
          handle.root.hidden = !visible
        },
        destroy: () => {
          clearLoreIndicatorNodes(handle.root, extensionUuid)
          handle.destroy()
        },
      }
    },
    subscribeActivation(listener) {
      return ctx.events.on('WORLD_INFO_ACTIVATED', listener)
    },
    openLorebook() {
      try {
        ctx.ui.requestTabLocation('lorebook', ctx.ui.getTabLocation('lorebook'))
      } catch {
        // Navigation is optional; the indicator remains usable without it.
      }
    },
    geometry,
  }
}
