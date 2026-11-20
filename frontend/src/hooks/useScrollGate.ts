import { useEffect, type RefObject } from 'react'

/**
 * Sets `data-scrolling` on a scroll container while the user is actively
 * scrolling.  Pair with CSS like:
 *
 *   [data-scrolling] .card { pointer-events: none; }
 *
 * to suppress hover effects (and the GPU work they cause) during scroll.
 */
export function useScrollGate(ref: RefObject<HTMLElement | null>, delayMs = 150) {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    let timer: ReturnType<typeof setTimeout>

    const onScroll = () => {
      if (!el.hasAttribute('data-scrolling')) {
        el.setAttribute('data-scrolling', '')
      }
      clearTimeout(timer)
      timer = setTimeout(() => {
        el.removeAttribute('data-scrolling')
      }, delayMs)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
      el.removeAttribute('data-scrolling')
    }
  }, [ref, delayMs])
}
