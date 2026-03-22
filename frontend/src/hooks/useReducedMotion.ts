import { useState, useEffect } from 'react'

export function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion((prev) =>
      prev !== mediaQuery.matches ? mediaQuery.matches : prev
    )

    const handler = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion((prev) => (prev !== e.matches ? e.matches : prev))
    }
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  return prefersReducedMotion
}

export function getAnimationProps(
  reducedMotion: boolean,
  normalProps: Record<string, any>,
  reducedProps: Record<string, any> = {}
) {
  if (reducedMotion) {
    return {
      initial: false,
      animate: {},
      exit: {},
      transition: { duration: 0 },
      ...reducedProps,
    }
  }
  return normalProps
}
