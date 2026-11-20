import { afterAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true })
const state = { user: { id: 'account' }, activeChatWallpaper: { type: 'image', image_id: 'wallpaper' } as { type: string; image_id: string } | null,
  wallpaper: { global: null, opacity: 0.4, fit: 'cover', blur: 0 }, useCharacterBackground: false,
  sceneBackground: null, imageGeneration: {}, characters: [] }
mock.module('@/store', () => ({ useStore: Object.assign((select: (value: unknown) => unknown) => select(state), { getState: () => state }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }))
const { activeTab } = await import('@/lib/active-tab')
const { default: ActiveTabGuard } = await import('./ActiveTabGuard')
const root = createRoot(document.getElementById('root')!)
afterAll(async () => { await act(async () => root.unmount()); dom.window.close() })

test('takeover unmounts application effects and stays blocked through rerenders and focus', async () => {
  let liveEffects = 0
  function Application() {
    useEffect(() => { liveEffects++; return () => { liveEffects--; state.activeChatWallpaper = null } }, [])
    return <button>Generate</button>
  }
  const render = () => root.render(<StrictMode><ActiveTabGuard><Application /></ActiveTabGuard></StrictMode>)
  await act(async () => render())
  state.activeChatWallpaper = { type: 'image', image_id: 'wallpaper' }
  expect(liveEffects).toBe(1)
  expect(document.body.textContent).toContain('Generate')
  await act(async () => {
    window.localStorage.setItem('lumiverse:active-tab:account', 'another-document')
    window.dispatchEvent(new dom.window.StorageEvent('storage', {
      key: 'lumiverse:active-tab:account', storageArea: window.localStorage,
    }))
  })
  expect(activeTab.signal.aborted).toBe(true)
  expect(document.querySelector('[style*="background-image"]')).not.toBeNull()
  expect(liveEffects).toBe(0)
  expect(document.body.textContent).toContain('This tab is inactive')
  expect(document.body.textContent).not.toContain('Generate')
  expect(document.body.textContent).toContain('You can forcefully disable this in: Settings → Account → Enforce one active browser tab')
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); render() })
  expect(liveEffects).toBe(0)
  expect(document.querySelector('[style*="background-image"]')).not.toBeNull()
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('button')?.textContent).toBe('Reload this tab')
})
