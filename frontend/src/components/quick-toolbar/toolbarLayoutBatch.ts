export interface CoalescedLayoutScheduler {
  schedule: () => void
  cancel: () => void
}

export function createCoalescedLayoutScheduler(run: () => void): CoalescedLayoutScheduler {
  let frame = 0
  let cancelled = false

  const schedule = () => {
    if (cancelled || frame) return
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) as unknown as number
    frame = raf(() => {
      frame = 0
      if (!cancelled) run()
    })
  }

  const cancel = () => {
    cancelled = true
    if (!frame) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    else window.clearTimeout(frame)
    frame = 0
  }

  return { schedule, cancel }
}
