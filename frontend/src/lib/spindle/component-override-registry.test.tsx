/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import {
  registerComponentOverride,
  resetComponentOverrideRegistryForTests,
  SPINDLE_CALLBACK_REQUIRED_HOSTS,
  SPINDLE_OVERRIDE_HOSTS,
  type SpindleOverrideHost,
} from './component-override-registry'
import { useSpindleComponentOverride } from './use-spindle-component-override'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(() => {
  Object.assign(globalThis, originalGlobals)
})

afterEach(() => {
  resetComponentOverrideRegistryForTests()
})

type HostProps = {
  label: string
  onAction?: () => void
  onSave?: () => void
}

function NativeHost({ label, onAction, onSave }: HostProps) {
  return createElement(
    'div',
    { 'data-native': label },
    label,
    onAction ? createElement('button', { type: 'button', 'data-action': 'action', onClick: onAction }) : null,
    onSave ? createElement('button', { type: 'button', 'data-action': 'save', onClick: onSave }) : null,
  )
}

function WrapOverride({
  Original,
  label,
}: HostProps & { Original?: ComponentType<Partial<HostProps>> }) {
  return createElement('div', { 'data-wrap': label }, Original ? createElement(Original) : null)
}

function ReplaceOverride({ label }: HostProps) {
  return createElement('div', { 'data-replace': label }, `replaced-${label}`)
}

function BoomOverride(): never {
  throw new Error('override-crash')
}

function HostStandIn({ host, ...props }: HostProps & { host: SpindleOverrideHost }) {
  return useSpindleComponentOverride(host, NativeHost, props)
}

function mountHost(host: SpindleOverrideHost, props: HostProps): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(HostStandIn, { host, ...props }))
  })
  return { container, root }
}

function remount(root: Root, host: SpindleOverrideHost, props: HostProps): void {
  act(() => {
    root.render(createElement(HostStandIn, { host, ...props }))
  })
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function nativePropsFor(host: SpindleOverrideHost): HostProps {
  const onAction = () => undefined
  const onSave = () => undefined
  return SPINDLE_CALLBACK_REQUIRED_HOSTS.has(host)
    ? { label: host, onAction, onSave }
    : { label: host }
}

function silenceOverrideErrors(run: () => void): void {
  const error = console.error
  console.error = () => undefined
  try {
    run()
  } finally {
    console.error = error
  }
}

function exerciseHost(host: SpindleOverrideHost): void {
  const props = nativePropsFor(host)
  const { container, root } = mountHost(host, props)
  try {
    expect(container.querySelector(`[data-native="${host}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-wrap="${host}"]`)).toBeNull()
    expect(container.querySelector(`[data-replace="${host}"]`)).toBeNull()

    let wrap!: ReturnType<typeof registerComponentOverride>
    act(() => {
      wrap = registerComponentOverride({
        host,
        owner: `owner-wrap-${host}`,
        generation: 1,
        mode: 'wrap',
        priority: 20,
        component: WrapOverride,
      })
    })
    expect(container.querySelector(`[data-wrap="${host}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-native="${host}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-replace="${host}"]`)).toBeNull()

    act(() => { wrap.destroy() })
    expect(container.querySelector(`[data-wrap="${host}"]`)).toBeNull()
    expect(container.querySelector(`[data-native="${host}"]`)).toBeTruthy()

    let replace!: ReturnType<typeof registerComponentOverride>
    act(() => {
      replace = registerComponentOverride({
        host,
        owner: `owner-replace-${host}`,
        generation: 1,
        mode: 'replace',
        priority: 10,
        component: ReplaceOverride,
      })
    })
    expect(container.querySelector(`[data-replace="${host}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-native="${host}"]`)).toBeNull()
    expect(container.textContent).toContain(`replaced-${host}`)

    act(() => { replace.destroy() })
    expect(container.querySelector(`[data-replace="${host}"]`)).toBeNull()
    expect(container.querySelector(`[data-native="${host}"]`)).toBeTruthy()

    let boom!: ReturnType<typeof registerComponentOverride>
    silenceOverrideErrors(() => {
      act(() => {
        boom = registerComponentOverride({
          host,
          owner: `owner-boom-${host}`,
          generation: 1,
          mode: 'replace',
          component: BoomOverride,
        })
      })
    })
    expect(container.querySelector(`[data-native="${host}"]`)).toBeTruthy()
    expect(container.textContent).toContain(host)

    act(() => { boom.destroy() })
    expect(container.querySelector(`[data-native="${host}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-wrap="${host}"]`)).toBeNull()
    expect(container.querySelector(`[data-replace="${host}"]`)).toBeNull()
  } finally {
    unmount(root, container)
  }
}

describe('Spindle component override registry', () => {
  for (const host of SPINDLE_OVERRIDE_HOSTS) {
    test(`${host} wraps replaces falls back and unloads`, () => {
      exerciseHost(host)
    })
  }

  test('rejects second override registration for owner and generation', () => {
    registerComponentOverride({
      host: 'BubbleMessage',
      owner: 'extension.once',
      generation: 4,
      mode: 'wrap',
      component: WrapOverride,
    })
    expect(() => registerComponentOverride({
      host: 'BubbleMessage',
      owner: 'extension.once',
      generation: 4,
      mode: 'replace',
      component: ReplaceOverride,
    })).toThrow('COMPONENT_OVERRIDE_DUPLICATE:extension.once:4')
  })
})
