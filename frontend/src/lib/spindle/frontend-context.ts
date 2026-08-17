import type {
  SpindleDockPanelOptions as PublishedSpindleDockPanelOptions,
  SpindleFloatWidgetOptions as PublishedSpindleFloatWidgetOptions,
} from 'lumiverse-spindle-types'
import type {
  FrontendChatsAPI,
  FrontendConnectionsAPI,
  FrontendDomainAPI,
  FrontendMessagesAPI,
  FrontendTokensAPI,
  FrontendWorldBooksAPI,
} from './frontend-domain-api'
import type { StateSelectors } from './state-selectors'
import type { DecoratorOptions } from './dom-decorator-service'
import {
  createResizeController as createCoreResizeController,
  getUiScale as readUiScale,
  layoutElementRect as readLayoutElementRect,
  layoutViewportSize as readLayoutViewportSize,
  toLayoutPx as readToLayoutPx,
} from './zoom-layer-geometry'

export type SpindleGeometryHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface SpindleGeometryRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SpindleGeometryBounds {
  minWidth: number
  minHeight: number
  maxWidth?: number
  maxHeight?: number
}

export interface SpindleGeometryResizeOptions {
  handles?: readonly SpindleGeometryHandle[]
  bounds?: SpindleGeometryBounds
  aspectLock?: number
  snap?: { edges?: boolean; threshold?: number }
  onChange?(rect: SpindleGeometryRect): void
  onCommit?(rect: SpindleGeometryRect): void
}

export interface SpindleGeometryAPI {
  getUiScale(): number
  toLayoutPx(renderedPx: number): number
  layoutViewportSize(): { width: number; height: number }
  layoutElementRect(el: Element): SpindleGeometryRect
  createResizeController(el: HTMLElement, opts: SpindleGeometryResizeOptions): () => void
}

export type FrontendFloatWidgetOptions = PublishedSpindleFloatWidgetOptions & {
  resizable?: boolean
  bounds?: SpindleGeometryBounds
  aspectLock?: boolean | number
  persistGeometry?: string | false
  mobileClamp?: boolean
  onGeometryCommit?(rect: SpindleGeometryRect): void
}

export type FrontendDockPanelOptions = PublishedSpindleDockPanelOptions & {
  persistGeometry?: string | false
  respectRequestedEdge?: boolean
  onGeometryCommit?(rect: SpindleGeometryRect): void
}

const RESIZE_EDGE_BY_HANDLE: Record<SpindleGeometryHandle, 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'> = {
  n: 'top',
  s: 'bottom',
  e: 'right',
  w: 'left',
  ne: 'top-right',
  nw: 'top-left',
  se: 'bottom-right',
  sw: 'bottom-left',
}

function safeUiScale(): number {
  try {
    return readUiScale()
  } catch {
    return 1
  }
}

export function createFrontendGeometryAPI(): SpindleGeometryAPI {
  return {
    getUiScale: safeUiScale,
    toLayoutPx: (renderedPx) => readToLayoutPx(renderedPx, safeUiScale()),
    layoutViewportSize: () => readLayoutViewportSize(undefined, safeUiScale()),
    layoutElementRect: (element) => {
      const rect = readLayoutElementRect(element, safeUiScale())
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    },
    createResizeController(element, options) {
      const handle = options.handles?.[0] ?? 'se'
      const snap = options.snap?.edges
        ? { threshold: options.snap.threshold }
        : false
      const pointerElement = typeof element.querySelector === 'function'
        ? element.querySelector<HTMLElement>(`[data-resize-handle="${handle}"]`) ?? element
        : element
      return createCoreResizeController({
        element: pointerElement,
        edge: RESIZE_EDGE_BY_HANDLE[handle],
        getRect: () => readLayoutElementRect(element, safeUiScale()),
        minSize: options.bounds
          ? { width: options.bounds.minWidth, height: options.bounds.minHeight }
          : undefined,
        maxSize: options.bounds
          ? { width: options.bounds.maxWidth, height: options.bounds.maxHeight }
          : undefined,
        aspectLock: options.aspectLock,
        snap,
        uiScale: safeUiScale,
        onChange: options.onChange,
        onCommit: options.onCommit,
      })
    },
  }
}

export interface FrontendContextAdditions {
  ui: {
    geometry: SpindleGeometryAPI
    registerComponentOverride?: (options: {
      host: string
      mode: 'wrap' | 'replace'
      component: unknown
      priority?: number
    }) => { destroy(): void }
    registerDomDecorator?: (options: Omit<DecoratorOptions, 'owner' | 'generation'>) => () => void
  }
  state: StateSelectors
  connections: FrontendConnectionsAPI
  chats: FrontendChatsAPI
  worldBooks: FrontendWorldBooksAPI
  messages: FrontendMessagesAPI
  tokens: FrontendTokensAPI
  onTeardown(handler: () => void): () => void
}

export interface FrontendContextFactoryDependencies<Base extends object> {
  base: Base
  state: StateSelectors
  domain: FrontendDomainAPI
  geometry?: SpindleGeometryAPI
  onTeardown(handler: () => void): () => void
}

/**
 * Composes the domain/state additions onto the already-built host context.
 * Keeping the composition generic lets the package type update land separately
 * from the production loader and keeps this bridge directly unit-testable.
 */
export function createFrontendExtensionContext<Base extends {
  chats: object
  messages: object
}>(
  dependencies: FrontendContextFactoryDependencies<Base>,
): Base & FrontendContextAdditions {
  const { base, domain } = dependencies
  return {
    ...base,
    ui: {
      ...((base as Base & { ui?: object }).ui ?? {}),
      geometry: dependencies.geometry ?? createFrontendGeometryAPI(),
    },
    state: dependencies.state,
    connections: domain.connections,
    chats: {
      ...base.chats,
      ...domain.chats,
    },
    worldBooks: domain.worldBooks,
    messages: {
      ...base.messages,
      ...domain.messages,
    },
    tokens: domain.tokens,
    onTeardown: dependencies.onTeardown,
  } as Base & FrontendContextAdditions
}
