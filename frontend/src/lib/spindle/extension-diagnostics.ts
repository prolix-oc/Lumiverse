export interface SpindleExtensionCounters {
  extensionOwnedRawMutationObservers: number
  documentWideCoreSelectorScrapes: number
  decoratorObservers: number
  roots: number
  callbacks: number
  injectedNodes: number
  registrations: number
}

export const EMPTY_SPINDLE_EXTENSION_COUNTERS: SpindleExtensionCounters = Object.freeze({
  extensionOwnedRawMutationObservers: 0,
  documentWideCoreSelectorScrapes: 0,
  decoratorObservers: 0,
  roots: 0,
  callbacks: 0,
  injectedNodes: 0,
  registrations: 0,
})

type DiagnosticsGetter = (owner: string, generation: number) => SpindleExtensionCounters

type DiagnosticsWindow = Window & {
  __spindleExtensionDiagnostics?: {
    getCounters(owner: string, generation: number): SpindleExtensionCounters
  }
}

let diagnosticsForced = false
let getter: DiagnosticsGetter | null = null

export function isSpindleTestMode(): boolean {
  if (diagnosticsForced) return true
  if (typeof process === 'undefined') return false
  const env = process.env
  return env.NODE_ENV === 'test'
    || env.BUN_TEST === '1'
    || env.SPINDLE_EXTENSION_DIAGNOSTICS === '1'
}

export function bindSpindleExtensionDiagnosticsGetter(next: DiagnosticsGetter | null): void {
  getter = next
  if (next && isSpindleTestMode()) installSpindleExtensionDiagnostics()
}

export function installSpindleExtensionDiagnostics(): void {
  diagnosticsForced = true
  if (typeof window === 'undefined') return
  const target = window as DiagnosticsWindow
  target.__spindleExtensionDiagnostics = {
    getCounters(owner: string, generation: number): SpindleExtensionCounters {
      if (!isSpindleTestMode()) {
        throw new Error('SPINDLE_DIAGNOSTICS_TEST_ONLY')
      }
      return getter?.(owner, generation) ?? { ...EMPTY_SPINDLE_EXTENSION_COUNTERS }
    },
  }
}

export function uninstallSpindleExtensionDiagnostics(): void {
  diagnosticsForced = false
  getter = null
  if (typeof window === 'undefined') return
  delete (window as DiagnosticsWindow).__spindleExtensionDiagnostics
}

export function readSpindleExtensionCounters(owner: string, generation: number): SpindleExtensionCounters {
  if (!isSpindleTestMode()) {
    throw new Error('SPINDLE_DIAGNOSTICS_TEST_ONLY')
  }
  return getter?.(owner, generation) ?? { ...EMPTY_SPINDLE_EXTENSION_COUNTERS }
}
