/** Measure keyboard clearance throughout the composer's CSS movement. */
export function observeComposerMotion(element: HTMLElement, measure: () => void): () => void {
  const view = element.ownerDocument.defaultView!
  const active = new Set<string>()
  let frame = 0
  const relevant = (event: TransitionEvent) => event.target === element &&
    (event.propertyName === 'bottom' || event.propertyName === 'padding-bottom')
  const tick = () => {
    frame = 0
    measure()
    if (active.size) frame = view.requestAnimationFrame(tick)
  }
  const start = (event: TransitionEvent) => {
    if (!relevant(event)) return
    active.add(event.propertyName)
    if (!frame) frame = view.requestAnimationFrame(tick)
  }
  const finish = (event: TransitionEvent) => {
    if (!relevant(event)) return
    active.delete(event.propertyName)
    measure()
    if (!active.size && frame) {
      view.cancelAnimationFrame(frame)
      frame = 0
    }
  }

  element.addEventListener('transitionrun', start)
  element.addEventListener('transitionend', finish)
  element.addEventListener('transitioncancel', finish)
  return () => {
    if (frame) view.cancelAnimationFrame(frame)
    active.clear()
    element.removeEventListener('transitionrun', start)
    element.removeEventListener('transitionend', finish)
    element.removeEventListener('transitioncancel', finish)
  }
}
