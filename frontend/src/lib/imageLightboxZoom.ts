export interface ImageLightboxZoom {
  scale: number
  x: number
  y: number
}

export interface ImageLightboxBounds {
  imageWidth: number
  imageHeight: number
  viewportWidth: number
  viewportHeight: number
}

export interface ImageLightboxPoint {
  x: number
  y: number
}

export const INITIAL_IMAGE_LIGHTBOX_ZOOM: ImageLightboxZoom = { scale: 1, x: 0, y: 0 }

export function constrainImageLightboxZoom(
  zoom: ImageLightboxZoom,
  bounds: ImageLightboxBounds,
): ImageLightboxZoom {
  const scale = Math.min(4, Math.max(1, zoom.scale))
  if (scale === 1) return INITIAL_IMAGE_LIGHTBOX_ZOOM

  const maxX = Math.max(0, (bounds.imageWidth * scale - bounds.viewportWidth) / 2)
  const maxY = Math.max(0, (bounds.imageHeight * scale - bounds.viewportHeight) / 2)
  return {
    scale,
    x: Math.max(-maxX, Math.min(maxX, zoom.x)),
    y: Math.max(-maxY, Math.min(maxY, zoom.y)),
  }
}

export function pinchImageLightboxZoom(
  startZoom: ImageLightboxZoom,
  startDistance: number,
  distance: number,
  startPoint: ImageLightboxPoint,
  point: ImageLightboxPoint,
  bounds: ImageLightboxBounds,
): ImageLightboxZoom {
  if (startDistance <= 0) return startZoom
  const scale = Math.min(4, Math.max(1, startZoom.scale * distance / startDistance))
  const ratio = scale / startZoom.scale
  return constrainImageLightboxZoom({
    scale,
    x: point.x - (startPoint.x - startZoom.x) * ratio,
    y: point.y - (startPoint.y - startZoom.y) * ratio,
  }, bounds)
}
