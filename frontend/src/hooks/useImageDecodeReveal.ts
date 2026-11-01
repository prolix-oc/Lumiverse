import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Reveal only this mounted image, with a painted hidden frame before the fade. */
export function useImageDecodeReveal(src: string | undefined, element: RefObject<HTMLImageElement | null>) {
  const [readySrc, setReadySrc] = useState<string | null>(null)
  const generation = useRef(0)
  const frame = useRef<number | null>(null)
  const cancel = useCallback(() => {
    generation.current++
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])

  useLayoutEffect(() => {
    cancel()
    setReadySrc(null)
    return cancel
  }, [src, cancel])

  const reveal = useCallback((image: HTMLImageElement, decoded?: () => void) => {
    cancel()
    const ticket = generation.current
    const current = () => Boolean(src && element.current === image
      && generation.current === ticket && image.getAttribute('src') === src)
    if (!current()) return
    // A load event already established a usable image. Some browsers reject
    // decode() for animated images; retain that loaded-image fallback.
    const decode = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
    void decode.catch(() => {}).then(() => {
      if (!current()) return
      decoded?.()
      // Two frames keep memory/disk hits from jumping straight to opacity 1
      // before the browser has painted the initial opacity 0 state.
      frame.current = window.requestAnimationFrame(() => {
        if (!current()) return
        frame.current = window.requestAnimationFrame(() => {
          frame.current = null
          if (current()) setReadySrc(src!)
        })
      })
    })
  }, [src, element, cancel])

  return { ready: Boolean(src && readySrc === src), reveal, cancel }
}
