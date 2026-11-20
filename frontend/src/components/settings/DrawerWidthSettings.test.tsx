import { afterAll, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { DrawerSettings } from '@/types/store'
import en from '@/i18n/locales/en/settings.json'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.test' })
const globals = globalThis as unknown as Record<string, unknown>
const previous = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globals[key]]))
Object.assign(globals, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
mock.module('@/components/modals/SettingsModal.module.css', () => ({ default: {} }))
const { createRoot } = await import('react-dom/client')
const { default: DrawerWidthSettings } = await import('./DrawerWidthSettings')
const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { settings: en } } })
afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
  dom.window.close()
})

test('manual modes clear the drag override and retain the custom width and unrelated settings', async () => {
  let settings: DrawerSettings = {
    side: 'left', verticalPosition: 10, tabSize: 'large', panelWidthMode: 'default',
    customPanelWidth: 45, panelWidthPx: 650, showTabLabels: true, hiddenTabIds: [], tabOrder: [], layout: [],
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = () => root.render(<I18nextProvider i18n={i18n}><DrawerWidthSettings settings={settings} onChange={patch => { settings = { ...settings, ...patch }; render() }} /></I18nextProvider>)
  try {
    await act(render)
    const [defaults, custom] = Array.from(host.querySelectorAll('button'))
    expect(host.querySelector('input')).toBeNull()
    await act(() => custom.click())
    expect(settings.panelWidthPx).toBeUndefined()
    expect(custom.getAttribute('aria-pressed')).toBe('true')
    const slider = host.querySelector('input')!
    expect(host.querySelector('label')?.htmlFor).toBe(slider.id)
    expect(slider.value).toBe('45')
    settings = { ...settings, panelWidthPx: 720 }
    await act(render)
    await act(() => defaults.click())
    expect(settings.panelWidthMode).toBe('default')
    expect(settings.panelWidthPx).toBeUndefined()
    expect(host.querySelector('input')).toBeNull()
    await act(() => custom.click())
    expect(host.querySelector('input')?.value).toBe('45')
    expect(settings.side).toBe('left')
    expect(settings.showTabLabels).toBe(true)
  } finally {
    await act(() => root.unmount())
    host.remove()
  }
})
