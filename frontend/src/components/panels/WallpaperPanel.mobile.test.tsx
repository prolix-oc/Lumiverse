import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { WallpaperRef, WallpaperSettings } from '@/types/store'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)

const desktop: WallpaperRef = { image_id: 'desktop', type: 'image' }
const portrait: WallpaperRef = { image_id: 'portrait', type: 'image' }
const state = {
  wallpaper: { global: desktop, mobile: portrait, opacity: 0.3, fit: 'cover', blur: 0 } as WallpaperSettings,
  activeChatId: null as string | null, activeChatWallpaper: null as WallpaperRef | null, activeChatMetadata: null as Record<string, unknown> | null,
  useCharacterBackground: false, setSetting: mock(),
  setActiveChatWallpaper: mock((ref: WallpaperRef | null) => { state.activeChatWallpaper = ref }),
  setActiveChatMetadata: mock((metadata: Record<string, unknown>) => { state.activeChatMetadata = metadata }),
  setWallpaper: mock((partial: Partial<WallpaperSettings>) => { state.wallpaper = { ...state.wallpaper, ...partial } }),
}
const flush = mock(async () => {})
const cleanup = mock(async () => {})
const upload = mock(async () => ({ id: 'uploaded-mobile' }))
const deleteFromLibrary = mock(async () => {})
mock.module('@/store', () => ({ useStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }))
mock.module('@/store/slices/settings', () => ({ flushSettingsNow: flush }))
mock.module('@/api/images', () => ({ imagesApi: { url: (id: string) => `/images/${id}`, largeUrl: (id: string) => `/posters/${id}`, uploadWallpaper: upload, deleteIfUnused: cleanup } }))
const patchMetadata = mock(async (_id: string, _partial: Record<string, unknown>) => {})
mock.module('@/api/chats', () => ({ chatsApi: { patchMetadata } }))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => {}, suppressNextResumePingFor: mock() } }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/components/shared/FormComponents', () => ({
  FormField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  EditorSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Select: () => null,
}))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Switch: () => null } }))
mock.module('./WallpaperLibraryModal', () => ({ default: ({ isOpen, target, currentImageId, onSelect, onDelete }: {
  isOpen: boolean; target: string; currentImageId: string | null; onSelect: (ref: WallpaperRef) => Promise<void>; onDelete: (id: string) => void
}) => isOpen ? <div data-scope={target} data-current={currentImageId}>
  <button onClick={() => onSelect({ image_id: 'library-video', type: 'video' })}>Choose library video</button>
  <button onClick={async () => { await deleteFromLibrary(); onDelete('portrait') }}>Delete portrait</button>
</div> : null }))

let createRoot: typeof import('react-dom/client').createRoot
let Panel: typeof import('./WallpaperPanel').default
let root: Root
beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: Panel } = await import('./WallpaperPanel'))
})
beforeEach(async () => {
  state.wallpaper = { global: desktop, mobile: portrait, opacity: 0.3, fit: 'cover', blur: 0 }
  state.activeChatId = null; state.activeChatWallpaper = null; state.activeChatMetadata = null
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Panel />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  flush.mockClear(); cleanup.mockClear(); upload.mockClear(); state.setWallpaper.mockClear()
  patchMetadata.mockClear(); state.setActiveChatWallpaper.mockClear(); state.setActiveChatMetadata.mockClear()
  deleteFromLibrary.mockClear()
})
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(globals, key)
    else globals[key] = value
  }
  dom.window.close()
})
function buttons(label: string) {
  return [...document.querySelectorAll('button')].filter(button => button.textContent === label)
}

