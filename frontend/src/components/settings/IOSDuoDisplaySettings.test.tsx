import { afterAll, expect, mock, test } from 'bun:test'
import { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { DrawerSettings } from '@/types/store'
import type { IOSLayoutSnapshot } from '@/lib/ios-duo-layout'
import en from '@/i18n/locales/en/settings.json'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.test' })
const globals = globalThis as unknown as Record<string, unknown>
const previous = new Map(['window', 'document', 'navigator', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globals[key]]))
Object.assign(globals, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
let nativeLayout: IOSLayoutSnapshot
Object.assign(dom.window, {
  __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
  __LUMIVERSE_IOS_NATIVE__: { version: 1, request: async () => nativeLayout },
})
mock.module('@/components/shared/Toggle.module.css', () => ({ default: {} }))
const { createRoot } = await import('react-dom/client')
const { default: IOSDuoDisplaySettings } = await import('./IOSDuoDisplaySettings')
const { useIOSDuoLayout } = await import('@/hooks/useIOSDuoLayout')
const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { settings: en } } })

afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
  dom.window.close()
})

function snapshot(overrides: Partial<IOSLayoutSnapshot> = {}): IOSLayoutSnapshot {
  return { version: 1, revision: 1, width: 950, height: 670, isFoldable: true,
    horizontalSizeClass: 2, verticalSizeClass: 2, hingeStatus: 'fullyOpen',
    safeArea: { top: 0, right: 0, bottom: 34, left: 0 },
    divisions: [{ x: 455, y: 0, width: 40, height: 670, isActive: true }], occlusions: [], ...overrides }
}

async function mount() {
  const patches: Partial<DrawerSettings>[] = []
  function Probe() {
    // Legacy settings omit the new key and retain the existing Duo behavior.
    const [settings, setSettings] = useState<DrawerSettings>({ side: 'left' } as DrawerSettings)
    const layout = useIOSDuoLayout(settings.side, settings.duoAlwaysOpen !== false)
    return <div data-axis={layout?.axis ?? 'standard'} data-chat-x={layout?.chat.x}>
      <IOSDuoDisplaySettings settings={settings} onChange={patch => {
        patches.push(patch)
        setSettings(current => ({ ...current, ...patch }))
      }} />
    </div>
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<I18nextProvider i18n={i18n}><Probe /></I18nextProvider>))
  return { host, patches,
    emit: async (layout: IOSLayoutSnapshot) => {
      nativeLayout = layout
      await act(() => { window.dispatchEvent(new dom.window.CustomEvent('lumiverse:ios-layout', { detail: layout })) })
    },
    close: async () => { await act(() => root.unmount()); host.remove() },
  }
}

test('switches between persistent panes and standard behavior immediately and across posture changes', async () => {
  nativeLayout = snapshot()
  const p = await mount()
  try {
    const pane = p.host.firstElementChild as HTMLElement
    const checkbox = () => p.host.querySelector('input')!
    expect(checkbox().checked).toBe(true)
    expect(pane.dataset.axis).toBe('horizontal')
    expect(pane.dataset.chatX).toBe('495') // Retains the selected left drawer side.
    await act(() => checkbox().click())
    expect(p.patches).toEqual([{ duoAlwaysOpen: false }])
    expect(pane.dataset.axis).toBe('standard')
    await p.emit(snapshot({ revision: 2, width: 670, height: 950,
      divisions: [{ x: 0, y: 455, width: 670, height: 40, isActive: true }] }))
    expect(pane.dataset.axis).toBe('standard')
    await act(() => checkbox().click())
    expect(pane.dataset.axis).toBe('vertical') // Uses the latest geometry without another fold event.
    await p.emit(snapshot({ revision: 3, hingeStatus: 'closed', divisions: [] }))
    expect(pane.dataset.axis).toBe('standard')
    expect(checkbox().checked).toBe(true) // Preference remains available on the outer display.
    await act(() => checkbox().click())
    await p.emit(snapshot({ revision: 4 }))
    expect(pane.dataset.axis).toBe('standard')
  } finally { await p.close() }
})

test('uses native capability with older-wrapper fallback and hides the preference on ordinary iPhones', async () => {
  nativeLayout = snapshot({ isFoldable: false, hingeStatus: 'unknown', divisions: [] })
  const p = await mount()
  try {
    expect(p.host.querySelector('input')).toBeNull()
    await p.emit(snapshot({ revision: 2, isFoldable: undefined, hingeStatus: 'closed', divisions: [] }))
    expect(p.host.querySelector('input')?.checked).toBe(true)
    await p.emit(snapshot({ revision: 3, isFoldable: false }))
    expect(p.host.querySelector('input')).toBeNull() // Explicit native false takes precedence over geometry.
  } finally { await p.close() }
})
