/**
 * A tiny persistent timeline for diagnosing standalone-PWA restarts. Console
 * output disappears when WebKit kills or reloads the web-content process, so
 * this deliberately uses synchronous localStorage and is read from Settings →
 * Diagnostics after the app comes back.
 *
 * The records contain only lifecycle/browser state — never page content, chat
 * IDs, request URLs, or error stacks.
 */
const STORAGE_KEY = 'lumiverse:pwa-lifecycle:v1'
const MAX_ENTRIES = 32

type DiagnosticValue = string | number | boolean | null

export type PwaLifecycleEntry = {
  at: string
  event: string
  session: string
  data: Record<string, DiagnosticValue>
}

type StoredDiagnostics = {
  version: 1
  entries: PwaLifecycleEntry[]
}

function isStandalonePwa(): boolean {
  const legacyStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return legacyStandalone
    || window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.matchMedia?.('(display-mode: window-controls-overlay)').matches === true
}

function makeSessionId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function readStoredDiagnostics(): StoredDiagnostics {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, entries: [] }
    const parsed = JSON.parse(raw) as Partial<StoredDiagnostics>
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] }
    return {
      version: 1,
      entries: parsed.entries.filter((entry): entry is PwaLifecycleEntry => (
        Boolean(entry)
        && typeof entry.at === 'string'
        && typeof entry.event === 'string'
        && typeof entry.session === 'string'
        && typeof entry.data === 'object'
        && entry.data !== null
      )).slice(-MAX_ENTRIES),
    }
  } catch {
    return { version: 1, entries: [] }
  }
}

function writeStoredDiagnostics(value: StoredDiagnostics): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Private browsing or a full quota must never affect app startup.
  }
}

function navigationType(): string | null {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return entry?.type ?? null
  } catch {
    return null
  }
}

function browserState(): Record<string, DiagnosticValue> {
  return {
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    navigation: navigationType(),
    serviceWorkerController: navigator.serviceWorker?.controller?.scriptURL ?? null,
  }
}

function isExpectedTerminalEvent(event: string | undefined): boolean {
  return event === 'beforeunload' || event === 'pagehide' || event === 'unload'
}

/** Read the durable timeline for inclusion in a user-initiated diagnostics report. */
export function getPwaLifecycleDiagnostics(): PwaLifecycleEntry[] {
  return readStoredDiagnostics().entries
}

/** Install only in standalone apps, before service-worker registration begins. */
export function installPwaLifecycleDiagnostics(): void {
  if (!isStandalonePwa()) return

  const session = makeSessionId()
  const previous = readStoredDiagnostics().entries.at(-1)
  const record = (event: string, data: Record<string, DiagnosticValue> = {}) => {
    const stored = readStoredDiagnostics()
    stored.entries.push({
      at: new Date().toISOString(),
      event,
      session,
      data: { ...browserState(), ...data },
    })
    stored.entries = stored.entries.slice(-MAX_ENTRIES)
    writeStoredDiagnostics(stored)
  }

  record('boot', {
    previousEvent: previous?.event ?? null,
    previousSessionEndedCleanly: previous ? isExpectedTerminalEvent(previous.event) : null,
  })

  for (const eventName of ['beforeunload', 'unload', 'pageshow', 'pagehide', 'freeze', 'resume']) {
    window.addEventListener(eventName, (event) => {
      record(eventName, {
        persisted: 'persisted' in event ? Boolean((event as PageTransitionEvent).persisted) : null,
      })
    }, { capture: true })
  }

  document.addEventListener('visibilitychange', () => record('visibilitychange'), { capture: true })

  navigator.serviceWorker?.addEventListener('controllerchange', () => record('service-worker-controllerchange'))
  navigator.serviceWorker?.getRegistration().then((registration) => {
    if (!registration) {
      record('service-worker-registration', { registration: 'missing' })
      return
    }
    record('service-worker-registration', {
      active: registration.active?.scriptURL ?? null,
      waiting: registration.waiting?.scriptURL ?? null,
      installing: registration.installing?.scriptURL ?? null,
    })
    registration.addEventListener('updatefound', () => {
      record('service-worker-updatefound')
      const installing = registration.installing
      installing?.addEventListener('statechange', () => {
        record('service-worker-statechange', { state: installing.state })
      })
    })
  }).catch(() => record('service-worker-registration-error'))
}
