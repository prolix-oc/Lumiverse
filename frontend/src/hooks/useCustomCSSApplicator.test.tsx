import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import React, { act, StrictMode, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})
let safe = false
let rejectCSS = false
const errors = mock(() => {})
const state = {
  user: { id: 'a' } as { id: string } | null,
  customCSS: { css: 'body { color: red }', enabled: true, revision: 1, bundleId: 'a' },
  componentOverrides: {} as Record<string, { css: string; tsx: string; enabled: boolean }>,
  toggleCustomCSS() {}, toggleComponentOverride() {},
}
mock.module('@/store', () => ({ useStore: (selector: (s: typeof state) => unknown) => selector(state) }))
mock.module('@/lib/safeThemeMode', () => ({ useSafeThemeState: () => ({ active: safe }) }))
mock.module('@/lib/toast', () => ({ toast: { error: errors, info() {} } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
Object.assign(globalThis, { CSSStyleSheet: class {
  replaceSync() { if (rejectCSS) throw new Error('invalid CSS') }
} })
const { useCustomCSSApplicator } = await import('./useCustomCSSApplicator')
let root: Root
let host: HTMLElement
let observedBeforePaint: string | null
function Fixture() {
  useCustomCSSApplicator()
  useLayoutEffect(() => { observedBeforePaint = css() })
  return <div>App shell</div>
}
const css = () => document.getElementById('lumiverse-user-css')?.textContent ?? ''
const render = () => act(() => root.render(<StrictMode><Fixture /></StrictMode>))
beforeEach(() => {
  safe = false
  rejectCSS = false
  state.user = { id: 'a' }
  state.customCSS = { css: 'body { color: red }', enabled: true, revision: 1, bundleId: 'a' }
  state.componentOverrides = {}
  observedBeforePaint = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  errors.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

test('applies CSS before paint and restores it after StrictMode cleanup', () => {
  render()
  expect(observedBeforePaint).toBe(state.customCSS.css)
  expect(css()).toBe(state.customCSS.css)
})

test('safe theme suppresses both global and component CSS before paint', () => {
  state.componentOverrides = { InputArea: { css: 'input { color: blue }', tsx: '', enabled: true } }
  render()
  expect(css()).toContain('input { color: blue }')
  safe = true
  render()
  expect(observedBeforePaint).toBe('')
  safe = false
  render()
  expect(css()).toContain('input { color: blue }')
})

test('clears the previous account styling even if the next account CSS is invalid', () => {
  render()
  state.user = { id: 'b' }
  state.customCSS = { ...state.customCSS, css: 'invalid', bundleId: 'b' }
  rejectCSS = true
  render()
  expect(css()).toBe('')
  expect(errors).toHaveBeenCalled()
})

test('logout and unmount remove styling before paint', () => {
  render()
  state.user = null
  render()
  expect(observedBeforePaint).toBe('')
  state.user = { id: 'a' }
  render()
  expect(css()).toBe(state.customCSS.css)
  act(() => root.unmount())
  expect(css()).toBe('')
  root = createRoot(host)
})

test('continues to sanitize CSS and rewrite assets for the current bundle', () => {
  state.customCSS.css = '@import "https://example.com/style.css"; body { background: url(./assets/bg.png) }'
  render()
  expect(css()).not.toContain('@import "https:')
  expect(css()).toContain('/api/v1/theme-assets/bundles/a/assets/bg.png')
})
