import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { setIOSMediaCacheAccount } from '@/lib/ios-media-cache'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalIntersectionObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLImageElement: domWindow.HTMLImageElement,
  Event: domWindow.Event,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let createRoot: typeof CreateRoot
let LazyImage: typeof import('./LazyImage').default
let CachedImage: typeof import('./CachedImage').default
let HomepageLibraryCardImage: typeof import('@/components/landing/HomepageLibraryCardImage').default
let clearImageCache: typeof import('@/lib/imageDecodeCache').clearImageCache
let rememberImageDecoded: typeof import('@/lib/imageDecodeCache').rememberImageDecoded
const roots: Root[] = []

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: LazyImage } = await import('./LazyImage'))
  ;({ default: CachedImage } = await import('./CachedImage'))
  ;({ default: HomepageLibraryCardImage } = await import('@/components/landing/HomepageLibraryCardImage'))
  ;({ clearImageCache, rememberImageDecoded } = await import('@/lib/imageDecodeCache'))
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.replaceChildren()
  setIOSMediaCacheAccount(null)
  delete (window as any).__LUMIVERSE_IOS_NATIVE__
  document.documentElement.removeAttribute('data-tauri-desktop')
  document.documentElement.removeAttribute('data-platform')
  document.documentElement.removeAttribute('data-tauri-mobile')
  if (originalIntersectionObserver) {
    Object.defineProperty(globalThis, 'IntersectionObserver', originalIntersectionObserver)
  } else {
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver
  }
  clearImageCache()
})

afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: Document }).document
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete (globalThis as { window?: Window }).window
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete (globalThis as { navigator?: Navigator }).navigator
})

async function renderCachedImage() {
  rememberImageDecoded('/cached.webp')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LazyImage src="/cached.webp" alt="Cached" />))
  return host.querySelector('img')!
}

async function paintReveal() {
  await new Promise<void>(resolve => domWindow.requestAnimationFrame(() => {
    domWindow.requestAnimationFrame(() => domWindow.requestAnimationFrame(() => resolve()))
  }))
}

function installTestIntersectionObserver() {
  let observerCallback: IntersectionObserverCallback | null = null
  let observerInstance: IntersectionObserver | null = null
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = '320px 0px'
    readonly scrollMargin = '0px'
    readonly thresholds = [0]

    constructor(callback: IntersectionObserverCallback) {
      observerCallback = callback
      observerInstance = this
    }

    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
    unobserve() {}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: TestIntersectionObserver,
  })

  return (target: Element) => {
    observerCallback!([{
      isIntersecting: true,
      target,
    } as unknown as IntersectionObserverEntry], observerInstance!)
  }
}

