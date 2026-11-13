/** Read a finite numeric CSS custom property in layout space. */
export function readLayoutVar(
  element: Element | null | undefined,
  name: string,
  fallback: number,
): number {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return fallback
  const value = window.getComputedStyle(element).getPropertyValue(name).trim()
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
