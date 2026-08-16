import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

import type { SuiteSettingsAPI } from './shared/settings'
import { createSuiteBus, type SuiteBus } from './shared/bus'
import type { ConnectionsPickerBusPayloads } from './modules/connections_picker/types'
import type { PortraitDockBusPayloads } from './modules/portrait_dock/types'
import type { CharacterDisplayBusPayloads } from './modules/character_display/types'
import type { CharacterLibraryScopeBusPayloads } from './modules/character_library_scope/types'
import type { LorebookTokenCountsBusPayloads } from './modules/lorebook_token_counts/types'
import type { LorebookWorkspaceBusPayloads } from './modules/lorebook_workspace/types'
import type { HomepageLibraryBusPayloads } from './modules/homepage_library/types'
import {
  createStyleRegistry,
  type ModuleStyleLifecycle,
  type SuiteDOMAPI,
  type SuiteStyleRegistry,
} from './shared/styles'

export interface SuiteWorldBooksAPI {
  readonly entries: {
    list(bookId: string): Promise<{ readonly data: readonly unknown[]; readonly total: number }>
  }
}

export interface SuiteTokenCountOptions {
  readonly model?: string
  readonly modelSource?: 'main' | 'sidecar'
}

export interface SuiteTokensAPI {
  countText(text: string, options?: SuiteTokenCountOptions): Promise<unknown>
}

/** Public 0.6.16 registration surfaces that 0.6.12's published types do not yet name. */
export interface SuitePublicHostSurfaces {
  readonly settings?: SuiteSettingsAPI
  readonly dom?: SuiteDOMAPI
  readonly onTeardown?: (handler: () => void) => () => void
  readonly worldBooks?: SuiteWorldBooksAPI
  readonly tokens?: SuiteTokensAPI
  /** Flattened descriptor field accepted by suite test doubles. */
  readonly extensionInstallationId?: string
  registerDomDecorator?(options: {
    readonly target: string
    decorate(element: HTMLElement): void | (() => void)
  }): { destroy(): void }
  registerComponentOverride?(options: {
    readonly componentId: string
    render?(target: HTMLElement, props: Record<string, unknown>): void | (() => void)
  }): { destroy(): void }
  registerMessageAction?(options: {
    readonly id: string
    readonly label: string
    onClick(messageId: string): void
  }): { destroy(): void }
}

export type SuiteHostContext = SpindleFrontendContext & SuitePublicHostSurfaces & {
  readonly ui: SpindleFrontendContext['ui'] & {
    registerSettingsTab?(options: { readonly id: string; readonly title: string }): {
      readonly id: string
      readonly root: HTMLElement
      update?(options?: { readonly id?: string; readonly title?: string }): void
      destroy(): void
    }
    geometry?: {
      layoutElementRect(element: Element): DOMRect | { readonly height: number }
      createResizeController?(
        element: HTMLElement,
        options: unknown,
      ): { destroy(): void } | (() => void)
    }
  }
  readonly components: SpindleFrontendContext['components'] & {
    mountHostSurface(
      target: Element,
      surfaceId: string,
      props?: Record<string, unknown>,
    ): {
      update?(props: Record<string, unknown>): void
      destroy(): void
      on?(event: string, listener: (payload: unknown) => void): () => void
    }
  }
}

