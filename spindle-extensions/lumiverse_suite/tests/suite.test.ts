import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { MODULE_IDS, createSuite } from '../src/suite'
import type { ModuleId, SuiteHostContext, SuiteModule } from '../src/suite'
import { setup } from '../src/frontend'
import type { SuiteSettingsAPI } from '../src/shared/settings'

const extensionUuid = 'b3693b08-b998-4a5e-bd51-0a8262f2e2a2'
let dom: JSDOM

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><head></head><body><div data-spindle-mount="chat_toolbar"></div></body></html>', {
    url: 'https://lumiverse.test/chat',
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    StorageEvent: dom.window.StorageEvent,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
  })
})

afterEach(() => {
  dom.window.close()
})

type ContextOptions = {
  readonly settings?: Readonly<Record<string, unknown>>
  readonly onTeardown?: Array<() => void | Promise<void>>
  readonly productivity?: {
    readonly registrations: Array<Record<string, unknown>>
    readonly mounts: Array<{ id: string; props: Record<string, unknown> }>
    readonly updates: Array<Record<string, unknown>>
    readonly destroyed: { registration: number; renderer: number; unsubscribe: number }
  }
}

function defaultAddStyle(css: string): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-lumiverse-suite-theme-bridge', '')
  style.textContent = css
  document.head.append(style)
  return () => style.remove()
}

function context(
  permissionCalls: Array<{ permissions: string[]; reason?: string }>,
  addStyle: (css: string) => () => void = defaultAddStyle,
  options: ContextOptions = {},
): SuiteHostContext {
  const values = new Map(Object.entries(options.settings ?? {}))
  const settings: SuiteSettingsAPI = {
    get: async <Value>(key: string) => values.get(key) as Value | undefined,
    set: async <Value>(key: string, value: Value) => {
      values.set(key, value)
    },
    remove: async (key: string) => {
      values.delete(key)
    },
    watch: () => () => undefined,
    core: {
      get: () => undefined,
      watch: () => () => undefined,
      list: () => [],
    },
  }
  return {
    host: { extensionInstallationId: extensionUuid },
    permissions: {
      request: async (permissions: string[], options?: { reason?: string }) => {
        permissionCalls.push({ permissions, reason: options?.reason })
        return permissions
      },
    },
    ui: {
      mount: (point: string) => {
        const target = document.querySelector(`[data-spindle-mount="${point}"]`)
        if (!target) throw new Error(`Missing test mount point: ${point}`)
        const root = document.createElement('div')
        root.setAttribute('data-spindle-extension-root', extensionUuid)
        target.append(root)
        return root
      },
      registerSettingsTab: (registrationOptions: Record<string, unknown>) => {
        options.productivity?.registrations.push(registrationOptions)
        const root = document.createElement('section')
        root.dataset.testProductivitySettings = 'true'
        document.body.append(root)
        let active = true
        return {
          root,
          registrationId: 'test-productivity',
          tabId: 'productivity',
          activate: () => undefined,
          onActivate: (callback: () => void) => {
            callback()
            return () => { options.productivity?.destroyed && (options.productivity.destroyed.unsubscribe += 1) }
          },
          update: () => undefined,
          destroy: () => {
            if (!active) return
            active = false
            options.productivity?.destroyed && (options.productivity.destroyed.registration += 1)
            root.remove()
          },
        }
      },
    },
    components: {
      mountHostSurface: (_target: HTMLElement, id: string, props: Record<string, unknown>) => {
        options.productivity?.mounts.push({ id, props })
        let active = true
        return {
          update: (next: Record<string, unknown>) => options.productivity?.updates.push(next),
          destroy: () => {
            if (!active) return
            active = false
            options.productivity?.destroyed && (options.productivity.destroyed.renderer += 1)
          },
        }
      },
    },
    settings,
    dom: { addStyle },
    onTeardown: options.onTeardown
      ? (handler: () => void) => {
          options.onTeardown?.push(handler)
          return () => {
            const index = options.onTeardown?.indexOf(handler) ?? -1
            if (index >= 0) options.onTeardown?.splice(index, 1)
          }
        }
      : undefined,
    worldBooks: { entries: async () => [] },
    tokens: {
      countText: async () => ({ token_count: 0, char_count: 0 }),
      countTextBatch: async () => [],
    },
  } as unknown as SuiteHostContext
}

function module(id: ModuleId, calls: string[]): SuiteModule {
  return {
    id,
    start: () => calls.push(`start:${id}`),
    stop: () => calls.push(`stop:${id}`),
  }
}

