import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import { createLorebookWorkspaceModule } from '../../src/modules/lorebook_workspace'
import {
  LOREBOOK_WORKSPACE_SETTINGS_KEY,
  type LorebookWorkspaceSettings,
} from '../../src/modules/lorebook_workspace/types'
import { createSuiteBus } from '../../src/shared/bus'
import { createStyleRegistry, type SuiteDOMAPI } from '../../src/shared/styles'
import type { SuiteModuleContext } from '../../src/suite'
import type { SuiteSettingsAPI } from '../../src/shared/settings'

const MODULE_ID = 'lorebook_workspace'
const EXTENSION_UUID = 'lorebook-workspace-test'
const MOUNT_POINT = 'lorebook_workspace'

let dom: JSDOM

type Callback = (value: unknown) => void
type SurfaceRecord = {
  target: HTMLElement
  id: string
  props: Record<string, unknown>
  updates: Array<Record<string, unknown>>
  listeners: Map<string, Set<Callback>>
  destroyCount: number
  active: boolean
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function createHarness(saved: LorebookWorkspaceSettings, grant = true) {
  const values = new Map<string, unknown>([[LOREBOOK_WORKSPACE_SETTINGS_KEY, saved]])
  const settingWatchers = new Set<(value: unknown) => void>()
  const bus = createSuiteBus<Record<string, unknown>>()
  const surfaces: SurfaceRecord[] = []
  const permissionRequests: Array<{ permissions: string[]; reason?: string }> = []
  const mountCalls: string[] = []
  const styleNodes = new Set<HTMLElement>()
  let nativeRoot: HTMLElement

  const settings: SuiteSettingsAPI = {
    async get<T>(key: string) { return values.get(key) as T | undefined },
    async set<T>(key: string, value: T) {
      values.set(key, value)
      for (const watcher of [...settingWatchers]) watcher(value)
    },
    async remove(key: string) { values.delete(key) },
    watch<T>(key: string, callback: (value: T | undefined) => void) {
      if (key !== LOREBOOK_WORKSPACE_SETTINGS_KEY) return () => undefined
      const listener = callback as (value: unknown) => void
      settingWatchers.add(listener)
      return () => settingWatchers.delete(listener)
    },
    core: { get: () => undefined, watch: () => () => undefined, list: () => [] },
  }

  const domApi: SuiteDOMAPI = {
    addStyle(css: string) {
      const node = document.createElement('style')
      node.textContent = css
      styleNodes.add(node)
      document.head.append(node)
      return () => {
        styleNodes.delete(node)
        node.remove()
      }
    },
  }

  const ui = {
    mount(point: string) {
      mountCalls.push(point)
      if (point !== MOUNT_POINT) throw new Error(`unexpected mount point: ${point}`)
      return nativeRoot
    },
  }

  const components = {
    mountHostSurface(target: HTMLElement, id: string, props: Record<string, unknown>) {
      const record: SurfaceRecord = {
        target,
        id,
        props: { ...props },
        updates: [],
        listeners: new Map(),
        destroyCount: 0,
        active: true,
      }
      surfaces.push(record)
      return {
        update(nextProps: Record<string, unknown>) {
          record.props = { ...nextProps }
          record.updates.push({ ...nextProps })
        },
        on(event: string, listener: Callback) {
          const listeners = record.listeners.get(event) ?? new Set<Callback>()
          listeners.add(listener)
          record.listeners.set(event, listeners)
          return () => listeners.delete(listener)
        },
        destroy() {
          if (!record.active) return
          record.active = false
          record.destroyCount += 1
        },
      }
    },
  }

  const host = {
    extensionInstallationId: EXTENSION_UUID,
    ui,
    components,
    permissions: {
      async request(requested: string[], options?: { reason?: string }) {
        permissionRequests.push({ permissions: requested, reason: options?.reason })
        return grant ? requested : []
      },
    },
  }
  const ctx = {
    host,
    ui,
    components,
    settings,
    dom: domApi,
    bus,
  } as unknown as SuiteModuleContext

  return {
    ctx,
    values,
    domApi,
    bus,
    surfaces,
    mountCalls,
    permissionRequests,
    styleNodes,
    settingWatchers,
    setNativeRoot(root: HTMLElement) { nativeRoot = root },
    emitSelect(entryId: string) {
      const table = surfaces.find(surface => surface.id === 'world_book_entry_table' && surface.active)
      for (const listener of [...(table?.listeners.get('select') ?? [])]) listener({ entryId })
    },
  }
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://lumiverse.test/' })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
  })
})

afterEach(() => dom.window.close())