describe('LazyImage decoded-image presentation', () => {
  test('iOS presents cached avatar bytes and retries the original URL if the cached image fails', async () => {
    document.documentElement.setAttribute('data-tauri-mobile', 'ios')
    const actions: string[] = []
    ;(window as any).__LUMIVERSE_IOS_NATIVE__ = { version: 1, mediaCache: 1, async request(action: string) {
      actions.push(action)
      if (action === 'mediaCache.read') return { scope: 'alice-session', contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwZkAAAAASUVORK5CYII=' }
      return {}
    } }
    setIOSMediaCacheAccount('alice')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const src = '/api/v1/images/avatar?size=lg'
    await act(async () => root.render(<LazyImage src={src} loading="eager" fallback={<span>Unavailable</span>} />))
    const image = host.querySelector('img')!
    expect(image.src.startsWith('blob:')).toBe(true)
    expect(image.style.opacity).toBe('0')
    await act(async () => image.dispatchEvent(new domWindow.Event('error')))
    expect(image.getAttribute('src')).toBe(src)
    expect(actions).toContain('mediaCache.remove')
    expect(host.textContent).not.toContain('Unavailable')
    await act(async () => { image.dispatchEvent(new domWindow.Event('load')); await paintReveal() })
    expect(image.style.opacity).toBe('1')
    expect(image.style.transition).toContain('opacity 0.2s')
    expect(host.querySelector('svg')).toBeNull()
  })

  test('Android virtualized images request immediately and reveal without replaying an opacity fade', async () => {
    document.documentElement.setAttribute('data-tauri-mobile', 'android')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(<LazyImage src="/android.webp" />))
    const image = host.querySelector('img')!
    expect(image.loading || image.getAttribute('loading')).toBe('eager')
    expect(image.style.transition).not.toContain('opacity')
    await act(async () => image.dispatchEvent(new domWindow.Event('load')))
    expect(image.style.opacity).toBe('1')
  })

  test('cached browser images wait for their own decode before fading in', async () => {
    const image = await renderCachedImage()
    let finishDecode!: () => void
    Object.defineProperty(image, 'decode', { configurable: true, value: () => new Promise<void>(resolve => { finishDecode = resolve }) })
    expect(image.style.opacity).toBe('0')
    expect(image.style.transition).toContain('opacity 0.2s')
    await act(async () => { image.dispatchEvent(new domWindow.Event('load')); await paintReveal() })
    expect(image.style.opacity).toBe('0')
    await act(async () => { finishDecode(); await paintReveal() })
    expect(image.style.opacity).toBe('1')
  })

  test('an old decode cannot reveal a replacement source, even when the image element is reused', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(<LazyImage src="/first.webp" />))
    const image = host.querySelector('img')!
    let finishOldDecode!: () => void
    Object.defineProperty(image, 'decode', { configurable: true, value: () => new Promise<void>(resolve => { finishOldDecode = resolve }) })
    await act(async () => image.dispatchEvent(new domWindow.Event('load')))
    await act(async () => root.render(<LazyImage src="/replacement.webp" />))
    await act(async () => { finishOldDecode(); await paintReveal() })
    expect(host.querySelector('img')).toBe(image)
    expect(image.style.opacity).toBe('0')
    Object.defineProperty(image, 'decode', { configurable: true, value: () => Promise.resolve() })
    await act(async () => { image.dispatchEvent(new domWindow.Event('load')); await paintReveal() })
    expect(image.style.opacity).toBe('1')
  })

  test('layered images decode before revealing and retain their transform transition', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(<CachedImage src="/layer.webp" style={{ transform: 'scale(1.1)' }} />))
    const image = host.querySelector('img')!
    let finishDecode!: () => void
    Object.defineProperty(image, 'decode', { configurable: true, value: () => new Promise<void>(resolve => { finishDecode = resolve }) })
    await act(async () => image.dispatchEvent(new domWindow.Event('load')))
    expect(image.style.opacity).toBe('0')
    await act(async () => { finishDecode(); await paintReveal() })
    expect(image.style.opacity).toBe('1')
    expect(image.style.transform).toBe('scale(1.1)')
    expect(image.style.transition).toContain('transform var(--lazy-image-transform-transition')
  })

  test('waits for the mounted image element in the macOS Tauri WebView', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'macos')

    const image = await renderCachedImage()
    let resolveDecode!: () => void
    const decoded = new Promise<void>((resolve) => { resolveDecode = resolve })
    Object.defineProperty(image, 'decode', { configurable: true, value: () => decoded })
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      image.dispatchEvent(new domWindow.Event('load'))
      await Promise.resolve()
    })
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      resolveDecode()
      await decoded
      await paintReveal()
    })
    expect(image.style.visibility).toBe('visible')
  })
})

describe('homepage library image memory contract', () => {
  test('requests only near-viewport cards and reveals after the mounted WKWebView element decodes', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'macos')
    const intersect = installTestIntersectionObserver()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(
      <HomepageLibraryCardImage src="/library-card.webp" alt="Library card" />,
    ))

    const image = host.querySelector('img')!
    expect(image.hasAttribute('src')).toBe(false)
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      intersect(image)
    })

    let resolveDecode!: () => void
    const decoded = new Promise<void>((resolve) => { resolveDecode = resolve })
    Object.defineProperty(image, 'decode', { configurable: true, value: () => decoded })

    expect(image.getAttribute('src')).toBe('/library-card.webp')
    expect(image.getAttribute('loading')).toBe('eager')
    expect(image.getAttribute('decoding')).toBe('sync')
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      image.dispatchEvent(new domWindow.Event('load'))
      await Promise.resolve()
    })
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      resolveDecode()
      await decoded
      await paintReveal()
    })
    expect(image.style.visibility).toBe('visible')
  })

  test('bounds non-macOS Tauri requests without applying the WKWebView paint guard', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    const intersect = installTestIntersectionObserver()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(
      <HomepageLibraryCardImage src="/windows-card.webp" alt="Windows card" />,
    ))

    const image = host.querySelector('img')!
    expect(image.hasAttribute('src')).toBe(false)
    expect(image.style.visibility).toBe('hidden')

    await act(async () => intersect(image))

    expect(image.getAttribute('src')).toBe('/windows-card.webp')
    expect(image.getAttribute('loading')).toBe('eager')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.style.visibility).toBe('visible')
  })
})
