import { BASE_URL } from '@/api/client'
import { useSyncExternalStore } from 'react'
import { isNativeCacheDocument } from './nativeCache'

export type SafeThemeSource = 'url' | 'server' | 'both' | null

export interface SafeThemeState {
  active: boolean
  source: SafeThemeSource
}

const DISABLED_QUERY_VALUES = new Set(['0', 'false', 'no', 'off'])
const RUNTIME_CONFIG_TIMEOUT_MS = 2_000

let state: SafeThemeState = { active: false, source: null }
const subscribers = new Set<() => void>()

export function subscribeSafeThemeState(listener: () => void): () => void {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

export function useSafeThemeState(): SafeThemeState {
  return useSyncExternalStore(subscribeSafeThemeState, getSafeThemeState, getSafeThemeState)
}

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
  const changed = state.active !== next.active || state.source !== next.source
  state = next
  if (typeof document !== 'undefined') {
    if (next.active) {
      document.documentElement.setAttribute('data-safe-theme', next.source ?? '')
    } else {
      document.documentElement.removeAttribute('data-safe-theme')
    }
  }
  if (changed) subscribers.forEach(listener => listener())
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

  // The native shell must paint without an online startup dependency. Cache
  // only this public UI bootstrap field in the real origin's WebKit storage;
  // an unknown value enables the conservative safe interface until refreshed.
  if (isNativeCacheDocument()) {
    let enabled = true
    try { enabled = localStorage.getItem('lumiverse.native-cache.safe-theme') !== '0' } catch { /* Unavailable storage uses the safe default. */ }
    const next = resolveSafeThemeState(search, enabled)
    applyState(next)
    void fetchServerSafeTheme().then(serverEnabled => {
      if (serverEnabled === null) return
      try { localStorage.setItem('lumiverse.native-cache.safe-theme', serverEnabled ? '1' : '0') } catch { /* Optional bootstrap snapshot. */ }
      applyState(resolveSafeThemeState(search, serverEnabled))
    })
    return next
  }

  const next = resolveSafeThemeState(search, (await fetchServerSafeTheme()) ?? false)
  applyState(next)
  return next
}

async function fetchServerSafeTheme(): Promise<boolean | null> {
  let serverEnabled: boolean | null = null
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

  return serverEnabled
}
