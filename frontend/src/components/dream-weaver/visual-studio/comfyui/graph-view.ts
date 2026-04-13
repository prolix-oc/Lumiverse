export interface GraphBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface GraphViewport {
  x: number
  y: number
  scale: number
}

interface PositionedNode {
  x: number
  y: number
  width: number
  height: number
}

const MIN_SCALE = 0.35
const MAX_SCALE = 1.8
const DEFAULT_PADDING = 48

export function clampGraphScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

export function getGraphBounds(nodes: PositionedNode[]): GraphBounds {
  if (nodes.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    }
  }

  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export function resetViewport(
  bounds: GraphBounds,
  padding = DEFAULT_PADDING,
): GraphViewport {
  return {
    x: padding - bounds.minX,
    y: padding - bounds.minY,
    scale: 1,
  }
}

export function fitViewportToBounds(
  bounds: GraphBounds,
  viewportWidth: number,
  viewportHeight: number,
  padding = DEFAULT_PADDING,
): GraphViewport {
  if (bounds.width <= 0 || bounds.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return {
      x: padding,
      y: padding,
      scale: 1,
    }
  }

  const availableWidth = Math.max(viewportWidth - padding * 2, viewportWidth * 0.4)
  const availableHeight = Math.max(viewportHeight - padding * 2, viewportHeight * 0.4)
  const scale = clampGraphScale(Math.min(
    availableWidth / bounds.width,
    availableHeight / bounds.height,
    1,
  ))

  const scaledWidth = bounds.width * scale
  const scaledHeight = bounds.height * scale

  return {
    x: (viewportWidth - scaledWidth) / 2 - bounds.minX * scale,
    y: (viewportHeight - scaledHeight) / 2 - bounds.minY * scale,
    scale,
  }
}

export function screenToWorld(
  point: { x: number; y: number },
  viewport: GraphViewport,
) {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  }
}

export function zoomViewportAtPoint(
  viewport: GraphViewport,
  nextScale: number,
  anchor: { x: number; y: number },
): GraphViewport {
  const scale = clampGraphScale(nextScale)
  if (scale === viewport.scale) return viewport

  const worldPoint = screenToWorld(anchor, viewport)

  return {
    x: anchor.x - worldPoint.x * scale,
    y: anchor.y - worldPoint.y * scale,
    scale,
  }
}

export function panViewport(
  viewport: GraphViewport,
  deltaX: number,
  deltaY: number,
): GraphViewport {
  return {
    ...viewport,
    x: viewport.x + deltaX,
    y: viewport.y + deltaY,
  }
}
