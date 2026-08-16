import type { SuiteModule, SuiteModuleContext } from '../../suite'
import { requireSuiteSettings, type SuiteSettingsAPI } from '../../shared/settings'
import {
  CHARACTER_DISPLAY_ENABLED_KEY,
  CHARACTER_DISPLAY_HOMEPAGE_SETTINGS_KEY,
  CHARACTER_DISPLAY_MODULE_ID,
  CHARACTER_DISPLAY_SETTINGS_KEY,
  CHARACTER_DISPLAY_TAB_SETTINGS_KEY,
  type CharacterDisplayChangedPayload,
  type CharacterDisplaySelection,
  type CharacterDisplaySettings,
  type CharacterDisplaySurface,
} from './types'
import {
  buildCharacterDisplayCss,
  defaultCharacterDisplaySettings,
  normalizeCharacterDisplaySettings,
  resolveCharacterDisplaySettings,
} from './settings-model'

import {
  createCharacterDisplayHostAdapter,
  type CharacterDisplayHostAdapter,
} from './host-adapter'
import { createCharacterDisplayRuntime } from './runtime'
type JsonRecord = Record<string, unknown>
type Dispose = () => void
type RuntimeHandle = {
  updateSettings(settings: CharacterDisplaySettings): void
  updateSelection(selection: CharacterDisplaySelection | null): void
  updateScope(scope: string | null): void
  destroy(): void
}
type AdapterExtras = {
  readActiveCharacter?(): CharacterDisplaySelection | null
  getActiveCharacter?(): CharacterDisplaySelection | null
  subscribeActiveCharacter?(listener: (selection: CharacterDisplaySelection | null) => void): unknown
}
type ActiveAdapter = CharacterDisplayHostAdapter & AdapterExtras

type Settings = CharacterDisplaySettings

type Selection = CharacterDisplaySelection | null

const MODULE_ID = CHARACTER_DISPLAY_MODULE_ID
const LEGACY_SETTINGS_KEY = CHARACTER_DISPLAY_SETTINGS_KEY
const ENABLED_KEY = CHARACTER_DISPLAY_ENABLED_KEY
const HOMEPAGE_SETTINGS_KEY = CHARACTER_DISPLAY_HOMEPAGE_SETTINGS_KEY
const TAB_SETTINGS_KEY = CHARACTER_DISPLAY_TAB_SETTINGS_KEY

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function toDispose(value: unknown): Dispose | undefined {
  if (typeof value === 'function') return value as Dispose
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as JsonRecord
  const destroy = record.destroy
  if (typeof destroy === 'function') return () => { destroy.call(record) }
  const dispose = record.dispose
  if (typeof dispose === 'function') return () => { dispose.call(record) }
  return undefined
}

function selectionValue(value: unknown): Selection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as JsonRecord
  const characterId = typeof record.characterId === 'string' && record.characterId.length > 0
    ? record.characterId
    : null
  const scope = record.scope === 'mine' || record.scope === 'shared' ? record.scope : undefined
  const surface = record.surface === 'homepage' || record.surface === 'characters-tab' ? record.surface : undefined
  const characterName = typeof record.characterName === 'string' && record.characterName.length > 0
    ? record.characterName
    : undefined
  if (!characterId && !scope && !surface && !characterName) return null
  return {
    characterId,
    ...(scope ? { scope } : {}),
    ...(surface ? { surface } : {}),
    ...(characterName ? { characterName } : {}),
  }
}

function scopeValue(value: unknown): 'mine' | 'shared' | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const scope = (value as JsonRecord).scope
  return scope === 'mine' || scope === 'shared' ? scope : undefined
}

function scopeLabel(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as JsonRecord
  if (record.showBadge === false) return null
  const scope = scopeValue(record)
  return scope === 'shared' ? 'Shared' : scope === 'mine' ? 'Mine' : null
}


function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function surfaceValue(value: unknown): CharacterDisplaySurface {
  return value === 'homepage' ? 'homepage' : 'characters-tab'
}

function withEnabled(settings: Settings, enabled: boolean): Settings {
  return { ...settings, enabled, visibleMetadata: [...settings.visibleMetadata] }
}

