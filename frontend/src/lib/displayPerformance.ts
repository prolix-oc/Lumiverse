export interface DisplayPerformanceSnapshot {
  surface: 'application' | 'desktop-widget'
  capturedAt: number
  longFrames: { count: number; totalDuration: number; maxDuration: number; totalBlockingDuration: number }
  longTasks: { count: number; totalDuration: number; maxDuration: number }
  interactions: { count: number; maxDuration: number }
  milestones: Record<string, number>
  apiReads: Record<string, { count: number; failed: number; totalDuration: number; inFlight: number }>
}

interface DisplayPerformanceDiagnostics {
  snapshot(): DisplayPerformanceSnapshot
  reset(): void
}

declare global {
  interface Window {
    __lumiverseDisplayPerformance?: DisplayPerformanceDiagnostics
  }
}

let installed = false
let activeSurface: DisplayPerformanceSnapshot['surface'] = 'application'
let longFrames = { count: 0, totalDuration: 0, maxDuration: 0, totalBlockingDuration: 0 }
let longTasks = { count: 0, totalDuration: 0, maxDuration: 0 }
let interactions = { count: 0, maxDuration: 0 }
const milestones: Record<string, number> = {}
const apiReads: DisplayPerformanceSnapshot['apiReads'] = Object.create(null)

export function beginApiRead(path: string): (failed: boolean) => void {
  const resource = path.split(/[/?#]/)[1] || 'root'
  const key = Object.hasOwn(apiReads, resource) || Object.keys(apiReads).length < 40 ? resource : 'other'
  const record = apiReads[key] ??= { count: 0, failed: 0, totalDuration: 0, inFlight: 0 }
  const started = performance.now()
  record.count += 1
  record.inFlight += 1
  let finished = false
  return failed => {
    if (finished) return
    finished = true
    record.inFlight -= 1
    record.failed += Number(failed)
    record.totalDuration += performance.now() - started
  }
}

function reset(): void {
  longFrames = { count: 0, totalDuration: 0, maxDuration: 0, totalBlockingDuration: 0 }
  longTasks = { count: 0, totalDuration: 0, maxDuration: 0 }
  interactions = { count: 0, maxDuration: 0 }
  for (const key of Object.keys(milestones)) delete milestones[key]
  for (const key of Object.keys(apiReads)) delete apiReads[key]
}

export function getDisplayPerformanceSnapshot(): DisplayPerformanceSnapshot {
  return {
    surface: activeSurface,
    capturedAt: performance.now(),
    longFrames: { ...longFrames },
    longTasks: { ...longTasks },
    interactions: { ...interactions },
    milestones: { ...milestones },
    apiReads: structuredClone(apiReads),
  }
}

function observe(type: string, onEntries: (entries: PerformanceEntry[]) => void, extra: object = {}): void {
  if (typeof PerformanceObserver === 'undefined') return
  if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return
  try {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()))
    observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
  } catch {
    // Performance entry support differs across WKWebView, WebView2 and browsers.
  }
}

export function markDisplayMilestone(name: string): void {
  if (typeof performance === 'undefined') return
  const at = performance.now()
  milestones[name] = at
  performance.mark(`lumiverse:${name}`)
}

export function markDisplayInteractive(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => markDisplayMilestone('interactive'))
  })
}

export function installDisplayPerformanceTelemetry(surface: DisplayPerformanceSnapshot['surface']): void {
  activeSurface = surface
  if (installed) return
  installed = true
  markDisplayMilestone('bootstrap')
  // Navigation timing starts before the initial static module graph evaluates.
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (navigation) {
    milestones.navigationStart = navigation.startTime
    milestones.documentResponseEnd = navigation.responseEnd
  }

  observe('long-animation-frame', (entries) => {
    for (const entry of entries) {
      const blockingDuration = Number((entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration) || 0
      longFrames.count += 1
      longFrames.totalDuration += entry.duration
      longFrames.maxDuration = Math.max(longFrames.maxDuration, entry.duration)
      longFrames.totalBlockingDuration += blockingDuration
    }
  })

  // LoAF is not implemented in every embedded engine yet. Long Tasks gives
  // those runtimes a coarser main-thread signal without double-counting.
  if (
    typeof PerformanceObserver !== 'undefined'
    && !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
  ) {
    observe('longtask', (entries) => {
      for (const entry of entries) {
        longTasks.count += 1
        longTasks.totalDuration += entry.duration
        longTasks.maxDuration = Math.max(longTasks.maxDuration, entry.duration)
      }
    })
  }

  observe('event', (entries) => {
    for (const entry of entries) {
      const interactionId = Number((entry as PerformanceEntry & { interactionId?: number }).interactionId) || 0
      if (!interactionId) continue
      interactions.count += 1
      interactions.maxDuration = Math.max(interactions.maxDuration, entry.duration)
    }
  }, { durationThreshold: 40 })

  window.__lumiverseDisplayPerformance = { snapshot: getDisplayPerformanceSnapshot, reset }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return
    window.dispatchEvent(new CustomEvent('lumiverse:display-performance', {
      detail: getDisplayPerformanceSnapshot(),
    }))
  })
}