describe('lorebook_workspace runtime', () => {
  test('normalizes persisted settings and remounts the workspace for a selected book', async () => {
    const nativeRoot = document.createElement('section')
    nativeRoot.dataset.spindleMount = MOUNT_POINT
    const nativeChild = document.createElement('span')
    nativeChild.dataset.native = 'true'
    nativeRoot.append(nativeChild)
    document.body.append(nativeRoot)

    const harness = createHarness({
      enabled: true,
      bookId: ' book-1 ',
      density: 'compact',
    })
    harness.setNativeRoot(nativeRoot)
    const module = createLorebookWorkspaceModule()
    const styles = createStyleRegistry(harness.domApi).forModule(MODULE_ID as never)
    await module.start({ ...harness.ctx, styles } as SuiteModuleContext)

    expect(harness.values.get(LOREBOOK_WORKSPACE_SETTINGS_KEY)).toEqual({
      enabled: true,
      bookId: 'book-1',
      density: 'compact',
    })
    expect(harness.surfaces[0]?.props).toEqual({ bookId: 'book-1' })

    harness.bus.emit('lorebook-workspace/book-selected', { book_id: 'book-2', density: 'default' })
    await flush()

    expect(harness.values.get(LOREBOOK_WORKSPACE_SETTINGS_KEY)).toEqual({
      enabled: true,
      bookId: 'book-2',
      density: 'default',
    })
    expect(harness.surfaces.filter(surface => surface.id === 'world_book_entry_table' && surface.active))
      .toHaveLength(1)
    expect(harness.surfaces.at(-1)?.props).toEqual({ bookId: 'book-2' })
    expect(nativeChild.isConnected).toBe(true)
    await module.stop()
  })

  test('mounts the free table and lazily mounts the gated editor on selection', async () => {
    const nativeRoot = document.createElement('section')
    nativeRoot.dataset.spindleMount = MOUNT_POINT
    const nativeChild = document.createElement('span')
    nativeChild.dataset.native = 'true'
    nativeRoot.append(nativeChild)
    document.body.append(nativeRoot)

    const harness = createHarness({ enabled: true, bookId: 'book-1', density: 'compact' })
    harness.setNativeRoot(nativeRoot)
    const module = createLorebookWorkspaceModule()
    const styles = createStyleRegistry(harness.domApi).forModule(MODULE_ID as never)
    await module.start({ ...harness.ctx, styles } as SuiteModuleContext)

    expect(harness.mountCalls.at(-1)).toBe(MOUNT_POINT)
    expect(harness.surfaces.map(surface => [surface.id, surface.props])).toEqual([
      ['world_book_entry_table', { bookId: 'book-1' }],
    ])
    expect(harness.permissionRequests).toHaveLength(0)
    expect(nativeChild.isConnected).toBe(true)

    harness.emitSelect('entry-1')
    await flush()
    expect(harness.permissionRequests).toHaveLength(1)
    expect(harness.permissionRequests[0]?.permissions).toEqual(['world_books'])
    expect(harness.surfaces.map(surface => [surface.id, surface.props])).toEqual([
      ['world_book_entry_table', { bookId: 'book-1', selectedEntryId: 'entry-1' }],
      ['world_book_entry_editor', { bookId: 'book-1', entryId: 'entry-1', density: 'compact' }],
    ])

    harness.emitSelect('entry-2')
    await flush()
    const editor = harness.surfaces.find(surface => surface.id === 'world_book_entry_editor')!
    expect(editor.updates.at(-1)).toEqual({ bookId: 'book-1', entryId: 'entry-2', density: 'compact' })
    expect(harness.surfaces.filter(surface => surface.id === 'world_book_entry_editor')).toHaveLength(1)

    await module.stop()
  })

  test('keeps native host content when disabled and after stop', async () => {
    const nativeRoot = document.createElement('section')
    nativeRoot.dataset.spindleMount = MOUNT_POINT
    const nativeChild = document.createElement('span')
    nativeChild.textContent = 'native'
    nativeRoot.append(nativeChild)
    document.body.append(nativeRoot)

    const disabledHarness = createHarness({ enabled: false, bookId: 'book-1', density: 'default' })
    disabledHarness.setNativeRoot(nativeRoot)
    const disabled = createLorebookWorkspaceModule()
    const disabledStyles = createStyleRegistry(disabledHarness.domApi).forModule(MODULE_ID as never)
    await disabled.start({ ...disabledHarness.ctx, styles: disabledStyles } as SuiteModuleContext)
    expect(disabledHarness.surfaces).toHaveLength(0)
    expect(nativeChild.isConnected).toBe(true)
    await disabled.stop()

    const activeHarness = createHarness({ enabled: true, bookId: 'book-1', density: 'default' })
    activeHarness.setNativeRoot(nativeRoot)
    const active = createLorebookWorkspaceModule()
    const activeStyles = createStyleRegistry(activeHarness.domApi).forModule(MODULE_ID as never)
    await active.start({ ...activeHarness.ctx, styles: activeStyles } as SuiteModuleContext)
    expect(nativeChild.isConnected).toBe(true)
    await active.stop()
    expect(nativeChild.isConnected).toBe(true)
    expect(nativeRoot.querySelector(`[data-lumiverse-module="${MODULE_ID}"]`)).toBeNull()
  })
})
