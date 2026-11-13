import { cubicBezier } from 'motion'

type Direction = 'enter' | 'leave'

const parts = [
  { selector: '[data-component="MessageList"]', y: 6, duration: 220 },
  { selector: '[data-component="InputArea"], [data-component="MessageSelectBar"]', y: 10, duration: 180 },
  { selector: '[data-component="ChatFindBar"], [data-spindle-mount="chat_top_dock"]', y: -8, duration: 180 },
] as const

// Recovery for backgrounded documents or an animation that never completes.
// Normal navigation follows playback completion, not a click-based timer.
const COMPLETION_TIMEOUT_MS = 1500
const ease = cubicBezier(.25, .1, .25, 1)

/** Start playback after the committed view has had a paint opportunity. */
export function playChatChromeMotion(
  root: HTMLElement | null,
  direction: Direction,
  onComplete: () => void = () => {},
): () => void {
  const view = root?.ownerDocument.defaultView
  const reducedMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  const shell = view?.document.documentElement
  // iOS can advance native animation time without presenting visible motion.
  // Update styles on each frame to bypass that presentation path.
  const driver = shell?.getAttribute('data-tauri-mobile') === 'ios' || shell?.hasAttribute('data-ios-pwa')
    ? 'style-frames' : 'web-animations'
  if (!root || !view || reducedMotion) {
    onComplete()
    return () => {}
  }

  const targets = parts.flatMap(({ selector, y, duration }) =>
    [...root.querySelectorAll<HTMLElement>(selector)].map((element) => ({
      element, duration, y,
      hidden: { opacity: '0', transform: `translateY(${y}px)` },
      visible: { opacity: '1', transform: 'none' },
      previous: ['transition', 'opacity', 'transform'].map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })),
    })),
  )
  if (!targets.length) {
    onComplete()
    return () => {}
  }

  let disposed = false
  let firstFrame = 0
  let secondFrame = 0
  let playbackFrame = 0
  const animations: Animation[] = []
  const completions: Promise<void>[] = []
  const cleanup = () => {
    view.clearTimeout(timeout)
    view.cancelAnimationFrame(firstFrame)
    view.cancelAnimationFrame(secondFrame)
    view.cancelAnimationFrame(playbackFrame)
    for (const animation of animations) animation.cancel()
    for (const { element, previous } of targets) {
      // Restore the underlying state before restoring transitions, so cleanup
      // cannot create a second transition from an animation's holding styles.
      for (const { property, value, priority } of [...previous].reverse()) {
        if (value) element.style.setProperty(property, value, priority)
        else element.style.removeProperty(property)
      }
    }
  }
  const finish = () => {
    if (disposed) return
    disposed = true
    cleanup()
    onComplete()
  }
  const timeout = view.setTimeout(finish, COMPLETION_TIMEOUT_MS)

  for (const target of targets) {
    // CSS transitions outrank Web Animations. Suppress them while these
    // explicit keyframes own the same properties; retain no layer hint.
    target.element.style.setProperty('transition', 'none')
    Object.assign(target.element.style, direction === 'enter' ? target.hidden : target.visible)
  }

  const startStyleFrames = (startedAt: number) => {
    const states = targets.map(target => ({ ...target, finished: false }))
    // Commit the staged starting styles before iOS presents the first frame.
    for (const { element } of states) void element.offsetHeight
    const render = (now: number) => {
      if (disposed) return
      const elapsed = Math.max(0, now - startedAt)
      for (const state of states) {
        if (state.finished) continue
        const time = Math.min(elapsed, state.duration)
        const progress = ease(time / state.duration)
        const opacity = direction === 'enter' ? progress : 1 - progress
        Object.assign(state.element.style, time === state.duration
          ? direction === 'enter' ? state.visible : state.hidden
          : { opacity: String(opacity), transform: `translateY(${state.y * (1 - opacity)}px)` })
        state.finished = time === state.duration
      }
      // Give the last style write a paint opportunity before restoring styles
      // or navigating away. Cancellation owns this final frame as well.
      const finished = states.every(state => state.finished)
      playbackFrame = view.requestAnimationFrame(finished
        ? finish : render)
    }
    playbackFrame = view.requestAnimationFrame(render)
  }

  firstFrame = view.requestAnimationFrame(() => {
    secondFrame = view.requestAnimationFrame((now) => {
      if (disposed) return
      if (driver === 'style-frames') {
        startStyleFrames(now)
        return
      }
      for (const { element, hidden, visible, duration } of targets) {
        if (typeof element.animate !== 'function') continue
        try {
          const animation = element.animate(
            direction === 'enter' ? [hidden, visible] : [visible, hidden],
            { duration, easing: 'ease', fill: 'both' },
          )
          animations.push(animation)
          completions.push(animation.finished.then(() => {}, () => {}))
          // Keep the underlying style at the destination while the animation
          // supplies intermediate values. Otherwise cancelling the finished
          // effect can make WebKit transition from the old holding value again.
          Object.assign(element.style, direction === 'enter' ? visible : hidden)
        } catch {
          // An unavailable animation engine must not trap navigation.
        }
      }
      if (!animations.length) {
        finish()
        return
      }
      void Promise.all(completions).then(finish)
    })
  })

  return () => {
    if (disposed) return
    disposed = true
    cleanup()
  }
}
