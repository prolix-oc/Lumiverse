import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { MESSAGE_CONTENT_LAYOUT_EVENT } from '@/lib/message-content-layout'

mock.module('./GreetingImage.module.css', () => ({
  default: { frame: 'frame', artwork: 'artwork', ambient: 'ambient' },
}))

mock.module('@/components/shared/ImageLightbox', () => ({
  default: ({ src, onClose }: { src: string | null; onClose: () => void }) => (src ? (
    <div data-testid="greeting-lightbox" data-src={src}>
      <button type="button" onClick={onClose}>close</button>
    </div>
  ) : null),
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globals = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  CustomEvent: dom.window.CustomEvent,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const originalGlobals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}

const { default: GreetingImage } = await import('./GreetingImage')
let host: HTMLDivElement
let root: Root
let layoutChanges: Array<{ state: string | undefined; hidden: boolean; landscape: boolean; preserveScrollAnchor: boolean }>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  layoutChanges = []
  host.addEventListener(MESSAGE_CONTENT_LAYOUT_EVENT, (event) => {
    const figure = host.querySelector('figure')!
    layoutChanges.push({
      state: figure.dataset.state,
      hidden: figure.hidden === true,
      landscape: figure.hasAttribute('data-landscape'),
      preserveScrollAnchor: (event as CustomEvent).detail?.preserveScrollAnchor,
    })
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-tauri-desktop')
  document.documentElement.removeAttribute('data-platform')
})

afterAll(() => {
  dom.window.close()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

async function render(
  src = '/opening.webp',
  position: 'top' | 'bottom' = 'top',
  onError?: () => void,
  onReady?: () => void,
) {
  await act(async () => root.render(
    <GreetingImage src={src} position={position} alt="Moonlit forest" onError={onError} onReady={onReady} />,
  ))
  return host.querySelector('figure')
}

function artwork() {
  return host.querySelector<HTMLImageElement>('img.artwork')!
}

async function loadImage(image = artwork(), naturalWidth = 1200, naturalHeight = 675) {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: naturalWidth })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: naturalHeight })
  await act(async () => image.dispatchEvent(new dom.window.Event('load')))
}

test('reserves a loading frame and reveals only the artwork after its load succeeds', async () => {
  const figure = (await render())!
  expect(figure.hidden).toBe(false)
  expect(figure.dataset.state).toBe('loading')
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  expect(figure.getAttribute('aria-busy')).toBe('true')
  expect(artwork().getAttribute('alt')).toBe('Moonlit forest')
  const ambient = host.querySelector<HTMLImageElement>('img.ambient')!
  expect(ambient.getAttribute('aria-hidden')).toBe('true')
  expect(ambient.getAttribute('alt')).toBe('')

  // The decorative duplicate must not claim the main artwork has loaded.
  await loadImage(ambient)
  expect(figure.dataset.state).toBe('loading')
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  await loadImage()
  expect(figure.dataset.state).toBe('ready')
  expect(figure.hasAttribute('data-landscape')).toBe(true)
  expect(figure.getAttribute('aria-busy')).toBe('false')
  expect(layoutChanges.at(-1)).toEqual({ state: 'ready', hidden: false, landscape: true, preserveScrollAnchor: true })
})

test('opens the loaded artwork in a lightbox and closes it again', async () => {
  await render()
  await act(async () => artwork().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('[data-testid="greeting-lightbox"]')).toBeNull()

  await loadImage()
  await act(async () => artwork().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  expect(host.querySelector('[data-testid="greeting-lightbox"]')?.getAttribute('data-src')).toBe('/opening.webp')

  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="greeting-lightbox"] button')!.click())
  expect(host.querySelector('[data-testid="greeting-lightbox"]')).toBeNull()
})

test('reports a successful load so the owner can clear a previous failure', async () => {
  const onReady = mock(() => {})
  const onError = mock(() => {})
  await render('/opening.webp', 'top', onError, onReady)
  await loadImage()
  expect(onReady).toHaveBeenCalledTimes(1)
  expect(onError).not.toHaveBeenCalled()
})

test('reports load errors and unusable dimensions to the owner', async () => {
  const onError = mock(() => {})
  await render('/missing.webp', 'top', onError)
  await act(async () => artwork().dispatchEvent(new dom.window.Event('error')))
  expect(onError).toHaveBeenCalledTimes(1)

  const sizingError = mock(() => {})
  await render('/broken.webp', 'top', sizingError)
  await loadImage(artwork(), 0, 0)
  expect(sizingError).toHaveBeenCalledTimes(1)
})

test('collapses a failed image and notifies the message list after the collapse commits', async () => {
  const figure = (await render())!
  await act(async () => artwork().dispatchEvent(new dom.window.Event('error')))
  expect(figure.hidden).toBe(true)
  expect(figure.dataset.state).toBe('failed')
  expect(figure.getAttribute('aria-busy')).toBe('false')
  expect(layoutChanges.at(-1)).toEqual({ state: 'failed', hidden: true, landscape: false, preserveScrollAnchor: true })
})

