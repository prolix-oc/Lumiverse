import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_THEME } from '@/theme/presets'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
let coarse = true
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
dom.window.matchMedia = ((media: string) => ({ matches: coarse, media })) as typeof window.matchMedia
const setTheme = mock(() => {})
const store = {
  theme: { ...DEFAULT_THEME, accent: { h: 201, s: 70, l: 60 } },
  extensionThemeOverrides: {}, mutedExtensionThemes: {}, setTheme,
  openModal: () => {}, clearAllExtensionThemeOverrides: () => {}, addSavedTheme: () => {},
}
mock.module('@/store', () => ({ useStore: Object.assign((selector: (s: typeof store) => unknown) => selector(store), { getState: () => store }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/hooks/useThemePackActions', () => ({ useThemePackActions: () => ({ handleExportPack: () => {}, handleImportPack: () => {} }) }))
mock.module('@/hooks/useThemeApplicator', () => ({ resolveMode: () => 'dark' }))
for (const component of ['ModeSelector', 'PresetGrid', 'SavedThemes', 'ExtensionThemes']) {
  mock.module(`./theme-panel/${component}`, () => ({ default: () => null }))
}
mock.module('./theme-panel/BaseColorPicker', () => ({ default: ({ onChange }: { onChange: (value: { primary: string }) => void }) => <button onClick={() => onChange({ primary: '#ffffff' })}>Primary editor</button> }))
const { default: ThemePanel } = await import('./ThemePanel')
let root: Root
let host: HTMLElement
beforeEach(() => {
  setTheme.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

test('locks all six sliders on touch devices and lets the user unlock and relock', () => {
  coarse = true
  act(() => root.render(<ThemePanel />))
  const sliders = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="range"]'))
  expect(sliders).toHaveLength(6)
  expect(sliders.every((input) => input.disabled)).toBe(true)
  const button = host.querySelector<HTMLButtonElement>('button[aria-pressed]')!
  expect(button.getAttribute('aria-pressed')).toBe('true')
  act(() => button.click())
  expect(sliders.every((input) => !input.disabled)).toBe(true)
  expect(button.getAttribute('aria-pressed')).toBe('false')
  act(() => button.click())
  expect(sliders.every((input) => input.disabled)).toBe(true)
  expect(setTheme).not.toHaveBeenCalled()
})
test('keeps desktop sliders unlocked until explicitly locked', () => {
  coarse = false
  act(() => root.render(<ThemePanel />))
  expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type="range"]')).every((input) => !input.disabled)).toBe(true)
  act(() => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click())
  expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type="range"]')).every((input) => input.disabled)).toBe(true)
})

test('each editing section has a synchronized unlock button and protects primary colors', () => {
  coarse = true
  act(() => root.render(<ThemePanel />))
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))
  expect(buttons).toHaveLength(3)
  expect(buttons.every((button) => button.parentElement?.tagName === 'SECTION')).toBe(true)
  const swatches = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label^="hue:"]'))
  expect(swatches).toHaveLength(10)
  expect(swatches.every((button) => button.disabled)).toBe(true)
  const primary = host.querySelector<HTMLButtonElement>('fieldset button')!
  expect(primary.matches(':disabled')).toBe(true)
  expect(primary.closest('fieldset')?.hasAttribute('inert')).toBe(true)
  act(() => { swatches[0].click(); primary.click() })
  expect(setTheme).not.toHaveBeenCalled()
  act(() => buttons[2].click())
  expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
  expect(swatches.every((button) => !button.disabled)).toBe(true)
  expect(primary.matches(':disabled')).toBe(false)
  expect(primary.closest('fieldset')?.hasAttribute('inert')).toBe(false)
  act(() => primary.click())
  expect(setTheme).toHaveBeenCalledTimes(1)
  act(() => swatches[0].click())
  expect(setTheme).toHaveBeenCalledTimes(2)
})
