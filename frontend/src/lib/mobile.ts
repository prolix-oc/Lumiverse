export const MOBILE_VIEWPORT_BREAKPOINT = 600

/** Keep responsive behavior and coarse-pointer devices on one mobile definition. */
export function isMobileViewportOrDevice(breakpoint = MOBILE_VIEWPORT_BREAKPOINT): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(pointer: coarse)').matches === true || window.innerWidth <= breakpoint
}