export const MODULE_IDS = [
  'quick_toolbar',
  'lore_indicator',
  'connections_picker',
  'portrait_dock',
  'character_display',
  'character_library_scope',
  'lorebook_token_counts',
  'lorebook_workspace',
  'homepage_library',
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

export type SuiteBusPayloads =
  & ConnectionsPickerBusPayloads
  & PortraitDockBusPayloads
  & CharacterLibraryScopeBusPayloads
  & LorebookTokenCountsBusPayloads
  & CharacterDisplayBusPayloads
  & LorebookWorkspaceBusPayloads
  & HomepageLibraryBusPayloads


export interface SuiteModuleContext {
  readonly moduleId: ModuleId
  readonly settings: SuiteSettingsAPI | undefined
  readonly styles: ModuleStyleLifecycle
  readonly host: SuiteHostContext
  readonly bus?: SuiteBus<SuiteBusPayloads>
}

export interface SuiteModule {
  readonly id: ModuleId
  start(context?: SuiteModuleContext): unknown | Promise<unknown>
  stop(): unknown | Promise<unknown>
}

export interface SuiteModuleRegistration {
  readonly module: SuiteModule
  readonly enabled: boolean
}

export interface SuiteModuleDiagnostic {
  readonly moduleId: ModuleId
  readonly error: unknown
}

export interface LumiverseSuite {
  start(): Promise<void>
  stop(): Promise<void>
  getDiagnostics(): readonly SuiteModuleDiagnostic[]
}

const PRODUCTIVITY_TAB = {
  id: 'productivity',
  title: 'UI Productivity',
}

function createProductivitySettingsLifecycle(ctx: SuiteHostContext, generation: number): () => void {
  const register = ctx.ui?.registerSettingsTab
  const mount = ctx.components?.mountHostSurface
  if (typeof register !== 'function' || typeof mount !== 'function') return () => undefined

  let destroyed = false
  const registration = register(PRODUCTIVITY_TAB)
  const props = {
    contractVersion: 1,
    ownerToken: 'lumiverse_suite_productivity',
    generation,
    capabilities: [],
  }
  const renderer = mount(registration.root, 'productivity.settings.workspace', props)

  return () => {
    if (destroyed) return
    destroyed = true
    renderer.destroy()
    registration.destroy()
  }
}

export function createSuite(
  ctx: SuiteHostContext,
  registrations: readonly SuiteModuleRegistration[] = [],
): LumiverseSuite {
  const styles: SuiteStyleRegistry = createStyleRegistry(ctx.dom)
  const started: Array<{ readonly module: SuiteModule; readonly styles: ModuleStyleLifecycle }> = []
  const diagnostics: SuiteModuleDiagnostic[] = []
  let running = false
  let bus = createSuiteBus<SuiteBusPayloads>()
  let productivitySettingsGeneration = 0
  let destroyProductivitySettings: (() => void) | undefined

  const stopStarted = async (): Promise<unknown | undefined> => {
    let firstError: unknown
    while (started.length > 0) {
      const current = started.pop()
      if (!current) continue
      try {
        await current.module.stop()
      } catch (error) {
        firstError ??= error
      } finally {
        current.styles.dispose()
      }
    }
    return firstError
  }

  return {
    async start() {
      if (running) return
      diagnostics.length = 0
      running = true
      if (bus.disposed) bus = createSuiteBus<SuiteBusPayloads>()
      destroyProductivitySettings = createProductivitySettingsLifecycle(ctx, ++productivitySettingsGeneration)

      // The homepage is the first visible suite surface. Start it before
      // sibling modules that may await settings or other host requests.
      const startupRegistrations = [
        ...registrations.filter(registration => registration.module.id === 'homepage_library'),
        ...registrations.filter(registration => registration.module.id !== 'homepage_library'),
      ]

      for (const registration of startupRegistrations) {
        if (!registration.enabled) continue
        const moduleStyles = styles.forModule(registration.module.id)
        try {
          await registration.module.start({
            moduleId: registration.module.id,
            settings: ctx.settings,
            styles: moduleStyles,
            host: ctx,
            bus,
          })
          started.push({ module: registration.module, styles: moduleStyles })
        } catch (error) {
          diagnostics.push({ moduleId: registration.module.id, error })
          console.error('[Lumiverse Suite] Module start failed:', registration.module.id, error)
          try {
            await registration.module.stop()
          } catch {
            // A failed start is already diagnosed; cleanup remains best effort.
          }
          moduleStyles.dispose()
        }
      }

      running = started.length > 0
      if (!running) {
        destroyProductivitySettings?.()
        destroyProductivitySettings = undefined
        styles.disposeAll()
        bus.dispose()
      }
    },
    async stop() {
      if (!running && started.length === 0) return
      running = false

      // Modules stop in reverse registration order, so action owners reject and
      // deregister commands before their workspaces and subscriptions disappear.
      const firstError = await stopStarted()
      try {
        destroyProductivitySettings?.()
        destroyProductivitySettings = undefined
      } finally {
        styles.disposeAll()
        bus.dispose()
      }
      if (firstError !== undefined) throw firstError
    },
    getDiagnostics() {
      return diagnostics.slice()
    },
  }
}
