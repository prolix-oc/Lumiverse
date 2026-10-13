/// <reference types="bun-types" />
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, type HTMLAttributes, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { Image } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }
const previous = Object.fromEntries(Object.keys(replacements).map((key) => [key, globals[key]]))
Object.assign(globals, replacements)

const t = (key: string) => key
// Bun does not compile CSS modules; retain representative class names in this DOM fixture.
const cssClasses = ['modal', 'closeBtnPos', 'header', 'headerCopy', 'title', 'subtitle', 'count', 'error', 'scrollArea', 'state', 'grid', 'card', 'cardCurrent', 'thumb', 'thumbImage', 'thumbPlaceholder', 'placeholderLabel', 'badge', 'currentBadge', 'meta', 'filename', 'metaRow', 'metaLabel', 'metaValue', 'cardActions', 'applyBtn', 'deleteBtn', 'footer', 'loadMoreBtn']
mock.module('./WallpaperLibraryModal.module.css', () => ({ default: Object.fromEntries(cssClasses.map((name) => [name, `fixture_${name}`])) }))
mock.module('../shared/CloseButton.module.css', () => ({ default: { base: 'fixture_close' } }))
mock.module('../shared/ModalShell.module.css', () => ({ default: { backdrop: 'fixture_backdrop', fullscreenBackdrop: 'fixture_fullscreenBackdrop', modal: 'fixture_modal', fullscreenModal: 'fixture_fullscreenModal', scrollable: 'fixture_scrollable' } }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'en' } }) }))
mock.module('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => <div {...props} /> },
}))
const image: Image = { id: 'image', filename: 'image.png', original_filename: 'Wallpaper.png', mime_type: 'image/png', byte_size: 1024, width: 800, height: 600, has_thumbnail: true, created_at: 1700000000 }
const video: Image = { ...image, id: 'video', mime_type: 'video/mp4', has_thumbnail: false }
const listWallpapers = mock(async () => ({ data: [image, video], total: 3 }))
mock.module('@/api/images', () => ({ imagesApi: { listWallpapers, smallUrl: (id: string) => `/fixture/${id}`, deleteWallpaper: mock() } }))

let createRoot: typeof import('react-dom/client').createRoot
let WallpaperLibraryModal: typeof import('./WallpaperLibraryModal').default
let ModalShell: typeof import('../shared/ModalShell').ModalShell
let root: Root
beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: WallpaperLibraryModal } = await import('./WallpaperLibraryModal'))
  ;({ ModalShell } = await import('../shared/ModalShell'))
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.replaceChildren()
  listWallpapers.mockReset()
  listWallpapers.mockImplementation(async () => ({ data: [image, video], total: 3 }))
})
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(globals, key)
    else globals[key] = value
  }
  dom.window.close()
})

async function render(children: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(children) })
  return host
}

test('scopes all card surfaces inside the actual portal and preserves selection and close actions', async () => {
  const onSelect = mock(async () => {})
  const onClose = mock()
  const host = await render(<WallpaperLibraryModal isOpen target="global" currentImageId="image" onSelect={onSelect} onClose={onClose} />)
  const modal = document.querySelector('[data-component="WallpaperLibraryModal"]')!
  expect(modal).not.toBeNull()
  expect(host.contains(modal)).toBe(false)
  expect(modal.parentElement?.getAttribute('data-modal')).toBe('WallpaperLibraryModal')
  for (const part of ['close', 'header', 'header-copy', 'title', 'subtitle', 'count', 'content', 'grid', 'card', 'preview', 'preview-image', 'preview-placeholder', 'placeholder-label', 'video-badge', 'current-badge', 'metadata', 'filename', 'metadata-row', 'metadata-label', 'metadata-value', 'card-actions', 'apply', 'delete', 'footer', 'load-more']) {
    const elements = modal.querySelectorAll(`[data-part="${part}"]`)
    expect(elements.length).toBeGreaterThan(0)
    for (const element of elements) expect(element.classList.length).toBeGreaterThan(0)
  }
  expect(modal.querySelector('[data-part="card"][data-current="true"] [data-part="preview-image"]')).not.toBeNull()
  expect(modal.querySelector('[data-part="card"][data-media-type="video"] [data-part="preview-placeholder"]')).not.toBeNull()
  expect(modal.querySelector('[data-field="resolution"] [data-part="metadata-value"]')?.textContent).toBe('800 x 600')
  await act(async () => (modal.querySelector('[data-part="apply"]') as HTMLButtonElement).click())
  expect(onSelect).toHaveBeenCalledWith({ image_id: 'image', type: 'image' })
  expect(onClose).toHaveBeenCalledTimes(1)
  await act(async () => (modal.querySelector('[data-part="close"]') as HTMLButtonElement).click())
  expect(onClose).toHaveBeenCalledTimes(2)
})

test('keeps loading, empty and error states addressable across reopening', async () => {
  let finish: (result: { data: Image[], total: number }) => void
  listWallpapers.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const props = { target: 'chat' as const, currentImageId: null, onSelect: mock(), onClose: mock() }
  await render(<WallpaperLibraryModal {...props} isOpen />)
  expect(document.querySelector('[data-part="state"][data-state="loading"]')).not.toBeNull()
  await act(async () => finish!({ data: [], total: 0 }))
  expect(document.querySelector('[data-part="state"][data-state="empty"]')).not.toBeNull()
  await act(async () => root.render(<WallpaperLibraryModal {...props} isOpen={false} />))
  expect(document.querySelector('[data-component="WallpaperLibraryModal"]')).toBeNull()
  listWallpapers.mockRejectedValueOnce(new Error('Fixture load failure'))
  await act(async () => root.render(<WallpaperLibraryModal {...props} isOpen />))
  expect(document.querySelector('[data-part="error"]')?.textContent).toBe('Fixture load failure')
})

test('does not assign Wallpaper Library hooks to other modal callers', async () => {
  await render(<ModalShell isOpen onClose={() => {}}>Another modal</ModalShell>)
  expect(document.querySelector('[data-component], [data-modal]')).toBeNull()
})


test('preserves fullscreen sizing and classes alongside optional portal theme hooks', async () => {
  await render(<ModalShell isOpen fullscreen scrollable data-component="FullscreenFixture" onClose={() => {}}>Fullscreen content</ModalShell>)
  const modal = document.querySelector('[data-component="FullscreenFixture"]') as HTMLElement
  expect(modal.classList.contains('fixture_fullscreenModal')).toBe(true)
  expect(modal.classList.contains('fixture_scrollable')).toBe(true)
  expect(modal.style.maxWidth).toBe('')
  expect(modal.style.maxHeight).toBe('')
  expect(modal.parentElement?.classList.contains('fixture_fullscreenBackdrop')).toBe(true)
  expect(modal.parentElement?.getAttribute('data-modal')).toBe('FullscreenFixture')
})
