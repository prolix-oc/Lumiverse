import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'

const store = {
  profiles: [] as Array<{ id: string; name: string; provider: string; model?: string }>,
  imageGenProfiles: [],
  ttsProfiles: [],
  sttProfiles: [],
}

mock.module('@/store', () => ({
  useStore: Object.assign(
    (sel: (s: typeof store) => unknown) => sel(store),
    { getState: () => store },
  ),
}))
mock.module('@/api/connectionModels', () => ({
  fetchConnectionModels: async () => ({ models: [], labels: {} }),
}))
mock.module('./SearchableSelect', () => ({
  default: (props: { value?: string; triggerIcon?: unknown }) =>
    createElement('div', {
      'data-searchable': 'true',
      'data-value': props.value ?? '',
      'data-has-trigger-icon': props.triggerIcon ? 'true' : 'false',
    }),
}))
mock.module('./ConnectionSelect.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))
mock.module('./ProviderIcon', () => ({
  default: () => createElement('span', { 'data-provider-icon': 'true' }),
}))
mock.module('@/components/panels/connection-manager/ModelCombobox', () => ({
  default: () => null,
}))

const { default: ConnectionSelect } = await import('./ConnectionSelect')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ConnectionSelect empty trigger icon', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => { root?.unmount() })
    host?.remove()
    root = null
    host = null
    store.profiles = []
  })

  function render(props: { value: string }) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(createElement(ConnectionSelect, {
        kind: 'llm',
        value: props.value,
        onChange: () => undefined,
      }))
    })
    return host
  }

  test('empty value passes triggerIcon', () => {
    store.profiles = []
    const node = render({ value: '' })
    const select = node.querySelector('[data-searchable]')
    expect(select?.getAttribute('data-value')).toBe('')
    expect(select?.getAttribute('data-has-trigger-icon')).toBe('true')
  })

  test('selected value omits triggerIcon', () => {
    store.profiles = [{ id: 'conn-1', name: 'Primary', provider: 'openai' }]
    const node = render({ value: 'conn-1' })
    const select = node.querySelector('[data-searchable]')
    expect(select?.getAttribute('data-value')).toBe('conn-1')
    expect(select?.getAttribute('data-has-trigger-icon')).toBe('false')
  })
})
