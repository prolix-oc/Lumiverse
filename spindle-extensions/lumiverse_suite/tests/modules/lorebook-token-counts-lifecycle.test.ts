import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createSuiteBus } from '../../src/shared/bus'
import { createLorebookTokenCountsModule, LOREBOOK_TOKEN_COUNTS_ENABLED_KEY } from '../../src/modules/lorebook_token_counts'
import type { SuiteBusPayloads, SuiteModuleContext } from '../../src/suite'
import type { SuiteSettingsAPI } from '../../src/shared/settings'

const MODULE_ID = 'lorebook_token_counts'
const UUID = 'token-counts-test'
const BOOK_ID = 'book-1'

let dom: JSDOM
let originalDocument: Document | undefined
let originalMutationObserver: typeof MutationObserver | undefined

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15))
}

function createHarness() {
  const values = new Map<string, unknown>([[LOREBOOK_TOKEN_COUNTS_ENABLED_KEY, true]])
  const watchers = new Map<string, Set<(value: unknown) => void>>()
  let entriesCalls = 0
  let countCalls = 0
  let styleDisposals = 0
  let entries: readonly unknown[] = [{ id: 'entry-1', content: 'count me', updated_at: 1, revision: 1 }]
  const texts: string[] = []
  const decoratorStops: Array<() => void> = []
  const decorate = { fn: undefined as undefined | ((element: HTMLElement) => void | (() => void)) }
  const settings: SuiteSettingsAPI = {
    async get<T>(key: string) { return values.get(key) as T | undefined },
    async set<T>(key: string, value: T) {
      values.set(key, value)
      for (const listener of watchers.get(key) ?? []) listener(value)
    },
    async remove(key: string) { values.delete(key) },
    watch<T>(key: string, callback: (value: T | undefined) => void) {
      const listeners = watchers.get(key) ?? new Set<(value: unknown) => void>()
      listeners.add(callback as (value: unknown) => void)
      watchers.set(key, listeners)
      return () => listeners.delete(callback as (value: unknown) => void)
    },
    core: { get: () => undefined, watch: () => () => undefined, list: () => [] },
  }
  const bus = createSuiteBus<SuiteBusPayloads>()
  const ctx = {
    moduleId: MODULE_ID,
    settings,
    styles: {
      add: () => () => { styleDisposals += 1 },
      clear: () => { styleDisposals += 1 },
      disposed: false,
      size: 0,
    },
    bus,
    host: {
      extensionInstallationId: UUID,
      worldBooks: {
        entries: {
          async list() {
            entriesCalls += 1
            return { data: entries, total: entries.length }
          },
        },
      },
      tokens: {
        async countText(text: string) {
          countCalls += 1
          texts.push(text)
          return { total_tokens: 9, approximate: false, model: 'test-model' }
        },
      },
      registerDomDecorator(options: { target: string; decorate: (element: HTMLElement) => void | (() => void) }) {
        decorate.fn = options.decorate
        document.querySelectorAll<HTMLElement>(options.target).forEach(element => {
          const stop = options.decorate(element)
          if (stop) decoratorStops.push(stop)
        })
        return {
          destroy() {
            for (const stop of decoratorStops.splice(0).reverse()) stop()
            decorate.fn = undefined
          },
        }
      },
    },
  } as unknown as SuiteModuleContext
  return {
    ctx,
    values,
    entriesCalls: () => entriesCalls,
    countCalls: () => countCalls,
    countedTexts: () => [...texts],
    decorate,
    setEntries(next: readonly unknown[]) { entries = [...next] },
    styleDisposals: () => styleDisposals,
  }
}

function appendBookRow(decorate: { fn?: (element: HTMLElement) => void | (() => void) }, entryId = 'entry-1', revision = '1'): HTMLElement {
  const root = document.createElement('section')
  root.dataset.worldBookEntriesBookId = BOOK_ID
  const row = document.createElement('div')
  row.dataset.worldBookEntryRow = entryId
  row.dataset.worldBookEntryRevision = revision
  root.append(row)
  document.body.append(root)
  decorate.fn?.(row)
  return row
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>')
  originalDocument = globalThis.document
  originalMutationObserver = globalThis.MutationObserver
  Object.assign(globalThis, { document: dom.window.document, MutationObserver: dom.window.MutationObserver })
})

afterEach(() => {
  Object.assign(globalThis, { document: originalDocument, MutationObserver: originalMutationObserver })
  dom.window.close()
})