describe('Lumiverse Suite runtime', () => {
  test('publishes the fixed nine-module registry', () => {
    expect(MODULE_IDS).toEqual([
      'quick_toolbar',
      'lore_indicator',
      'connections_picker',
      'portrait_dock',
      'character_display',
      'character_library_scope',
      'lorebook_token_counts',
      'lorebook_workspace',
      'homepage_library',
    ])
  })

  test('is inert when its registry has no implemented enabled modules', async () => {
    const permissionCalls: Array<{ permissions: string[]; reason?: string }> = []
    const before = document.body.innerHTML
    const suite = createSuite(context(permissionCalls))

    await suite.start()

    expect(document.body.innerHTML).toBe(before)
    expect(permissionCalls).toEqual([])

    await suite.stop()
  })

  test('owns the theme bridge for the full frontend lifecycle', async () => {
    const teardown = await setup(context([]))

    expect(document.head.querySelector('[data-lumiverse-suite-theme-bridge]')).not.toBeNull()
    expect(document.body.querySelector('[data-lumiverse-module="quick_toolbar"]')).toBeNull()

    await teardown()
    await teardown()

    expect(document.head.querySelector('[data-lumiverse-suite-theme-bridge]')).toBeNull()
  })

  test('keeps homepage bootstrap-disabled while other modules honor their private enabled path and host teardown', async () => {
    const hostTeardowns: Array<() => void | Promise<void>> = []
    const teardown = await setup(context([], () => () => undefined, {
      settings: {
        'quick_toolbar:enabled': true,
        'homepage_library:enabled': true,
      },
      onTeardown: hostTeardowns,
    }))

    expect(document.body.querySelector('[data-lumiverse-module="quick_toolbar"]')).toBeNull()
    expect(document.body.querySelector('[data-lumiverse-module="homepage_library"]')).toBeNull()
    expect(hostTeardowns).toHaveLength(1)

    await hostTeardowns[0]!()

    expect(document.head.querySelector('[data-lumiverse-suite-theme-bridge]')).toBeNull()
    expect(hostTeardowns).toHaveLength(0)
    await teardown()
  })

  test('starts only modules explicitly enabled by the registry', async () => {
    const calls: string[] = []
    const suite = createSuite(context([]), [
      { module: module('quick_toolbar', calls), enabled: true },
      { module: module('lore_indicator', calls), enabled: false },
    ])

    await suite.start()

    expect(calls).toEqual(['start:quick_toolbar'])
    await suite.stop()
    expect(calls).toEqual(['start:quick_toolbar', 'stop:quick_toolbar'])
  })

  test('starts the homepage before a deferred sibling and tears down in reverse start order', async () => {
    const calls: string[] = []
    let releaseSibling!: () => void
    const siblingStarted = new Promise<void>(resolve => { releaseSibling = resolve })
    const suite = createSuite(context([]), [
      {
        enabled: true,
        module: {
          id: 'quick_toolbar',
          start: async () => {
            calls.push('start:quick_toolbar')
            await siblingStarted
          },
          stop: () => calls.push('stop:quick_toolbar'),
        },
      },
      { module: module('homepage_library', calls), enabled: true },
    ])

    const starting = suite.start()
    await Promise.resolve()

    expect(calls).toEqual(['start:homepage_library', 'start:quick_toolbar'])

    releaseSibling()
    await starting
    await suite.stop()

    expect(calls).toEqual([
      'start:homepage_library',
      'start:quick_toolbar',
      'stop:quick_toolbar',
      'stop:homepage_library',
    ])
  })

  test('registers one suite-owned Productivity host surface and destroys it in lifecycle order', async () => {
    const productivity = {
      registrations: [] as Array<Record<string, unknown>>,
      mounts: [] as Array<{ id: string; props: Record<string, unknown> }>,
      updates: [] as Array<Record<string, unknown>>,
      destroyed: { registration: 0, renderer: 0, unsubscribe: 0 },
    }
    const suite = createSuite(context([], () => () => undefined, { productivity }), [
      { module: module('character_display', []), enabled: true },
      { module: module('character_library_scope', []), enabled: true },
    ])

    await suite.start()

    expect(productivity.registrations).toHaveLength(1)
    expect(productivity.registrations[0]).toMatchObject({ id: 'productivity', title: 'UI Productivity' })
    expect(productivity.mounts).toEqual([{
      id: 'productivity.settings.workspace',
      props: {
        contractVersion: 1,
        ownerToken: 'lumiverse_suite_productivity',
        generation: 1,
        capabilities: [],
      },
    }])

    await suite.stop()
    await suite.stop()

    expect(productivity.destroyed.renderer).toBe(1)
    expect(productivity.destroyed.registration).toBe(1)
    expect(document.querySelector('[data-test-productivity-settings]')).toBeNull()
  })

  test('records a failed module, cleans it up, and keeps healthy siblings in reverse teardown order', async () => {
    const calls: string[] = []
    const startupError = Object.assign(new Error('lore indicator start failed'), { privateContext: 'do not expose' })
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined)
    const suite = createSuite(context([]), [
      { module: module('quick_toolbar', calls), enabled: true },
      {
        enabled: true,
        module: {
          id: 'lore_indicator',
          start: () => {
            const root = document.createElement('div')
            root.setAttribute('data-spindle-extension-root', extensionUuid)
            root.setAttribute('data-lumiverse-module', 'lore_indicator')
            document.body.append(root)
            calls.push('start:lore_indicator')
            throw startupError
          },
          stop: () => {
            document.querySelector('[data-lumiverse-module="lore_indicator"]')?.remove()
            calls.push('stop:lore_indicator')
          },
        },
      },
      { module: module('connections_picker', calls), enabled: true },
    ])

    try {
      await suite.start()

      expect(calls).toEqual([
        'start:quick_toolbar',
        'start:lore_indicator',
        'stop:lore_indicator',
        'start:connections_picker',
      ])
      expect(suite.getDiagnostics()).toEqual([{ moduleId: 'lore_indicator', error: startupError }])
      expect(consoleError).toHaveBeenCalledWith(
        '[Lumiverse Suite] Module start failed:',
        'lore_indicator',
        startupError,
      )
      expect(document.querySelector('[data-lumiverse-module="lore_indicator"]')).toBeNull()

      await suite.stop()
      await suite.stop()

      expect(calls).toEqual([
        'start:quick_toolbar',
        'start:lore_indicator',
        'stop:lore_indicator',
        'start:connections_picker',
        'stop:connections_picker',
        'stop:quick_toolbar',
      ])
      expect(suite.getDiagnostics()[0]?.error).toBe(startupError)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('stops started modules once in reverse start order', async () => {
    const calls: string[] = []
    const suite = createSuite(context([]), [
      { module: module('quick_toolbar', calls), enabled: true },
      { module: module('lore_indicator', calls), enabled: true },
      { module: module('connections_picker', calls), enabled: true },
    ])

    await suite.start()
    await suite.stop()
    await suite.stop()

    expect(calls).toEqual([
      'start:quick_toolbar',
      'start:lore_indicator',
      'start:connections_picker',
      'stop:connections_picker',
      'stop:lore_indicator',
      'stop:quick_toolbar',
    ])
  })

  test('unloads via typed disposers without document-wide node scraping when stop fails', async () => {
    const stopError = new Error('quick toolbar stop failed')
    document.body.innerHTML = `
      <section data-spindle-extension-root="${extensionUuid}">
        <div id="owned-module" data-lumiverse-module="quick_toolbar"></div>
        <div id="owned-other-module" data-lumiverse-module="lore_indicator"></div>
      </section>
      <section id="owned-injected-wrapper" data-spindle-ext="${extensionUuid}" data-lumiverse-module="quick_toolbar">
        <div id="owned-injected-module" data-lumiverse-module="quick_toolbar"></div>
      </section>
      <section data-spindle-extension-root="another-extension">
        <div id="foreign-module" data-lumiverse-module="quick_toolbar"></div>
      </section>
    `
    const suite = createSuite(context([]), [
      {
        enabled: true,
        module: {
          id: 'quick_toolbar',
          start: () => undefined,
          stop: () => {
            throw stopError
          },
        },
      },
    ])

    await suite.start()
    await expect(suite.stop()).rejects.toBe(stopError)

    expect(document.querySelector('#owned-module')).not.toBeNull()
    expect(document.querySelector('#owned-injected-wrapper')).not.toBeNull()
    expect(document.querySelector('#owned-other-module')).not.toBeNull()
    expect(document.querySelector('#foreign-module')).not.toBeNull()
  })


  test('disposes module styles through typed style disposers during suite teardown', async () => {
    const installed: string[] = []
    const host = context([], (css) => {
      installed.push(css)
      return () => {
        const index = installed.indexOf(css)
        if (index >= 0) installed.splice(index, 1)
      }
    })
    const suite = createSuite(host, [
      {
        enabled: true,
        module: {
          id: 'quick_toolbar',
          start: moduleContext => {
            if (!moduleContext) throw new Error('missing module context')
            moduleContext.styles.add('quick-toolbar-style')
            const root = document.createElement('section')
            root.setAttribute('data-spindle-extension-root', extensionUuid)
            const node = document.createElement('div')
            node.setAttribute('data-lumiverse-module', 'quick_toolbar')
            root.append(node)
            document.body.append(root)
          },
          stop: () => {
            document.querySelector('[data-lumiverse-module="quick_toolbar"]')?.parentElement?.remove()
          },
        },
      },
    ])

    await suite.start()
    expect(installed).toEqual(['quick-toolbar-style'])
    expect(document.querySelector('[data-lumiverse-module="quick_toolbar"]')).not.toBeNull()

    await suite.stop()
    expect(installed).toEqual([])
    expect(document.querySelector('[data-lumiverse-module="quick_toolbar"]')).toBeNull()
  })
})
