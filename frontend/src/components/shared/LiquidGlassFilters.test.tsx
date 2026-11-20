import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { DEFAULT_THEME } from '@/theme/presets'
import type { ThemeConfig } from '@/types/theme'
import {
  setDeviceThemeControlsEnabled, setDeviceThemeControlsScope,
  updateDeviceThemeControls,
} from '@/lib/deviceThemeControls'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const media = Object.assign(new EventTarget(), { matches: false })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})
dom.window.matchMedia = (() => media) as unknown as typeof window.matchMedia
const useStore = create<{ theme: ThemeConfig }>(() => ({ theme: DEFAULT_THEME }))
mock.module('@/store', () => ({ useStore }))
const normalMap = mock(() => 'data:image/png;base64,normal-map')
const liquidGlass = await import('@/lib/liquidGlass')
mock.module('@/lib/liquidGlass', () => ({ ...liquidGlass, liquidGlassNormalMapUri: normalMap }))
const { default: LiquidGlassFilters } = await import('./LiquidGlassFilters')
let root: Root
let host: HTMLElement
beforeEach(() => {
  media.matches = false
  normalMap.mockClear()
  setDeviceThemeControlsScope('liquid-glass-test')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setDeviceThemeControlsScope(null)
  localStorage.clear()
})

test('follows device glass settings even when the authored theme disables glass', () => {
  const theme = { ...DEFAULT_THEME, enableGlass: false, liquidGlass: true }
  useStore.setState({ theme })
  setDeviceThemeControlsEnabled(true, theme)
  updateDeviceThemeControls({ enableGlass: true }, theme)
  act(() => root.render(<LiquidGlassFilters />))
  expect(host.querySelector('#liquid-glass-lens') !== null).toBe(true)
  act(() => updateDeviceThemeControls({ enableGlass: false }, theme))
  expect(host.querySelector('svg') === null).toBe(true)
  expect(theme.enableGlass).toBe(false)
})

test('does not allocate filters when device controls disable glass', () => {
  const theme = { ...DEFAULT_THEME, enableGlass: true, liquidGlass: true }
  useStore.setState({ theme })
  setDeviceThemeControlsEnabled(true, theme)
  updateDeviceThemeControls({ enableGlass: false }, theme)
  act(() => root.render(<LiquidGlassFilters />))
  expect(host.querySelector('svg') === null).toBe(true)
  expect(normalMap).not.toHaveBeenCalled()
})

test('honors reduced motion on the first render and responds to later changes', () => {
  useStore.setState({ theme: { ...DEFAULT_THEME, enableGlass: true, liquidGlass: true } })
  media.matches = true
  act(() => root.render(<LiquidGlassFilters />))
  expect(host.querySelector('svg') === null).toBe(true)
  expect(normalMap).not.toHaveBeenCalled()
  act(() => { media.matches = false; media.dispatchEvent(new Event('change')) })
  expect(host.querySelector('#liquid-glass-lens')).not.toBeNull()
  act(() => { media.matches = true; media.dispatchEvent(new Event('change')) })
  expect(host.querySelector('svg') === null).toBe(true)
})

test('keeps encoded neutral displacement in sRGB rather than linear light', () => {
  useStore.setState({ theme: { ...DEFAULT_THEME, enableGlass: true, liquidGlass: true } })
  act(() => root.render(<LiquidGlassFilters />))
  expect(host.querySelector('filter')?.getAttribute('color-interpolation-filters')).toBe('sRGB')
})