function callbackSurface(value: unknown): value is CharacterDisplaySurface {
  return value === 'homepage' || value === 'characters-tab'
}

export function createCharacterDisplayModule(): SuiteModule {
  let running = false
  let starting = false
  let context: SuiteModuleContext | undefined
  let settingsApi: SuiteSettingsAPI | undefined
  let enabled = true
  let homepageSettings: Settings = defaultCharacterDisplaySettings()
  let characterTabSettings: Settings = defaultCharacterDisplaySettings()
  let current: Settings = characterTabSettings
  let stopSettingsWatches: Dispose[] = []
  let suppressSettingsRestart = false
  let lifecycleGeneration = 0
  let settingsWriteSequence = 0
  let settingsWriteTail: Promise<void> = Promise.resolve()
  let settingsWriteAbortController: AbortController | undefined

  let adapter: ActiveAdapter | undefined
  let runtime: RuntimeHandle | undefined
  let stopSettingsRegistration: Dispose | undefined
  let stopActiveSubscription: Dispose | undefined
  let stopScopeSubscription: Dispose | undefined
  let stylesActive = false
  let activeSelection: Selection = null
  let activeScope: 'mine' | 'shared' | undefined
  let activeScopeLabel: string | null = null

  const emitChanged = () => {
    if (!running) return
    const selection = activeSelection
    const scope = activeScope ?? selection?.scope
    const payload: CharacterDisplayChangedPayload = {
      characterId: selection?.characterId ?? null,
      ...(scope ? { scope } : {}),
      ...(selection?.surface ? { surface: selection.surface } : {}),
      settings: current,
    }
    context?.bus?.emit('character-display/changed', payload)
  }

  const clearResources = () => {
    lifecycleGeneration += 1
    // Abort the in-flight host PUT but preserve the ordered tail. A later
    // activation must not overtake a stale request that may already have
    // reached the server; the adapter's AbortSignal settles the old link.
    settingsWriteSequence += 1
    settingsWriteAbortController?.abort()
    settingsWriteAbortController = undefined
    activeSelection = null
    activeScope = undefined
    activeScopeLabel = null

    try { runtime?.destroy() } catch { /* cleanup is best effort */ }
    runtime = undefined

    for (const dispose of [stopActiveSubscription, stopScopeSubscription, stopSettingsRegistration]) {
      try { dispose?.() } catch { /* cleanup is best effort */ }
    }
    stopActiveSubscription = undefined
    stopScopeSubscription = undefined
    stopSettingsRegistration = undefined
    adapter = undefined

    if (stylesActive) {
      try { context?.styles.clear() } catch { /* cleanup is best effort */ }
      stylesActive = false
    }
  }

  const persistSurfaceSettingsNow = async (
    requestedSurface: unknown,
    nextValue: unknown,
    activationContext: SuiteModuleContext,
    activationAdapter: ActiveAdapter,
    activationGeneration: number,
    writeSequence: number,
  ): Promise<void> => {
    if (!isCurrentActivation(activationContext, activationAdapter, activationGeneration)) return
    const surface = surfaceValue(requestedSurface)
    const source = nextValue !== null && typeof nextValue === 'object' && !Array.isArray(nextValue)
      ? nextValue as JsonRecord
      : undefined
    const requestedEnabled = booleanSetting(source?.enabled, enabled)
    const normalized = normalizeCharacterDisplaySettings(nextValue)
    const next = { ...normalized, enabled: requestedEnabled, visibleMetadata: [...normalized.visibleMetadata] }
    const previous = surface === 'homepage' ? homepageSettings : characterTabSettings
    const enabledChanged = requestedEnabled !== enabled
    if (sameValue(previous, next) && !enabledChanged) return
    const writeAbortController = typeof AbortController === 'undefined'
      ? undefined
      : new AbortController()
    settingsWriteAbortController = writeAbortController
    try {
      await activationAdapter.applyBrowserDefaults(surface, next, writeAbortController?.signal)
    } catch {
      return
    } finally {
      if (settingsWriteAbortController === writeAbortController) settingsWriteAbortController = undefined
    }

    if (!isCurrentActivation(activationContext, activationAdapter, activationGeneration)) return
    const api = settingsApi
    if (!api) return

    suppressSettingsRestart = true
    let committed = false
    try {
      await api.set(surface === 'homepage' ? HOMEPAGE_SETTINGS_KEY : TAB_SETTINGS_KEY, next)
      if (!isCurrentActivation(activationContext, activationAdapter, activationGeneration)) return
      if (enabledChanged) await api.set(ENABLED_KEY, requestedEnabled)
      if (!isCurrentActivation(activationContext, activationAdapter, activationGeneration)) return
      if (surface === 'homepage') homepageSettings = next
      else characterTabSettings = next
      enabled = requestedEnabled
      refreshCurrentSettings()
      committed = true
    } catch {
      // Failed writes do not produce a success event or mutate the active row.
    } finally {
      suppressSettingsRestart = false
    }
    if (!committed || !isCurrentActivation(activationContext, activationAdapter, activationGeneration)) return
    // A newer queued edit must commit before remounting. Remounting here would
    // invalidate its captured activation and silently discard the later value.
    if (writeSequence === settingsWriteSequence) restartForSettings()
  }

  const persistSurfaceSettings = (
    requestedSurface: unknown,
    nextValue: unknown,
    activationContext: SuiteModuleContext,
    activationAdapter: ActiveAdapter,
    activationGeneration: number,
  ): Promise<void> => {
    const writeSequence = ++settingsWriteSequence
    const write = settingsWriteTail.then(() => persistSurfaceSettingsNow(
      requestedSurface,
      nextValue,
      activationContext,
      activationAdapter,
      activationGeneration,
      writeSequence,
    ))
    settingsWriteTail = write.catch(() => undefined)
    return write
  }

  const renderSettings = (
    root: HTMLElement,
    activationContext: SuiteModuleContext,
    activationAdapter: ActiveAdapter,
    activationGeneration: number,
  ): Dispose => {
    if (!running || context !== activationContext || lifecycleGeneration !== activationGeneration) return () => undefined

    current = resolveCharacterDisplaySettings({
      surface: 'characters-tab',
      homepageSettings,
      characterTabSettings,
    }).display
    const runtimeOptions = {
      root,
      settings: current,
      homepageSettings,
      characterTabSettings,
      surface: 'characters-tab' as const,
      adapter: activationAdapter,
      scopeLabel: activeScopeLabel,
      document: root.ownerDocument,
      onSettingsChange: (...args: unknown[]) => {
        const requestedSurface = args.length > 1 && callbackSurface(args[0]) ? args[0] : 'characters-tab'
        const nextSettings = args.length > 1 ? args[1] : args[0]
        return persistSurfaceSettings(
          requestedSurface,
          nextSettings,
          activationContext,
          activationAdapter,
          activationGeneration,
        )
      },
      onSelectionChange: (next: Selection) => {
        if (!isCurrentActivation(activationContext, activationAdapter, activationGeneration)) return
        const nextSelection = selectionValue(next)
        if (sameValue(activeSelection, nextSelection)) return
        activeSelection = nextSelection
        activeScope = activeSelection?.scope
        emitChanged()
      },
    }
    const handle = createCharacterDisplayRuntime(
      runtimeOptions as Parameters<typeof createCharacterDisplayRuntime>[0],
    ) as unknown as RuntimeHandle

    if (!isCurrentActivation(activationContext, activationAdapter, activationGeneration)) {
      try { handle.destroy() } catch { /* cleanup is best effort */ }
      return () => undefined
    }

    runtime?.destroy()
    runtime = handle
    runtime.updateSelection(activeSelection)
    runtime.updateScope(activeScopeLabel)
    return () => {
      if (runtime === handle) {
        try { runtime.destroy() } catch { /* cleanup is best effort */ }
        runtime = undefined
      } else {
        try { handle.destroy() } catch { /* cleanup is best effort */ }
      }
    }
  }

  const isCurrentActivation = (
    activationContext: SuiteModuleContext,
    activationAdapter: ActiveAdapter,
    activationGeneration: number,
  ): boolean => running
    && enabled
    && context === activationContext
    && adapter === activationAdapter
    && lifecycleGeneration === activationGeneration

  const activate = () => {
    if (!context || !running || !enabled || adapter) return
    const activationContext = context
    const activationGeneration = lifecycleGeneration

    let nextAdapter: ActiveAdapter
    try {
      nextAdapter = createCharacterDisplayHostAdapter(activationContext.host) as ActiveAdapter
    } catch {
      return
    }
    adapter = nextAdapter

    if (!isCurrentActivation(activationContext, nextAdapter, activationGeneration)) return

    try {
      activationContext.styles.add(buildCharacterDisplayCss(homepageSettings), { scope: 'global' })
      stylesActive = true
    } catch {
      clearResources()
      return
    }

    const onActive = (value: CharacterDisplaySelection | null) => {
      if (!isCurrentActivation(activationContext, nextAdapter, activationGeneration)) return
      const nextSelection = selectionValue(value)
      if (sameValue(activeSelection, nextSelection)) return
      activeSelection = nextSelection
      activeScope = nextSelection?.scope
      runtime?.updateSelection(nextSelection)
      emitChanged()
    }

    const readActive = nextAdapter.readActiveCharacter ?? nextAdapter.getActiveCharacter
    if (readActive) {
      try {
        const initial = readActive.call(nextAdapter)
        if (initial && typeof (initial as unknown as Promise<unknown>).then === 'function') {
          void Promise.resolve(initial).then(value => {
            if (!isCurrentActivation(activationContext, nextAdapter, activationGeneration)) return
            onActive(value)
          }, () => undefined)
        } else {
          activeSelection = selectionValue(initial)
          activeScope = activeSelection?.scope
        }
      } catch {
        activeSelection = null
        activeScope = undefined
      }
    }

    const subscribeActive = nextAdapter.subscribeActiveCharacter
    if (subscribeActive) {
      try {
        stopActiveSubscription = toDispose(subscribeActive.call(nextAdapter, onActive))
      } catch {
        stopActiveSubscription = undefined
      }
    }

    const onScope = (value: unknown) => {
      if (!isCurrentActivation(activationContext, nextAdapter, activationGeneration)) return
      const nextScope = scopeValue(value)
      const nextLabel = scopeLabel(value)
      if (nextScope === activeScope && nextLabel === activeScopeLabel) return
      activeScope = nextScope
      activeScopeLabel = nextLabel
      if (activeSelection) {
        activeSelection = {
          ...activeSelection,
          ...(nextScope ? { scope: nextScope } : {}),
        }
      }
      runtime?.updateSelection(activeSelection)
      runtime?.updateScope(nextLabel)
      emitChanged()
    }
    try {
      stopScopeSubscription = toDispose(activationContext.bus?.subscribe('library-scope/metadata', onScope))
    } catch {
      stopScopeSubscription = undefined
    }

    // Productivity settings are registered exactly once by the suite-level
    // lifecycle. Feature adapters retain normalization/persistence helpers but
    // must not contribute duplicate settings tabs or bodies.
    stopSettingsRegistration = undefined

    if (!isCurrentActivation(activationContext, nextAdapter, activationGeneration)) return
    runtime?.updateSelection(activeSelection)
    runtime?.updateScope(activeScopeLabel)
    emitChanged()
  }

  const refreshCurrentSettings = () => {
    current = resolveCharacterDisplaySettings({
      surface: 'characters-tab',
      homepageSettings,
      characterTabSettings,
    }).display
  }

  const restartForSettings = () => {
    if (suppressSettingsRestart) return
    clearResources()
    if (enabled) {
      activate()
      return
    }
    emitChanged()
  }
  const applyEnabledSetting = (value: unknown) => {
    if (!running) return
    const nextEnabled = booleanSetting(value, true)
    if (enabled === nextEnabled) return
    enabled = nextEnabled
    homepageSettings = withEnabled(homepageSettings, enabled)
    characterTabSettings = withEnabled(characterTabSettings, enabled)
    refreshCurrentSettings()
    restartForSettings()
  }

  const applySurfaceSettings = (surfaceInput: unknown, value: unknown) => {
    if (!running) return
    const surface = surfaceValue(surfaceInput)
    const next = withEnabled(normalizeCharacterDisplaySettings(value), enabled)
    const previous = surface === 'homepage' ? homepageSettings : characterTabSettings
    if (sameValue(previous, next)) return
    if (surface === 'homepage') homepageSettings = next
    else characterTabSettings = next
    refreshCurrentSettings()
    restartForSettings()
  }

  return {
    id: MODULE_ID,
    async start(moduleContext?: SuiteModuleContext) {
      if (running || starting) return
      starting = true
      const startGeneration = ++lifecycleGeneration
      context = moduleContext
      settingsApi = requireSuiteSettings(moduleContext ?? {})
      const api = settingsApi
      const isCurrentStart = () => startGeneration === lifecycleGeneration
        && context === moduleContext
        && starting

      const [savedEnabled, savedHomepage, savedTab, savedLegacy] = await Promise.all([
        api.get<unknown>(ENABLED_KEY),
        api.get<unknown>(HOMEPAGE_SETTINGS_KEY),
        api.get<unknown>(TAB_SETTINGS_KEY),
        api.get<unknown>(LEGACY_SETTINGS_KEY),
      ])
      if (!isCurrentStart()) return

      const legacyRecord = savedLegacy !== null && typeof savedLegacy === 'object' && !Array.isArray(savedLegacy)
        ? savedLegacy as JsonRecord
        : undefined
      const legacySettings = normalizeCharacterDisplaySettings(savedLegacy)
      const nextEnabled = booleanSetting(savedEnabled, booleanSetting(legacyRecord?.enabled, true))
      const canonicalSettings = (value: unknown, fallback: Settings): Settings => {
        const normalized = normalizeCharacterDisplaySettings(value === undefined ? fallback : value)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return withEnabled(normalized, nextEnabled)
        return {
          ...(value as JsonRecord),
          ...normalized,
          enabled: nextEnabled,
          visibleMetadata: [...normalized.visibleMetadata],
        } as Settings
      }
      const nextHomepage = canonicalSettings(
        savedHomepage === undefined ? (legacyRecord ?? undefined) : savedHomepage,
        defaultCharacterDisplaySettings(),
      )
      const legacyTab = legacyRecord
        ? { ...legacyRecord, useHomepageSettings: legacySettings.useHomepageSettings }
        : undefined
      const nextTab = canonicalSettings(
        savedTab === undefined ? legacyTab : savedTab,
        defaultCharacterDisplaySettings(),
      )

      if (!sameValue(savedEnabled, nextEnabled)) {
        await api.set(ENABLED_KEY, nextEnabled)
        if (!isCurrentStart()) return
      }
      if (!sameValue(savedHomepage, nextHomepage)) {
        await api.set(HOMEPAGE_SETTINGS_KEY, nextHomepage)
        if (!isCurrentStart()) return
      }
      if (!sameValue(savedTab, nextTab)) {
        await api.set(TAB_SETTINGS_KEY, nextTab)
        if (!isCurrentStart()) return
      }
      if (savedLegacy !== undefined) {
        await api.remove(LEGACY_SETTINGS_KEY)
        if (!isCurrentStart()) return
      }

      enabled = nextEnabled
      homepageSettings = withEnabled(nextHomepage, enabled)
      characterTabSettings = withEnabled(nextTab, enabled)
      refreshCurrentSettings()
      running = true
      starting = false
      stopSettingsWatches = [
        toDispose(api.watch<unknown>(ENABLED_KEY, value => applyEnabledSetting(value))) ?? (() => undefined),
        toDispose(api.watch<unknown>(HOMEPAGE_SETTINGS_KEY, value => applySurfaceSettings('homepage', value))) ?? (() => undefined),
        toDispose(api.watch<unknown>(TAB_SETTINGS_KEY, value => applySurfaceSettings('characters-tab', value))) ?? (() => undefined),
      ]
      if (enabled) activate()
    },
    stop() {
      if (!running && !starting && !context && !settingsApi) return
      running = false
      starting = false
      lifecycleGeneration += 1
      for (const dispose of stopSettingsWatches.splice(0)) {
        try { dispose() } catch { /* cleanup is best effort */ }
      }
      clearResources()
      context = undefined
      settingsApi = undefined
    },
  }
}

export default createCharacterDisplayModule
