/** Fired after the shared viewport CSS variables have committed. */
export const KEYBOARD_VIEWPORT_EVENT = 'lumiverse:keyboard-viewport'

/** Use the same visible bounds for caret scrolling and layout. Standalone iOS
 * suppresses page panning, so its raw offsetTop can be stale after focus/blur. */
export function getKeyboardViewport(): { top: number; bottom: number } {
  const viewport = window.visualViewport
  const root = document.documentElement
  if (root.matches('[data-tauri-mobile="ios"], [data-ios-pwa]') && Math.abs((viewport?.scale ?? 1) - 1) <= 0.01) {
    const style = window.getComputedStyle(root)
    const heightValue = style.getPropertyValue('--app-visual-viewport-height').trim()
    const height = parseFloat(heightValue)
    const top = parseFloat(style.getPropertyValue('--app-visual-viewport-offset-top')) || 0
    if (heightValue.endsWith('px') && Number.isFinite(height)) return { top, bottom: top + height }
  }
  const top = viewport?.offsetTop ?? 0
  return { top, bottom: top + (viewport?.height ?? window.innerHeight) }
}
