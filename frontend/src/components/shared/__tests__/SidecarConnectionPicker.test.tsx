import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'

mock.module('@/components/shared/ConnectionSelect', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('div', {
      'data-mock-connection-select': 'true',
      'data-placeholder': String(props.placeholder ?? ''),
      'data-clear-label': String(props.clearLabel ?? ''),
      'data-value': String(props.value ?? ''),
      'data-model': String(props.modelValue ?? ''),
      'data-disabled': props.disabled ? 'true' : 'false',
    }),
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}))
mock.module('../SidecarConnectionPicker.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

const { default: SidecarConnectionPicker } = await import('../SidecarConnectionPicker')

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

describe('SidecarConnectionPicker', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => { root?.unmount() })
    host?.remove()
    root = null
    host = null
  })

  function render(props: Partial<Parameters<typeof SidecarConnectionPicker>[0]> = {}) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const onConnectionChange = props.onConnectionChange ?? (() => undefined)
    const onModelChange = props.onModelChange ?? (() => undefined)
    act(() => {
      root!.render(createElement(SidecarConnectionPicker, {
        connectionProfileId: props.connectionProfileId ?? null,
        model: props.model ?? null,
        onConnectionChange,
        onModelChange,
        ...props,
      }))
    })
    return host
  }

  test('uses connectionNone as placeholder and clearLabel when empty', () => {
    const node = render()
    const select = node.querySelector('[data-mock-connection-select]')
    expect(select?.getAttribute('data-placeholder')).toBe('memoryCortex.connectionNone')
    expect(select?.getAttribute('data-clear-label')).toBe('memoryCortex.connectionNone')
    expect(select?.getAttribute('data-value')).toBe('')
    expect(select?.getAttribute('data-model')).toBe('')
  })

  test('reflects selected connection and model', () => {
    const node = render({
      connectionProfileId: 'conn-1',
      model: 'gpt-test',
    })
    const select = node.querySelector('[data-mock-connection-select]')
    expect(select?.getAttribute('data-value')).toBe('conn-1')
    expect(select?.getAttribute('data-model')).toBe('gpt-test')
  })

  test('renders hint text when hint is set', () => {
    const node = render({ hint: 'Browse models for the selected sidecar.' })
    const hint = node.querySelector('p')
    expect(hint?.textContent).toBe('Browse models for the selected sidecar.')
  })

  test('renders remove control and fires onRemove', () => {
    const onRemove = mock(() => undefined)
    const node = render({ onRemove })
    const button = node.querySelector('.tagRemove') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('×')
    act(() => { button!.click() })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  test('omits remove control when onRemove is not provided', () => {
    const node = render()
    expect(node.querySelector('.tagRemove')).toBeNull()
  })

  test('forwards disabled to ConnectionSelect', () => {
    const node = render({ disabled: true })
    const select = node.querySelector('[data-mock-connection-select]')
    expect(select?.getAttribute('data-disabled')).toBe('true')
  })
})
