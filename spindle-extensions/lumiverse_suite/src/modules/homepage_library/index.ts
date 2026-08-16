import type { SuiteModule, SuiteModuleContext } from '../../suite'
import { requireSuiteSettings, type SuiteSettingsAPI } from '../../shared/settings'
import {
  asMount,
  ownerDocumentOf,
  readExtensionInstallationId,
  requireScopedHostRoot,
  type ScopedHostRoot,
} from '../../shared/public-sdk'
import {
  defaultHomepageLibrarySettings,
  HOMEPAGE_LIBRARY_MODULE_ID,
  HOMEPAGE_LIBRARY_SETTINGS_KEY,
  normalizeHomepageLibrarySettings,
  sameHomepageLibrarySettings,
  type HomepageLibrarySettings,
} from './types'

const MODULE_ID = HOMEPAGE_LIBRARY_MODULE_ID
const CORE_SETTINGS_KEY = 'homepageCharacterLibrarySettings'
const LANDING_MOUNT_POINT = 'landing_characters'
const SURFACE_ID = 'homepage_character_library'
const STALE_ROOT_SELECTORS = [
  '[data-homepage-character-library-root="true"][data-spindle-ext-id="lumiverse_suite"]',
  '[data-homepage-library-root="true"][data-spindle-ext-id="lumiverse_suite"]',
] as const
type Dispose = () => void

function dispose(value: unknown): Dispose {
  if (typeof value === 'function') return value as Dispose
  if (!value || typeof value !== 'object') return () => undefined
  const candidate = value as { destroy?: unknown; dispose?: unknown; unsubscribe?: unknown }
  const action = [candidate.destroy, candidate.dispose, candidate.unsubscribe].find(item => typeof item === 'function') as (() => void) | undefined
  return action ? () => { try { action.call(value) } catch { /* best effort */ } } : () => undefined
}

function isUnknownCoreError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'CORE_SETTING_UNKNOWN' || message.startsWith('CORE_SETTING_UNKNOWN:')
}

function clearStaleRoots(anchor: ScopedHostRoot): void {
  for (const selector of STALE_ROOT_SELECTORS) {
    for (const staleRoot of [...anchor.querySelectorAll<HTMLElement>(selector)]) staleRoot.remove()
  }
}

export function createHomepageLibraryModule(): SuiteModule {
  let running = false
  let starting = false
  let context: SuiteModuleContext | undefined
  let settingsApi: SuiteSettingsAPI | undefined
  let current = defaultHomepageLibrarySettings()
  let root: HTMLElement | undefined
  let surface: { destroy(): void } | undefined
  let stopPrivateWatch: Dispose = () => undefined
  let stopCanonicalWatch: Dispose = () => undefined
  let privateFallback = false
  let lifecycleGeneration = 0

  const clearPresentation = (): void => {
    try { surface?.destroy() } catch { /* host may already have torn it down */ }
    surface = undefined
    try { root?.remove() } catch { /* host may already have torn it down */ }
    root = undefined
  }

  const mountPresentation = (): void => {
    if (!running || root || !context) return
    const host = context.host
    let anchor: ScopedHostRoot
    try {
      anchor = requireScopedHostRoot(host.ui.mount(asMount(LANDING_MOUNT_POINT)), 'HOMEPAGE_LIBRARY_MOUNT_UNAVAILABLE')
    } catch {
      return
    }
    clearStaleRoots(anchor)
    if (!current.enabled) return
    const mount = host.components.mountHostSurface
    if (typeof mount !== 'function') return
    const doc = ownerDocumentOf(anchor)
    if (!doc) return
    const nextRoot = doc.createElement('section')
    nextRoot.dataset.lumiverseModule = MODULE_ID
    nextRoot.dataset.homepageCharacterLibraryRoot = 'true'
    nextRoot.setAttribute('data-spindle-ext-id', 'lumiverse_suite')
    const installedUuid = readExtensionInstallationId(host)
    if (installedUuid) {
      nextRoot.setAttribute('data-spindle-extension-root', installedUuid)
      nextRoot.setAttribute('data-spindle-ext', installedUuid)
    }
    anchor.append(nextRoot)
    try {
      const handle = mount(nextRoot, SURFACE_ID, {})
      if (!handle) {
        nextRoot.remove()
        return
      }
      surface = handle
      root = nextRoot
      nextRoot.dataset.homepageCharacterLibraryReady = 'true'
    } catch (error) {
      nextRoot.remove()
      throw error
    }
  }

  const applySettings = (value: unknown): void => {
    const next = normalizeHomepageLibrarySettings(value)
    if (sameHomepageLibrarySettings(current, next)) return
    const enabledChanged = current.enabled !== next.enabled
    current = next
    if (running && enabledChanged) {
      clearPresentation()
      mountPresentation()
    }
  }

  const loadSettings = async (api: SuiteSettingsAPI): Promise<HomepageLibrarySettings> => {
    privateFallback = typeof api.core?.get !== 'function'
    if (!privateFallback) {
      try {
        return normalizeHomepageLibrarySettings(api.core.get(CORE_SETTINGS_KEY))
      } catch (error) {
        if (!isUnknownCoreError(error)) throw error
        privateFallback = true
      }
    }
    const saved = await api.get<unknown>(HOMEPAGE_LIBRARY_SETTINGS_KEY)
    const normalized = normalizeHomepageLibrarySettings(saved)
    let needsPersist = saved === undefined
    try { needsPersist ||= JSON.stringify(saved) !== JSON.stringify(normalized) } catch { needsPersist = true }
    if (needsPersist) await api.set(HOMEPAGE_LIBRARY_SETTINGS_KEY, normalized)
    return normalized
  }

  return {
    id: MODULE_ID,
    async start(moduleContext?: SuiteModuleContext) {
      if (running || starting || !moduleContext) return
      starting = true
      const startGeneration = ++lifecycleGeneration
      context = moduleContext
      settingsApi = requireSuiteSettings(moduleContext)
      const api = settingsApi
      try {
        current = await loadSettings(api)
        if (startGeneration !== lifecycleGeneration || context !== moduleContext || !starting) return
        running = true
        starting = false
        if (privateFallback) {
          stopPrivateWatch = dispose(api.watch<unknown>(HOMEPAGE_LIBRARY_SETTINGS_KEY, value => {
            if (running) applySettings(value)
          }))
        } else {
          if (typeof api.core.watch !== 'function') throw new Error('CORE_SETTINGS_WATCH_UNAVAILABLE')
          stopCanonicalWatch = dispose(api.core.watch<unknown>(CORE_SETTINGS_KEY, value => {
            if (running) applySettings(value)
          }))
        }
        mountPresentation()
      } catch (error) {
        starting = false
        running = false
        stopCanonicalWatch()
        stopCanonicalWatch = () => undefined
        stopPrivateWatch()
        stopPrivateWatch = () => undefined
        clearPresentation()
        context = undefined
        settingsApi = undefined
        throw error
      }
    },
    stop() {
      if (!running && !starting && !context) return
      lifecycleGeneration += 1
      running = false
      starting = false
      stopCanonicalWatch()
      stopCanonicalWatch = () => undefined
      stopPrivateWatch()
      stopPrivateWatch = () => undefined
      clearPresentation()
      context = undefined
      settingsApi = undefined
    },
  }
}

export default createHomepageLibraryModule
