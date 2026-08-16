/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['HTMLElement', globalObject.HTMLElement],
  ['Element', globalObject.Element],
  ['Node', globalObject.Node],
  ['navigator', globalObject.navigator],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REGISTERED_EXTENSION_ICONS = [
  { id: 'svg-circle', iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /></svg>' },
  { id: 'svg-path', iconSvg: '<svg viewBox="0 0 24 24"><path d="M4 12h16" /></svg>' },
  { id: 'remote-url', iconUrl: 'https://cdn.lumiverse.test/ext.png' },
  { id: 'data-png', iconUrl: 'data:image/png;base64,AAAA' },
  { id: 'empty', iconSvg: '' },
  { id: 'scripted', iconSvg: '<svg><script>window.__xss = true</script><rect width="8" height="8" /></svg>' },
]

let createRoot: typeof CreateRoot
let DynamicExtensionIcon: typeof import('./DynamicExtensionIcon').DynamicExtensionIcon

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ DynamicExtensionIcon } = await import('./DynamicExtensionIcon'))
})

afterEach(() => document.body.replaceChildren())

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

async function renderIcons(icons: typeof REGISTERED_EXTENSION_ICONS) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(
      <div>
        {icons.map((icon) => (
          <DynamicExtensionIcon key={icon.id} iconSvg={icon.iconSvg} iconUrl={icon.iconUrl} size={16} />
        ))}
      </div>,
    )
    await Promise.resolve()
  })
  return { host, root }
}

describe('DynamicExtensionIcon', () => {
  test('renders every registered extension icon without an uncaught error', async () => {
    const { host, root } = await renderIcons(REGISTERED_EXTENSION_ICONS)
    expect(host.querySelectorAll('span, svg, img').length).toBeGreaterThan(0)
    expect((window as Window & { __xss?: boolean }).__xss).toBeUndefined()
    await act(async () => root.unmount())
  })

  test('falls back for an unknown extension icon without a raw DOM lookup', async () => {
    const lookup = {
      querySelector: document.querySelector.bind(document),
      querySelectorAll: document.querySelectorAll.bind(document),
      getElementById: document.getElementById.bind(document),
    }
    let rawLookups = 0
    document.querySelector = ((selector: string) => {
      rawLookups += 1
      return lookup.querySelector(selector)
    }) as typeof document.querySelector
    document.querySelectorAll = ((selector: string) => {
      rawLookups += 1
      return lookup.querySelectorAll(selector)
    }) as typeof document.querySelectorAll
    document.getElementById = ((id: string) => {
      rawLookups += 1
      return lookup.getElementById(id)
    }) as typeof document.getElementById

    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<DynamicExtensionIcon iconSvg={undefined} iconUrl="javascript:alert(1)" size={18} />)
      await Promise.resolve()
    })

    expect(rawLookups).toBe(0)
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('svg')).not.toBeNull()

    document.querySelector = lookup.querySelector
    document.querySelectorAll = lookup.querySelectorAll
    document.getElementById = lookup.getElementById
    await act(async () => root.unmount())
  })
})
