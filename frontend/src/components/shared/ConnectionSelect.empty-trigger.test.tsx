import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'

const store = {
  profiles: [] as Array<{ id: string; name: string; provider: string; model?: string }>,
  decisionProfiles: [] as Array<{ id: string; name: string; provider: string; model?: string; is_default: boolean }>,
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
    store.decisionProfiles = []
  })

  function render(props: Partial<ComponentProps<typeof ConnectionSelect>> & { value: string }) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(createElement(ConnectionSelect, {
        kind: 'llm',
        onChange: () => undefined,
        ...props,
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

  test('Decision review pickers never select a default connection or pin its default model', async () => {
    store.decisionProfiles = [{ id: 'decision-default', name: 'Default Decision', provider: 'typesafe', model: 'saved-default', is_default: true }]
    const connections: string[] = []
    const models: string[] = []
    const node = render({ kind: 'decision', value: '', withModel: true, seedDefaultModel: false, modelValue: '',
      onChange: (id) => connections.push(id), onModelChange: (model) => models.push(model) })
    await act(async () => { await Promise.resolve() })
    expect(node.querySelector('[data-searchable]')?.getAttribute('data-value')).toBe('')
    expect(connections).toEqual([])
    expect(models).toEqual([])
  })

  test('an explicitly selected Decision connection keeps an empty model override', async () => {
    store.decisionProfiles = [{ id: 'decision-default', name: 'Default Decision', provider: 'typesafe', model: 'saved-default', is_default: true }]
    const models: string[] = []
    render({ kind: 'decision', value: 'decision-default', withModel: true, seedDefaultModel: false, modelValue: '',
      onModelChange: (model) => models.push(model) })
    await act(async () => { await Promise.resolve() })
    expect(models).toEqual([])
  })
})
