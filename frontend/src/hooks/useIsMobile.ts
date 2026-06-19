import { useState, useEffect } from 'react'

const DEFAULT_BREAKPOINT = 600

const pointerQuery = typeof window !== 'undefined'
  ? window.matchMedia('(pointer: coarse)')
  : null

function check(breakpoint: number) {
  if (typeof window === 'undefined') return false
  // pointer: coarse catches touch devices even when browser zoom inflates
  return pointerQuery?.matches || window.innerWidth <= breakpoint
}

export default function useIsMobile(breakpoint = DEFAULT_BREAKPOINT) {
  const [isMobile, setIsMobile] = useState(() => check(breakpoint))

  useEffect(() => {
    const update = () => {
      const next = check(breakpoint)
      setIsMobile((prev) => (prev !== next ? next : prev))
    }

    window.addEventListener('resize', update)
    pointerQuery?.addEventListener('change', update)
    return () => {
      window.removeEventListener('resize', update)
      pointerQuery?.removeEventListener('change', update)
    }
  }, [breakpoint])

  return isMobile
}