describe('lorebook_token_counts module', () => {
  test('injects one accurate badge, reuses lifecycle cache on remount, and tears down on disable/stop', async () => {
    const harness = createHarness()
    const module = createLorebookTokenCountsModule()
    const updates: unknown[] = []
    harness.ctx.bus?.on('tokens/count-updated', (payload) => updates.push(payload))
    await module.start(harness.ctx)

    const firstRow = appendBookRow(harness.decorate)
    await flush()
    expect(firstRow.querySelectorAll(`[data-lumiverse-token-count-badge]`)).toHaveLength(1)
    expect(firstRow.textContent).toBe('9')
    expect(harness.countCalls()).toBe(1)
    expect(harness.countedTexts()).toEqual(['count me'])
    expect(updates).toHaveLength(1)

    firstRow.append(document.createElement('span'))
    await flush()
    expect(firstRow.querySelectorAll(`[data-lumiverse-token-count-badge]`)).toHaveLength(1)
    expect(harness.countCalls()).toBe(1)

    firstRow.remove()
    const remounted = appendBookRow(harness.decorate)
    await flush()
    expect(remounted.querySelectorAll(`[data-lumiverse-token-count-badge]`)).toHaveLength(1)
    expect(harness.countCalls()).toBe(1)

    await harness.ctx.settings!.set(LOREBOOK_TOKEN_COUNTS_ENABLED_KEY, false)
    await flush()
    expect(document.querySelectorAll(`[data-lumiverse-token-count-badge]`)).toHaveLength(0)
    expect(harness.styleDisposals()).toBeGreaterThan(0)

    const disabledRow = appendBookRow(harness.decorate)
    await flush()
    expect(disabledRow.querySelector(`[data-lumiverse-token-count-badge]`)).toBeNull()

    await harness.ctx.settings!.set(LOREBOOK_TOKEN_COUNTS_ENABLED_KEY, true)
    await flush()
    expect(disabledRow.querySelector(`[data-lumiverse-token-count-badge]`)).not.toBeNull()
    expect(harness.countCalls()).toBe(1)

    await module.stop()
    document.body.append(document.createElement('div'))
    await flush()
    expect(document.querySelectorAll(`[data-lumiverse-token-count-badge]`)).toHaveLength(0)
    expect(harness.entriesCalls()).toBeGreaterThan(0)
  })

  test('uses bounded public countText calls and yields between batches', async () => {
    const harness = createHarness()
    harness.setEntries(Array.from({ length: 65 }, (_, index) => ({
      id: `entry-${index}`,
      content: `entry-${index}`,
      updated_at: index + 1,
      revision: 1,
    })))
    const module = createLorebookTokenCountsModule()
    await module.start(harness.ctx)

    for (let index = 0; index < 65; index += 1) appendBookRow(harness.decorate, `entry-${index}`)
    await flush()
    await flush()

    expect(harness.countCalls()).toBe(65)
    expect(harness.countedTexts()).toHaveLength(65)
    await module.stop()
  })

  test('invalidates cached counts when updated_at or revision changes', async () => {
    const harness = createHarness()
    const module = createLorebookTokenCountsModule()
    await module.start(harness.ctx)
    const row = appendBookRow(harness.decorate)
    await flush()
    expect(harness.countCalls()).toBe(1)

    harness.setEntries([{ id: 'entry-1', content: 'changed content', updated_at: 2, revision: 2 }])
    row.dataset.worldBookEntryRevision = '2'
    await flush()
    expect(row.textContent).toBe('9')
    expect(harness.countCalls()).toBe(2)
    await module.stop()
  })

  test('falls back to a stable content fingerprint only when updated_at is absent', async () => {
    const harness = createHarness()
    harness.setEntries([{ id: 'entry-1', content: 'fallback content', revision: 1 }])
    const module = createLorebookTokenCountsModule()
    await module.start(harness.ctx)
    const row = appendBookRow(harness.decorate)
    await flush()
    expect(harness.countCalls()).toBe(1)

    harness.setEntries([{ id: 'entry-1', content: 'fallback changed', revision: 2 }])
    row.dataset.worldBookEntryRevision = '2'
    await flush()
    expect(harness.countCalls()).toBe(2)
    await module.stop()
  })

  test('does not inject into native core token cells', async () => {
    const harness = createHarness()
    const module = createLorebookTokenCountsModule()
    await module.start(harness.ctx)
    const row = appendBookRow(harness.decorate)
    const nativeCell = document.createElement('button')
    nativeCell.dataset.worldBookTokenCell = 'true'
    row.append(nativeCell)
    await flush()
    expect(row.querySelector(`[data-lumiverse-token-count-badge]`)).toBeNull()
    expect(harness.countedTexts()).toEqual([])
    await module.stop()
  })
})