test.each([
  { width: 0, height: 675 },
  { width: 1200, height: 0 },
  { width: 0, height: 0 },
])('treats unusable image dimensions $width × $height as a failure', async ({ width, height }) => {
  const figure = (await render())!
  await loadImage(artwork(), width, height)
  expect(figure.hidden).toBe(true)
  expect(figure.dataset.state).toBe('failed')
  expect(figure.hasAttribute('data-landscape')).toBe(false)
})

test.each(['ready', 'failed'] as const)('a new greeting image resets the %s state and ignores the old image', async (previousState) => {
  const oldFigure = (await render())!
  const oldImage = artwork()
  if (previousState === 'ready') await loadImage(oldImage)
  else await act(async () => oldImage.dispatchEvent(new dom.window.Event('error')))

  const figure = (await render('/alternate.webp'))!
  expect(figure).not.toBe(oldFigure)
  expect(artwork().getAttribute('src')).toBe('/alternate.webp')
  expect(figure.dataset.state).toBe('loading')
  expect(figure.hidden).toBe(false)
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  const changesAfterSwap = layoutChanges.length
  await loadImage(oldImage)
  await act(async () => oldImage.dispatchEvent(new dom.window.Event('error')))
  expect(layoutChanges.length).toBe(changesAfterSwap)
  expect(figure.dataset.state).toBe('loading')
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  await loadImage()
  expect(figure.dataset.state).toBe('ready')
  expect(figure.hasAttribute('data-landscape')).toBe(true)
})

test.each([
  { shape: 'portrait', width: 675, height: 1200 },
  { shape: 'square', width: 900, height: 900 },
])('changing from landscape to $shape artwork restores its bounded treatment', async ({ shape, width, height }) => {
  const landscape = (await render())!
  await loadImage()
  expect(landscape.hasAttribute('data-landscape')).toBe(true)

  const figure = (await render(`/${shape}.webp`))!
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  await loadImage(artwork(), width, height)
  expect(figure.dataset.state).toBe('ready')
  expect(figure.hidden).toBe(false)
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  expect(layoutChanges.at(-1)).toEqual({ state: 'ready', hidden: false, landscape: false, preserveScrollAnchor: true })
})

test('changing the text-facing edge preserves the loaded image and emits a layout update', async () => {
  const figure = (await render('/opening.webp', 'top'))!
  const image = artwork()
  expect(figure.dataset.position).toBe('top')
  await loadImage()
  const changesBeforeMove = layoutChanges.length

  await render('/opening.webp', 'bottom')
  expect(artwork()).toBe(image)
  expect(figure.dataset.state).toBe('ready')
  expect(figure.dataset.position).toBe('bottom')
  expect(layoutChanges.length).toBe(changesBeforeMove + 1)
})

test('an absent image creates no frame or reserved gap', async () => {
  expect(await render('')).toBeNull()
  expect(host.childElementCount).toBe(0)
})

function macDesktop() {
  document.documentElement.setAttribute('data-tauri-desktop', '')
  document.documentElement.setAttribute('data-platform', 'macos')
}

function deferDecode(image: HTMLImageElement) {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  Object.defineProperty(image, 'decode', { configurable: true, value: () => promise })
  return resolve
}

async function nextPaint() {
  await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()))
}

test('macOS Tauri waits for the mounted image decode and a paint before revealing', async () => {
  macDesktop()
  const figure = (await render())!
  const resolveDecode = deferDecode(artwork())
  expect(figure.hasAttribute('data-mounted-decode')).toBe(true)
  await loadImage()
  expect(figure.dataset.state).toBe('loading')
  expect(figure.hasAttribute('data-landscape')).toBe(false)

  await act(async () => {
    resolveDecode()
    await Promise.resolve()
    await nextPaint()
  })
  expect(figure.dataset.state).toBe('ready')
  expect(figure.hasAttribute('data-landscape')).toBe(true)
  expect(figure.hidden).toBe(false)
})

test('a stale macOS decode cannot reveal a new source or send stale layout updates', async () => {
  macDesktop()
  await render()
  const oldImage = artwork()
  const resolveDecode = deferDecode(oldImage)
  await loadImage()
  const figure = (await render('/alternate.webp'))!
  await loadImage(artwork(), 675, 1200)
  const changesAfterSwap = layoutChanges.length

  await act(async () => {
    resolveDecode()
    oldImage.dispatchEvent(new dom.window.Event('error'))
    await Promise.resolve()
    await nextPaint()
  })
  expect(figure.dataset.state).toBe('ready')
  expect(figure.hasAttribute('data-landscape')).toBe(false)
  expect(layoutChanges.length).toBe(changesAfterSwap)
})

test('an error while decoding cannot be undone by the pending macOS load', async () => {
  macDesktop()
  const figure = (await render())!
  const resolveDecode = deferDecode(artwork())
  await loadImage()
  await act(async () => artwork().dispatchEvent(new dom.window.Event('error')))
  expect(figure.hidden).toBe(true)
  const changesAfterFailure = layoutChanges.length

  await act(async () => {
    resolveDecode()
    await Promise.resolve()
    await nextPaint()
  })
  expect(figure.hidden).toBe(true)
  expect(figure.dataset.state).toBe('failed')
  expect(layoutChanges.length).toBe(changesAfterFailure)
})
