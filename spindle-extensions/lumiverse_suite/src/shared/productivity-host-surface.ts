import type { ModuleId, SuiteHostContext, SuiteModule, SuiteModuleContext } from '../suite'
import { asMount, readExtensionInstallationId } from './public-sdk'

type SurfaceHandle = {
  update?(props: Record<string, unknown>): void
  destroy?(): void
  on?(event: string, listener: (payload: unknown) => void): () => void
}

type InputActionHandle = {
  onClick?(listener: () => void): () => void
  destroy?(): void
}

type QuickToolbarActionOptions = {
  readonly id: string
  readonly label: string
  readonly subtitle: string
  readonly iconName: string
}

type SurfaceSettingsApi = {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  watch<T>(key: string, listener: (value: T) => void): () => void
  readonly core: {
    get<T>(key: string): T | undefined
    watch<T>(key: string, listener: (value: T) => void): () => void
    isReady?(): boolean
  }
}

type SurfaceModuleOptions<T> = {
  readonly id: ModuleId
  readonly surfaceId: 'quick_toolbar.workspace' | 'connections_picker.panel' | 'activated_lore.indicator' | 'activated_lore.panel' | 'portrait_dock.workspace'
  readonly settingsKey: string
  readonly coreSettingsKey: string
  readonly mountPoint: (settings: T) => string
  readonly normalize: (value: unknown) => T
  readonly enabled: (settings: T) => boolean
  readonly launcher?: {
    readonly surfaceId: 'connections_picker.launcher'
    readonly mountPoint: (settings: T) => string
  }
  readonly quickToolbarAction?: QuickToolbarActionOptions
  readonly panel?: {
    readonly surfaceId: 'activated_lore.panel'
    readonly mountPoint: (settings: T) => string
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

function traceSettings(stage: string, data: Record<string, unknown>): void {
  void stage
  void data
}

function portraitDockSummary(value: unknown): Record<string, unknown> | undefined {
  const source = record(value)
  if (!source) return undefined
  const rect = record(source.rect)
  return {
    open: source.open,
    dockSide: source.dockSide,
    defaultDockSide: source.defaultDockSide,
    rememberSizePosition: source.rememberSizePosition,
    pinned: source.pinned,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function ownerToken(context: SuiteModuleContext): string {
  const candidate = readExtensionInstallationId(context.host)
  return candidate && /^[A-Za-z0-9_-]{1,128}$/.test(candidate)
    ? candidate
    : 'lumiverse_suite'
}

function settingsRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : {}
}

/** Owns only the extension lifecycle; canonical presentation remains in core. */
export function createProductivityHostSurfaceModule<T>(options: SurfaceModuleOptions<T>): SuiteModule {
  let running = false
  let context: SuiteModuleContext | undefined
  let settings: T | undefined
  let watchStop: (() => void) | undefined
  let handle: SurfaceHandle | undefined
  let eventStop: (() => void) | undefined
  let mountedPoint: string | undefined
  const inFlightMounts = new Set<string>()
  let generation = 0
  let launcherHandle: SurfaceHandle | undefined
  let launcherEventStop: (() => void) | undefined
  let launcherPoint: string | undefined
  let launcherGeneration = 0
  let panelOpen = false
  let handledCommands = new Set<string>()
  let quickToolbarActionHandle: InputActionHandle | undefined
  let quickToolbarActionStop: (() => void) | undefined

  const clearSurface = () => {
    generation += 1
    eventStop?.()
    eventStop = undefined
    try { handle?.destroy?.() } catch { /* idempotent host cleanup */ }
    handle = undefined
    mountedPoint = undefined
  }

  const clearLauncher = () => {
    launcherGeneration += 1
    launcherEventStop?.()
    launcherEventStop = undefined
    try { launcherHandle?.destroy?.() } catch { /* idempotent host cleanup */ }
    launcherHandle = undefined
    launcherPoint = undefined
  }

  const clearQuickToolbarAction = () => {
    quickToolbarActionStop?.()
    quickToolbarActionStop = undefined
    try { quickToolbarActionHandle?.destroy?.() } catch { /* idempotent host cleanup */ }
    quickToolbarActionHandle = undefined
  }

  const props = (surfaceId: SurfaceModuleOptions<T>['surfaceId'] | 'activated_lore.panel'): Record<string, unknown> => ({
    contractVersion: 1,
    ownerToken: context ? ownerToken(context) : 'lumiverse_suite',
    generation,
    capabilities: surfaceId === 'connections_picker.panel' || surfaceId === 'activated_lore.panel'
      ? ['close']
      : options.panel && surfaceId === options.surfaceId
        ? ['open']
        : [],
    state: surfaceId === 'connections_picker.panel'
      ? { ...settingsRecord(settings), open: panelOpen }
      : settingsRecord(settings),
  })

  const launcherProps = (): Record<string, unknown> => ({
    contractVersion: 1,
    ownerToken: context ? ownerToken(context) : 'lumiverse_suite',
    generation: launcherGeneration,
    capabilities: ['open'],
    state: settingsRecord(settings),
  })

  const hostApi = (): SuiteHostContext | undefined => {
    const host = context?.host
    if (!host?.ui?.mount || !host.components?.mountHostSurface) return undefined
    return host
  }

  const ownsCommand = (payload: unknown, surfaceId: string, command: string, expectedGeneration: number): boolean => {
    const value = payload as { command?: unknown; generation?: unknown; ownerToken?: unknown; invocationId?: unknown }
    if (value.command !== command
      || value.generation !== expectedGeneration
      || value.ownerToken !== (context ? ownerToken(context) : 'lumiverse_suite')
      || typeof value.invocationId !== 'string') return false
    const invocationId = value.invocationId
    if (!new RegExp(`^${surfaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${expectedGeneration}:\\d+$`).test(invocationId)) return false
    if (handledCommands.has(invocationId)) return false
    handledCommands.add(invocationId)
    return true
  }

  const mountLauncher = (host: NonNullable<ReturnType<typeof hostApi>>) => {
    if (!options.launcher || !settings) return
    const point = options.launcher.mountPoint(settings)
    if (launcherHandle && launcherPoint === point) {
      try {
        launcherHandle.update?.(launcherProps())
      } catch (error) {
        clearLauncher()
        throw error
      }
      return
    }
    clearLauncher()
    try {
      const root = host.ui!.mount!(asMount(point))
      launcherGeneration += 1
      launcherHandle = host.components!.mountHostSurface!(root, options.launcher.surfaceId, launcherProps())
      launcherPoint = point
      launcherEventStop = launcherHandle.on?.('command', payload => {
        if (!ownsCommand(payload, options.launcher!.surfaceId, 'open', launcherGeneration)) return
        panelOpen = true
        reconcile()
      })
    } catch (error) {
      clearLauncher()
      throw error
    }
  }

  const mountQuickToolbarAction = (host: NonNullable<ReturnType<typeof hostApi>>) => {
    const descriptor = options.quickToolbarAction
    const register = host.ui?.registerInputBarAction
    if (!descriptor || !register || quickToolbarActionHandle) return
    quickToolbarActionHandle = register({
      id: descriptor.id,
      label: descriptor.label,
      subtitle: descriptor.subtitle,
      iconName: descriptor.iconName,
      placement: 'quick_toolbar',
      enabled: true,
    } as Parameters<typeof register>[0]) as InputActionHandle
    quickToolbarActionStop = quickToolbarActionHandle.onClick?.(() => {
      if (!running || !settings || !options.enabled(settings)) return
      panelOpen = true
      reconcile()
    })
  }

  const mountSurface = (host: NonNullable<ReturnType<typeof hostApi>>) => {
    if (!settings || (options.surfaceId === 'connections_picker.panel' && !panelOpen)) {
      clearSurface()
      return
    }
    const surfaceId = options.panel && panelOpen ? options.panel.surfaceId : options.surfaceId
    const point = options.panel && panelOpen ? options.panel.mountPoint(settings) : options.mountPoint(settings)
    const mountKey = `${surfaceId}:${point}`
    if (inFlightMounts.has(mountKey)) return
    if (handle && mountedPoint === `${surfaceId}:${point}`) {
      try {
        handle.update?.(props(surfaceId))
      } catch (error) {
        clearSurface()
        throw error
      }
      return
    }
    clearSurface()
    inFlightMounts.add(mountKey)
    try {
      const root = host.ui!.mount!(asMount(point))
      generation += 1
      handle = host.components!.mountHostSurface!(root, surfaceId, props(surfaceId))
      mountedPoint = `${surfaceId}:${point}`
      if (surfaceId === 'connections_picker.panel' || surfaceId === 'activated_lore.panel') {
        eventStop = handle.on?.('command', payload => {
          if (!ownsCommand(payload, surfaceId, 'close', generation)) return
          panelOpen = false
          reconcile()
        })
      } else if (options.panel && surfaceId === options.surfaceId) {
        eventStop = handle.on?.('command', payload => {
          if (!ownsCommand(payload, surfaceId, 'open', generation)) return
          panelOpen = true
          reconcile()
        })
      }
    } catch (error) {
      clearSurface()
      throw error
    } finally {
      inFlightMounts.delete(mountKey)
    }
  }

  const reconcile = () => {
    if (!running || !context || !settings || !options.enabled(settings)) {
      panelOpen = false
      clearQuickToolbarAction()
      clearLauncher()
      clearSurface()
      return
    }
    const host = hostApi()
    if (!host) return
    mountQuickToolbarAction(host)
    mountLauncher(host)
    mountSurface(host)
  }

  const stopModule = () => {
    running = false
    watchStop?.()
    watchStop = undefined
    clearLauncher()
    clearSurface()
    clearQuickToolbarAction()
    handledCommands.clear()
    panelOpen = false
    settings = undefined
    context = undefined
  }

  return {
    id: options.id,
    async start(moduleContext?: SuiteModuleContext) {
      if (running || !moduleContext) return
      context = moduleContext
      const settingsApi = moduleContext.settings as SurfaceSettingsApi
      if (!settingsApi) throw new Error('SETTINGS_API_UNAVAILABLE')
      let canonical: unknown
      let canonicalSettingsSeen = false
      traceSettings('module:start', {
        moduleId: options.id,
        surfaceId: options.surfaceId,
        settingsKey: options.settingsKey,
        coreSettingsKey: options.coreSettingsKey,
      })
      try {
        canonical = settingsApi.core.get<unknown>(options.coreSettingsKey)
        canonicalSettingsSeen = canonical !== undefined
        traceSettings('module:canonical-read', {
          moduleId: options.id,
          canonicalSettingsSeen,
          portraitDock: options.settingsKey === 'portraitDockSettings' ? portraitDockSummary(canonical) : undefined,
        })
      } catch {
        traceSettings('module:canonical-read:unsupported', { moduleId: options.id })
        // Older core hosts reject unknown canonical keys; private settings remain usable.
      }
      // Current hosts expose the canonical productivity blob synchronously.
      // Do not touch the compatibility row in that case: it is a one-way
      // mirror and may be stale after a canonical write.
      const saved = canonicalSettingsSeen
        ? undefined
        : await settingsApi.get<unknown>(options.settingsKey)
      traceSettings('module:private-read', {
        moduleId: options.id,
        canonicalSettingsSeen,
        privateFound: saved !== undefined,
        portraitDock: options.settingsKey === 'portraitDockSettings' ? portraitDockSummary(saved) : undefined,
      })
      const source = canonical ?? saved
      // Extension schemas only describe the fields they actively consume. Keep
      // the rest of the host-owned blob intact so a newer core field survives
      // an extension lifecycle or a legacy fallback migration.
      const normalized = {
        ...(record(source) ?? {}),
        ...options.normalize(source),
      } as T
      settings = normalized
      traceSettings('module:normalized', {
        moduleId: options.id,
        canonicalSettingsSeen,
        enabled: options.enabled(normalized),
        portraitDock: options.settingsKey === 'portraitDockSettings' ? portraitDockSummary(normalized) : undefined,
        normalizationChanged: !sameValue(source, normalized),
      })
      running = true
      let stopLegacyWatch: () => void = () => undefined
      if (canonicalSettingsSeen) {
        // The core setting is authoritative on current hosts. Keeping a private
        // watcher alive here turns every SETTINGS_UPDATED broadcast into a stale
        // fallback read, which can race a freshly persisted canonical value.
      } else {
        const needsPrivateRepair = !sameValue(saved, normalized)
        const hostReady = settingsApi.core.isReady?.() ?? true
        traceSettings('module:legacy-repair-decision', {
          moduleId: options.id,
          needsPrivateRepair,
          hostReady,
        })
        // A legacy fallback repair made from a pre-hydration default can
        // overwrite the user's canonical value before the host GET finishes.
        // The next canonical/legacy watch will reconcile it after readiness.
        if (needsPrivateRepair && hostReady) {
          await settingsApi.set(options.settingsKey, normalized)
          traceSettings('module:legacy-repair-committed', { moduleId: options.id })
        } else if (needsPrivateRepair) {
          traceSettings('module:legacy-repair-deferred', { moduleId: options.id })
        }
        stopLegacyWatch = settingsApi.watch<unknown>(options.settingsKey, value => {
          if (!running || canonicalSettingsSeen) return
          const next = { ...(record(value) ?? {}), ...options.normalize(value) } as T
          const unchanged = sameValue(settings, next)
          traceSettings('module:private-watch', {
            moduleId: options.id,
            unchanged,
            portraitDock: options.settingsKey === 'portraitDockSettings' ? portraitDockSummary(next) : undefined,
          })
          if (unchanged) return
          settings = next
          reconcile()
        })
      }
      let stopCanonicalWatch: () => void = () => undefined
      try {
        stopCanonicalWatch = settingsApi.core.watch<unknown>(options.coreSettingsKey, value => {
          if (!running) return
          if (!canonicalSettingsSeen) {
            canonicalSettingsSeen = true
            traceSettings('module:canonical-watch-promoted', { moduleId: options.id })
            stopLegacyWatch()
            stopLegacyWatch = () => undefined
          }
          const next = { ...(record(value) ?? {}), ...options.normalize(value) } as T
          const unchanged = sameValue(settings, next)
          traceSettings('module:canonical-watch', {
            moduleId: options.id,
            unchanged,
            portraitDock: options.settingsKey === 'portraitDockSettings' ? portraitDockSummary(next) : undefined,
          })
          if (unchanged) return
          settings = next
          reconcile()
        })
      } catch {
        // Core settings are optional on legacy hosts; retain the private watch.
      }
      watchStop = () => {
        stopCanonicalWatch()
        stopLegacyWatch()
      }
      try {
        reconcile()
        traceSettings('module:reconciled', {
          moduleId: options.id,
          canonicalSettingsSeen,
          enabled: settings ? options.enabled(settings) : false,
          portraitDock: options.settingsKey === 'portraitDockSettings' ? portraitDockSummary(settings) : undefined,
        })
      } catch (error) {
        stopModule()
        throw error
      }
    },
    stop() {
      stopModule()
    },
  }
}
