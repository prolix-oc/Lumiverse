export const CUSTOM_CSS_DOCK_BREAKPOINT = 920
export const CUSTOM_CSS_DOCK_DEFAULT_SIZE = 640
export const CUSTOM_CSS_DOCK_MIN_SIZE = 560
export const CUSTOM_CSS_DOCK_MAX_SIZE = 960
export const CUSTOM_CSS_DOCK_MIN_APP_WIDTH = 360

export function clampCustomCSSDockSize(size: number, viewportWidth: number): number {
  const viewportMax = Math.max(
    CUSTOM_CSS_DOCK_MIN_SIZE,
    viewportWidth - CUSTOM_CSS_DOCK_MIN_APP_WIDTH,
  )

  return Math.min(
    Math.max(size, CUSTOM_CSS_DOCK_MIN_SIZE),
    Math.min(CUSTOM_CSS_DOCK_MAX_SIZE, viewportMax),
  )
}