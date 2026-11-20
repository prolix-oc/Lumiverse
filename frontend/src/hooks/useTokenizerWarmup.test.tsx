import { afterAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const state = {
  isAuthenticated: true,
  user: { id: 'user' },
  activeChatId: 'chat',
  activeProfileId: 'a',
  profiles: [{ id: 'a', model: 'model-a', is_default: true }, { id: 'b', model: 'model-b', is_default: false }],
}
const calls: Array<[string, string | undefined]> = []
mock.module('@/store', () => ({ useStore: (selector: (value: typeof state) => unknown) => selector(state) }))
mock.module('@/api/tokenizers', () => ({ tokenizersApi: { warm: async (id: string, chat?: string) => { calls.push([id, chat]); return { queued: true } } } }))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globals = globalThis as unknown as Record<string, unknown>
const originals = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globals[key]]))
Object.assign(globals, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { useTokenizerWarmup } = await import('./useTokenizerWarmup')
afterAll(() => {
  dom.window.close()
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
})

describe('connection tokenizer warmup', () => {
  test('coalesces rapid selection, follows model edits, and cancels on logout', async () => {
    function Probe() { useTokenizerWarmup(); return null }
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => { root.render(createElement(Probe)) })
      state.activeProfileId = 'b'
      await act(async () => { root.render(createElement(Probe)) })
      await act(async () => { await Bun.sleep(180) })
      expect(calls).toEqual([['b', 'chat']])
      state.profiles[1] = { ...state.profiles[1], model: 'changed-model' }
      await act(async () => { root.render(createElement(Probe)) })
      await act(async () => { await Bun.sleep(180) })
      expect(calls).toEqual([['b', 'chat'], ['b', 'chat']])
      state.activeProfileId = 'a'
      await act(async () => { root.render(createElement(Probe)) })
      state.isAuthenticated = false
      await act(async () => { root.render(createElement(Probe)) })
      await act(async () => { await Bun.sleep(180) })
      expect(calls).toHaveLength(2)
    } finally { await act(async () => root.unmount()) }
  })
})
