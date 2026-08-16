import { describe, expect, test } from 'bun:test'
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { FrontendExtensionContext } from './loader'
import type {
  FrontendDockPanelOptions,
  FrontendFloatWidgetOptions,
} from './frontend-context'
import type {
  SpindleGeometryAPI,
  SpindleGeometryRect,
  SpindleGeometryResizeOptions,
} from './geometry-api'
import { normalizeQuickToolbarPlacement } from '@/components/quick-toolbar/quickToolbarDock'

type GeometryContext = Omit<SpindleFrontendContext, 'ui'> & {
  ui: SpindleFrontendContext['ui'] & { geometry: SpindleGeometryAPI }
}

const geometryMethods = [
  'getUiScale',
  'toLayoutPx',
  'layoutViewportSize',
  'layoutElementRect',
  'createResizeController',
] as const satisfies readonly (keyof SpindleGeometryAPI)[]

const geometryContract = (context: GeometryContext): SpindleGeometryAPI => context.ui.geometry

type PublishedContextCompatibility = FrontendExtensionContext extends SpindleFrontendContext ? true : false
const publishedContextCompatibility: PublishedContextCompatibility = true

function consumeH6Context(context: FrontendExtensionContext): void {
  const geometry: SpindleGeometryAPI = context.ui.geometry
  const rect: SpindleGeometryRect = geometry.layoutElementRect(document.body)
  const resizeOptions: SpindleGeometryResizeOptions = {
    handles: ['se'],
    bounds: { minWidth: 160, minHeight: 90, maxWidth: 640, maxHeight: 360 },
    aspectLock: 16 / 9,
    snap: { edges: true, threshold: 8 },
    onChange: next => { void next.width },
    onCommit: next => { void next.height },
  }
  const floatOptions: FrontendFloatWidgetOptions = {
    width: rect.width,
    height: rect.height,
    resizable: true,
    bounds: resizeOptions.bounds,
    aspectLock: resizeOptions.aspectLock,
    persistGeometry: 'h6-consumer',
    mobileClamp: true,
    onGeometryCommit: next => { void next.x },
  }
  const dockOptions: FrontendDockPanelOptions = {
    edge: 'right',
    title: 'H6 consumer',
    size: 320,
    minSize: 180,
    maxSize: 640,
    resizable: true,
    respectRequestedEdge: true,
    persistGeometry: 'h6-consumer',
    onGeometryCommit: next => { void next.width },
  }
  void publishedContextCompatibility
  void resizeOptions
  void context.ui.createFloatWidget(floatOptions)
  void context.ui.requestDockPanel(dockOptions)
}

describe('H6 geometry declaration', () => {
  test('keeps the public geometry method set explicit', () => {
    expect(geometryMethods).toEqual([
      'getUiScale',
      'toLayoutPx',
      'layoutViewportSize',
      'layoutElementRect',
      'createResizeController',
    ])
  })

  test('accepts layout rectangles and resize options without UI coupling', () => {
    const rect: SpindleGeometryRect = { x: 0, y: 0, width: 320, height: 180 }
    const options: SpindleGeometryResizeOptions = {
      handles: ['se'],
      bounds: { minWidth: 160, minHeight: 90 },
      aspectLock: 16 / 9,
      snap: { edges: true, threshold: 8 },
      onChange: next => expect(next.width).toBeGreaterThan(0),
      onCommit: next => expect(next.height).toBeGreaterThan(0),
    }
    expect(rect.width).toBe(320)
    expect(options.handles).toEqual(['se'])
  })

  test('type-checks the additive context surface', () => {
    expect(typeof geometryContract).toBe('function')
  })

  test('type-checks the exact loader consumer shape against the installed package base', () => {
    expect(typeof consumeH6Context).toBe('function')
    expect(publishedContextCompatibility).toBe(true)
  })

  test('normalizes quickToolbarPlacement migration and default', () => {
    expect(normalizeQuickToolbarPlacement(undefined)).toBe('floating')
    expect(normalizeQuickToolbarPlacement(null)).toBe('floating')
    expect(normalizeQuickToolbarPlacement('legacy')).toBe('floating')
    expect(normalizeQuickToolbarPlacement('invalid')).toBe('floating')
    expect(normalizeQuickToolbarPlacement('floating')).toBe('floating')
    expect(normalizeQuickToolbarPlacement('chat_top_dock')).toBe('chat_top_dock')
  })
})