test('routes library videos to the mobile scope and preserves the global wallpaper', async () => {
  await act(async () => buttons('wallpaperPanel.browseLibrary')[1].click())
  expect(document.querySelector('[data-scope="mobile"]')?.getAttribute('data-current')).toBe('portrait')
  await act(async () => buttons('Choose library video')[0].click())
  expect(state.wallpaper.mobile).toEqual({ image_id: 'library-video', type: 'video' })
  expect(state.wallpaper.global).toEqual(desktop)
  expect(flush).toHaveBeenCalledTimes(1)
  expect(cleanup).toHaveBeenCalledWith('portrait')
})
test('clears the mobile override and restores the global fallback', async () => {
  await act(async () => buttons('wallpaperPanel.clear')[1].click())
  expect(state.wallpaper.mobile).toBeNull()
  expect(state.wallpaper.global).toEqual(desktop)
  expect(flush).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<Panel />))
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(0)
  expect(buttons('wallpaperPanel.addMobileWallpaper')).toHaveLength(1)
})
test('keeps mobile controls optional and lets users cancel without changing settings', async () => {
  state.wallpaper = { ...state.wallpaper, mobile: null }
  await act(async () => root.render(<Panel />))
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(0)
  expect(buttons('wallpaperPanel.browseLibrary')).toHaveLength(1)
  expect(buttons('wallpaperPanel.addMobileWallpaper')[0].parentElement).toBe(buttons('wallpaperPanel.setGlobal')[0].parentElement)
  await act(async () => buttons('wallpaperPanel.addMobileWallpaper')[0].click())
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(1)
  expect(buttons('wallpaperPanel.browseLibrary')).toHaveLength(2)
  await act(async () => buttons('wallpaperPanel.cancelMobileWallpaper')[0].click())
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(0)
  expect(state.wallpaper.mobile).toBeNull()
  expect(state.wallpaper.global).toEqual(desktop)
  expect(flush).not.toHaveBeenCalled()
  expect(state.setWallpaper).not.toHaveBeenCalled()
})
test('clears local mobile assignment when its library image is deleted', async () => {
  await act(async () => buttons('wallpaperPanel.browseLibrary')[1].click())
  await act(async () => buttons('Delete portrait')[0].click())
  expect(state.wallpaper.mobile).toBeNull()
  expect(state.wallpaper.global).toEqual(desktop)
})
test('uploads directly into the mobile slot', async () => {
  await act(async () => buttons('wallpaperPanel.setMobile')[0].click())
  const input = document.querySelector('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'portrait.png', { type: 'image/png' })] })
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  expect(upload).toHaveBeenCalledTimes(1)
  expect(state.wallpaper.mobile).toEqual({ image_id: 'uploaded-mobile', type: 'image' })
  expect(state.wallpaper.global).toEqual(desktop)
  expect(flush).toHaveBeenCalledTimes(1)
})

async function openChat(mobile: WallpaperRef | null = null) {
  state.activeChatId = 'chat-1'
  state.activeChatWallpaper = desktop
  state.activeChatMetadata = { wallpaper: desktop, mobile_wallpaper: mobile, topic: 'keep' }
  await act(async () => root.render(<Panel />))
}

test('offers an optional mobile editor next to the chat wallpaper button', async () => {
  await openChat()
  expect(buttons('wallpaperPanel.addMobileWallpaper')[0].parentElement).toBe(buttons('wallpaperPanel.setForChat')[0].parentElement)
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(1)
  await act(async () => buttons('wallpaperPanel.addMobileWallpaper')[0].click())
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(2)
  await act(async () => buttons('wallpaperPanel.cancelMobileWallpaper')[0].click())
  expect(buttons('wallpaperPanel.setMobile')).toHaveLength(1)
  expect(patchMetadata).not.toHaveBeenCalled()
})

test('persists a library video as a mobile chat override and retains other metadata', async () => {
  await openChat(portrait)
  await act(async () => buttons('wallpaperPanel.browseLibrary')[3].click())
  expect(document.querySelector('[data-scope="chat-mobile"]')?.getAttribute('data-current')).toBe('portrait')
  await act(async () => buttons('Choose library video')[0].click())
  const video = { image_id: 'library-video', type: 'video' }
  expect(patchMetadata).toHaveBeenCalledWith('chat-1', { mobile_wallpaper: video })
  expect(state.activeChatMetadata).toEqual({ wallpaper: desktop, mobile_wallpaper: video, topic: 'keep' })
  expect(state.activeChatWallpaper).toEqual(desktop)
  expect(state.wallpaper.mobile).toEqual(portrait)
  expect(flush).not.toHaveBeenCalled()
})

test('clears just the mobile chat override and hides its editor', async () => {
  await openChat(portrait)
  await act(async () => buttons('wallpaperPanel.clear')[3].click())
  expect(patchMetadata).toHaveBeenCalledWith('chat-1', { mobile_wallpaper: null })
  expect(state.activeChatMetadata).toEqual({ wallpaper: desktop, mobile_wallpaper: null, topic: 'keep' })
  expect(state.activeChatWallpaper).toEqual(desktop)
  await act(async () => root.render(<Panel />))
  expect(buttons('wallpaperPanel.addMobileWallpaper')).toHaveLength(1)
})

test('does not apply an in-flight chat assignment to a newly navigated chat', async () => {
  await openChat(portrait)
  let finish!: () => void
  patchMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  await act(async () => buttons('wallpaperPanel.browseLibrary')[3].click())
  await act(async () => buttons('Choose library video')[0].click())
  state.activeChatId = 'chat-2'
  state.activeChatMetadata = { topic: 'new chat' }
  state.activeChatWallpaper = null
  await act(async () => finish())
  expect(state.activeChatMetadata).toEqual({ topic: 'new chat' })
  expect(state.activeChatWallpaper).toBeNull()
})

test('deleting a shared library image clears both chat slots and retains metadata', async () => {
  await openChat(portrait)
  state.activeChatWallpaper = portrait
  state.activeChatMetadata = { wallpaper: portrait, mobile_wallpaper: portrait, topic: 'keep' }
  await act(async () => root.render(<Panel />))
  await act(async () => buttons('wallpaperPanel.browseLibrary')[3].click())
  await act(async () => buttons('Delete portrait')[0].click())
  expect(state.activeChatWallpaper).toBeNull()
  expect(state.activeChatMetadata).toEqual({ wallpaper: null, mobile_wallpaper: null, topic: 'keep' })
})

test('uses current chat metadata when library deletion finishes after navigation', async () => {
  await openChat(portrait)
  let finish!: () => void
  deleteFromLibrary.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  await act(async () => buttons('wallpaperPanel.browseLibrary')[3].click())
  await act(async () => buttons('Delete portrait')[0].click())
  state.activeChatId = 'chat-2'
  state.activeChatWallpaper = null
  state.activeChatMetadata = { mobile_wallpaper: portrait, topic: 'new chat', active_avatar_id: 'new-avatar' }
  await act(async () => root.render(<Panel />))
  await act(async () => finish())
  expect(state.activeChatMetadata).toEqual({ mobile_wallpaper: null, topic: 'new chat', active_avatar_id: 'new-avatar' })
  expect(state.activeChatWallpaper).toBeNull()
})

test('retains assignments and metadata changed during library deletion', async () => {
  await openChat(portrait)
  let finish!: () => void
  deleteFromLibrary.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  await act(async () => buttons('wallpaperPanel.browseLibrary')[3].click())
  await act(async () => buttons('Delete portrait')[0].click())
  const replacement: WallpaperRef = { image_id: 'replacement', type: 'video' }
  state.wallpaper = { ...state.wallpaper, mobile: replacement }
  state.activeChatMetadata = { wallpaper: desktop, mobile_wallpaper: replacement, topic: 'updated' }
  await act(async () => root.render(<Panel />))
  await act(async () => finish())
  expect(state.wallpaper.mobile).toEqual(replacement)
  expect(state.activeChatMetadata).toEqual({ wallpaper: desktop, mobile_wallpaper: replacement, topic: 'updated' })
})

test.each(['chat', 'chat-mobile'] as const)('keeps a %s upload attached to the chat that opened the file picker', async (target) => {
  await openChat(portrait)
  await act(async () => (target === 'chat' ? buttons('wallpaperPanel.setForChat')[0] : buttons('wallpaperPanel.setMobile')[1]).click())
  state.activeChatId = 'chat-2'
  state.activeChatWallpaper = null
  state.activeChatMetadata = { topic: 'new chat' }
  await act(async () => root.render(<Panel />))
  const input = document.querySelector('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'portrait.png', { type: 'image/png' })] })
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  expect(patchMetadata).toHaveBeenCalledWith('chat-1', { [target === 'chat' ? 'wallpaper' : 'mobile_wallpaper']: { image_id: 'uploaded-mobile', type: 'image' } })
  expect(state.activeChatMetadata).toEqual({ topic: 'new chat' })
  expect(state.activeChatWallpaper).toBeNull()
})
