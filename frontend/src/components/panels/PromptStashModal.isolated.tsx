import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const globals = globalThis as unknown as Record<string, unknown>
const originals = new Map<string, unknown>([
  ['window', globals.window],
  ['document', globals.document],
  ['Element', globals.Element],
  ['HTMLElement', globals.HTMLElement],
  ['Node', globals.Node],
  ['Event', globals.Event],
  ['MouseEvent', globals.MouseEvent],
  ['MutationObserver', globals.MutationObserver],
])
Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  MutationObserver: domWindow.MutationObserver,
})

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')

const stashEntry = {
  id: 'stash-1',
  block: { id: 'source', name: 'Shared', content: 'shared content' },
  sourcePreset: { id: 'origin', name: 'Origin' },
}
let listResult = [stashEntry]
let removeResult: unknown
let scopeEpoch = 1
let commitCalls = 0
const observed: Array<{ row: Record<string, unknown>; draft: Record<string, unknown> }> = []
const roots = new Set<Root>()

const coordinator = {
  getScopeEpoch: () => scopeEpoch,
  observeAuthority: (
    row: Record<string, unknown>,
    transform?: (draft: Record<string, any>) => Record<string, any>,
  ) => {
    const draft = {
      id: row.id,
      blocks: [
        { id: `${row.id}-linked`, content: 'local linked edit', stashId: 'stash-1' },
        { id: `${row.id}-other`, content: 'unrelated dirty edit' },
      ],
      description: 'unrelated preset draft',
    }
    observed.push({ row, draft: transform ? transform(draft) : draft })
    return true
  },
}

mock.module('@/api/presets', () => ({
  presetsApi: {
    listStash: async () => listResult,
    removeFromStash: async () => removeResult,
  },
}))
mock.module('@/lib/loom/preset-save-coordinator', () => ({
  presetSaveCoordinator: coordinator,
  applyPresetAuthorityResult: (
    result: { presetAuthorityChanged: boolean; presetAuthorities: Record<string, unknown>[] },
    expectedScopeEpoch: number,
    transform?: (draft: Record<string, any>) => Record<string, any>,
  ) => {
    if (result.presetAuthorityChanged && result.presetAuthorities.length > 0) commitCalls += 1
    if (scopeEpoch !== expectedScopeEpoch) return false
    let didObserve = false
    for (const row of result.presetAuthorities) {
      didObserve = coordinator.observeAuthority(row, transform) || didObserve
    }
    return didObserve
  },
}))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) => (
    isOpen ? createElement('div', null, children) : null
  ),
}))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('lucide-react', () => ({ Archive: () => null, Search: () => null, Trash2: () => null }))
mock.module('./PromptStashModal.module.css', () => ({ default: {} }))

// Dynamic import is required so Bun installs the dependency mocks before module evaluation.
const { PromptStashModal } = await import('./PromptStashModal')

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.add(root)
  await act(async () => {
    root.render(createElement(PromptStashModal, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
    }))
  })
  await settle()
  return { container, root }
}

function unStashButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Un-stash'))
  if (!(button instanceof domWindow.HTMLButtonElement)) throw new Error('missing un-stash button')
  return button
}

beforeEach(() => {
  listResult = [stashEntry]
  removeResult = { removed: true, presetAuthorityChanged: false, presetAuthorities: [] }
  scopeEpoch = 1
  commitCalls = 0
  observed.length = 0
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => root.unmount())
    roots.delete(root)
  }
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originals) globals[key] = value
  dom.window.close()
})

describe('PromptStashModal authoritative un-stash', () => {
  test('settings-only removal updates the stash without burning runtime authority', async () => {
    const { container } = await mount()
    await act(async () => unStashButton(container).click())
    await settle()

    expect(observed).toEqual([])
    expect(commitCalls).toBe(0)
    expect(container.textContent).toContain('Your prompt stash is empty.')
  })

  test('hydrates every changed owner, unlinks stale local refs, and commits once', async () => {
    removeResult = {
      removed: true,
      presetAuthorityChanged: true,
      presetAuthorities: [
        { id: 'owner-1', cache_revision: 4, agent_config_revision: 2 },
        { id: 'owner-2', cache_revision: 8, agent_config_revision: 5 },
      ],
    }
    const { container } = await mount()
    await act(async () => unStashButton(container).click())
    await settle()

    expect(observed.map(({ row }) => row.id)).toEqual(['owner-1', 'owner-2'])
    for (const { draft } of observed) {
      expect(draft.description).toBe('unrelated preset draft')
      expect((draft.blocks as Array<Record<string, unknown>>)[0]).toEqual({
        id: `${draft.id}-linked`,
        content: 'local linked edit',
      })
      expect((draft.blocks as Array<Record<string, unknown>>)[1]).toMatchObject({ content: 'unrelated dirty edit' })
    }
    expect(commitCalls).toBe(1)
  })

  test('commits persisted authority but does not publish locally after the user scope changes', async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    removeResult = promise
    const { container } = await mount()
    await act(async () => unStashButton(container).click())
    scopeEpoch = 2
    resolve({
      removed: true,
      presetAuthorityChanged: true,
      presetAuthorities: [{ id: 'old-user-owner', cache_revision: 2, agent_config_revision: 2 }],
    })
    await settle()

    expect(observed).toEqual([])
    expect(commitCalls).toBe(1)
    expect(container.textContent).toContain('shared content')
  })

  test('does not invalidate or publish a stale-scope settings-only response', async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    removeResult = promise
    const { container } = await mount()
    await act(async () => unStashButton(container).click())
    scopeEpoch = 2
    resolve({ removed: true, presetAuthorityChanged: false, presetAuthorities: [] })
    await settle()

    expect(observed).toEqual([])
    expect(commitCalls).toBe(0)
    expect(container.textContent).toContain('shared content')
  })
})
