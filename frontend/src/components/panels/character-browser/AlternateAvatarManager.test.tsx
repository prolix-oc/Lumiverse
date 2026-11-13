import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, type ComponentProps, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import panels from '@/i18n/locales/en/panels.json'
import common from '@/i18n/locales/en/common.json'
import type { CharacterGalleryItem } from '@/types/api'
import { notifyGalleryItemRemoved, notifyImageDeleted } from '@/lib/deletion-events'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const list = mock((_characterId: string): Promise<CharacterGalleryItem[]> => Promise.resolve([]))
mock.module('@/api/character-gallery', () => ({ characterGalleryApi: { list, smallUrl: (id: string) => `/images/${id}?size=sm` } }))
mock.module('@/api/images', () => ({ imagesApi: { url: (id: string) => `/images/${id}`, smallUrl: (id: string) => `/images/${id}?size=sm` } }))
mock.module('@/components/shared/LazyImage', () => ({ default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} /> }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
mock.module('@/components/shared/ImageCropModal', () => ({
  default: ({ isOpen, imageSrc, onCropDone, onCancel }: { isOpen: boolean; imageSrc: string; onCropDone: (blob: Blob) => void; onCancel: () => void }) => isOpen ? (
    <div data-crop-source={imageSrc}>
      <button onClick={() => onCropDone(new Blob(['crop'], { type: 'image/png' }))}>Confirm crop</button>
      <button onClick={onCancel}>Cancel crop</button>
    </div>
  ) : null,
}))

const { createRoot } = await import('react-dom/client')
const { default: AlternateAvatarManager } = await import('./AlternateAvatarManager')
type Props = ComponentProps<typeof AlternateAvatarManager>
const i18n = createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { panels, common } }, interpolation: { escapeValue: false } })
})

let root: Root
let host: HTMLDivElement
let props: Props
beforeEach(() => {
  list.mockReset()
  list.mockResolvedValue([])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  props = {
    characterId: 'character-a', primaryImageId: null, alternates: [], bindings: {}, alternateFields: {}, greetingCount: 1,
    onChange: mock(() => {}), onBindingsChange: mock(() => {}), openCropFlow: mock(() => {}), onGalleryCropComplete: mock(() => {}),
  }
})
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render() {
  await act(async () => { root.render(<I18nextProvider i18n={i18n}><AlternateAvatarManager key={props.characterId} {...props} /></I18nextProvider>) })
}
function button(label: string) {
  const result = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function click(label: string) { await act(async () => { button(label).click() }) }
function item(id = 'winter'): CharacterGalleryItem {
  return { id, image_id: `${id}-image`, caption: id, reference: `gallery://${id}`, sort_order: 0 } as CharacterGalleryItem
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('alternate avatar gallery selection', () => {
  test('shows loading, then opens the full gallery image in the cropper and saves only on crop confirmation', async () => {
    const request = deferred<CharacterGalleryItem[]>()
    list.mockReturnValueOnce(request.promise)
    await render()
    expect(button('Upload avatar').disabled).toBe(false)
    await click('Add from Gallery')
    expect(list).toHaveBeenCalledWith('character-a')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading')
    await act(async () => { request.resolve([item()]) })
    await click('winter')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[data-crop-source]')?.getAttribute('data-crop-source')).toBe('/images/winter-image')
    expect(props.onGalleryCropComplete).not.toHaveBeenCalled()
    await click('Confirm crop')
    expect(props.onGalleryCropComplete).toHaveBeenCalledWith(expect.any(File), item())
    expect(props.onChange).not.toHaveBeenCalled()
    expect(host.querySelector('[data-crop-source]')).toBeNull()
  })

  test('cancelling the picker or crop leaves the avatar list unchanged', async () => {
    list.mockResolvedValue([item()])
    await render()
    await click('Add from Gallery')
    await click('Cancel')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click('Add from Gallery')
    await click('winter')
    await click('Cancel crop')
    expect(props.onGalleryCropComplete).not.toHaveBeenCalled()
    expect(props.onChange).not.toHaveBeenCalled()
  })

  test('distinguishes a loading failure from an empty gallery and allows retry', async () => {
    list.mockRejectedValueOnce(new Error('Offline'))
    await render()
    await click('Add from Gallery')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load gallery images.')
    await click('Retry')
    expect(host.textContent).toContain(panels.characterEditor.expressionEditor.noGalleryImages)
    expect(list).toHaveBeenCalledTimes(2)
    await click('Cancel')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  test('filters deleted images and removed gallery items, including events received while open', async () => {
    const request = deferred<CharacterGalleryItem[]>()
    list.mockReturnValueOnce(request.promise)
    await render()
    await click('Add from Gallery')
    await act(async () => {
      notifyImageDeleted('deleted-image')
      notifyGalleryItemRemoved({ characterId: 'character-a', id: 'removed', status: 'completed' })
      request.resolve([item('deleted'), item('removed'), item('live'), item('other')])
    })
    expect(host.querySelectorAll('[role="dialog"] img')).toHaveLength(2)
    await act(async () => {
      notifyImageDeleted('live-image')
      notifyGalleryItemRemoved({ characterId: 'another-character', id: 'other', status: 'completed' })
    })
    expect(host.querySelectorAll('[role="dialog"] img')).toHaveLength(1)
    await act(async () => { notifyGalleryItemRemoved({ characterId: 'character-a', id: 'other', status: 'completed' }) })
    expect(host.querySelectorAll('[role="dialog"] img')).toHaveLength(0)
  })

  test('ignores a late gallery response after cancellation and reloads on reopening', async () => {
    const request = deferred<CharacterGalleryItem[]>()
    list.mockReturnValueOnce(request.promise)
    await render()
    await click('Add from Gallery')
    await click('Cancel')
    list.mockResolvedValueOnce([item('fresh')])
    await click('Add from Gallery')
    await act(async () => { request.resolve([item('stale')]) })
    expect(button('fresh')).toBeDefined()
    expect(host.querySelector('button[aria-label="stale"]')).toBeNull()
  })

  test('switching characters closes the picker and prevents a stale selection', async () => {
    const request = deferred<CharacterGalleryItem[]>()
    list.mockReturnValueOnce(request.promise)
    await render()
    await click('Add from Gallery')
    props.characterId = 'character-b'
    await render()
    await act(async () => { request.resolve([item('stale-character')]) })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click('Add from Gallery')
    expect(list).toHaveBeenLastCalledWith('character-b')
    expect(host.querySelector('button[aria-label="stale-character"]')).toBeNull()
  })

  test('disables both add actions during an upload and preserves local file selection', async () => {
    props.uploadProgress = 45
    await render()
    expect(button('Add from Gallery').disabled).toBe(true)
    expect(button('Upload avatar').disabled).toBe(true)
    props.uploadProgress = null
    await render()
    const file = new File(['local'], 'local.png', { type: 'image/png' })
    const input = host.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    expect(props.openCropFlow).toHaveBeenCalledWith(file)
  })
})
