/** Layout geometry exposed to frontend extensions as a pure, free API. */
export interface SpindleGeometryRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SpindleGeometrySize {
  width: number
  height: number
}

export type SpindleGeometryResizeHandle =
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw'

export interface SpindleGeometryResizeBounds {
  minWidth: number
  minHeight: number
  maxWidth?: number
  maxHeight?: number
}

export interface SpindleGeometrySnapOptions {
  edges?: boolean
  threshold?: number
}

export interface SpindleGeometryResizeOptions {
  handles?: SpindleGeometryResizeHandle[]
  bounds?: SpindleGeometryResizeBounds
  aspectLock?: number
  snap?: SpindleGeometrySnapOptions
  onChange?(rect: SpindleGeometryRect): void
  onCommit?(rect: SpindleGeometryRect): void
}

/** Pure scale, measurement, and resize-controller helpers for extension UI. */
export interface SpindleGeometryAPI {
  getUiScale(): number
  toLayoutPx(renderedPx: number): number
  layoutViewportSize(): SpindleGeometrySize
  layoutElementRect(element: Element): SpindleGeometryRect
  createResizeController(
    element: HTMLElement,
    options: SpindleGeometryResizeOptions,
  ): () => void
}
