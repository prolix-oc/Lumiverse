import { BASE_URL } from '@/api/client'

export type SafeThemeSource = 'url' | 'server' | 'both' | null

export interface SafeThemeState {
  active: boolean
  source: SafeThemeSource
}

const DISABLED_QUERY_VALUES = new Set(['0', 'false', 'no', 'off'])
const RUNTIME_CONFIG_TIMEOUT_MS = 2_000

let state: SafeThemeState = { active: false, source: null }

export function hasSafeThemeQuery(search: string): boolean {
  const value = new URLSearchParams(search).get('safe-theme')
  if (value === null) return false
  return !DISABLED_QUERY_VALUES.has(value.trim().toLowerCase())
}

export function resolveSafeThemeState(search: string, serverEnabled: boolean): SafeThemeState {
  const urlEnabled = hasSafeThemeQuery(search)
  return {
    active: urlEnabled || serverEnabled,
    source: urlEnabled && serverEnabled
      ? 'both'
      : urlEnabled
        ? 'url'
        : serverEnabled
          ? 'server'
          : null,
  }
}

function applyState(next: SafeThemeState): void {
  state = next
  if (typeof document === 'undefined') return
  if (next.active) {
    document.documentElement.setAttribute('data-safe-theme', next.source ?? '')
  } else {
    document.documentElement.removeAttribute('data-safe-theme')
  }
}

export function getSafeThemeState(): SafeThemeState {
  return state
}

export function isSafeThemeMode(): boolean {
  return state.active
}

/** Resolve URL and server safe-theme controls before React can apply styling. */
export async function initializeSafeThemeMode(): Promise<SafeThemeState> {
  const search = typeof window === 'undefined' ? '' : window.location.search

  // A URL recovery request is already authoritative and should never wait for
  // an unavailable backend before rendering the safe interface.
  if (hasSafeThemeQuery(search)) {
    const next = resolveSafeThemeState(search, false)
    applyState(next)
    return next
  }

  let serverEnabled = false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RUNTIME_CONFIG_TIMEOUT_MS)
  try {
    const response = await fetch(`${BASE_URL}/runtime-config`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (response.ok) {
      const payload = await response.json() as { safeThemeMode?: unknown }
      serverEnabled = payload.safeThemeMode === true
    }
  } catch {
    // Startup continues with the normal theme if runtime config is unavailable.
  } finally {
    clearTimeout(timeout)
  }

  const next = resolveSafeThemeState(search, serverEnabled)
  applyState(next)
  return next
}
