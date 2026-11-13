/// <reference types="bun-types" />

import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const domWindow = dom.window

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Node: domWindow.Node,
  NodeFilter: domWindow.NodeFilter,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLImageElement: domWindow.HTMLImageElement,
  ShadowRoot: domWindow.ShadowRoot,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: TestResizeObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
})

Object.assign(domWindow, {
  matchMedia: () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => domWindow.setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (id: number) => domWindow.clearTimeout(id),
})
Object.assign(globalThis, {
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

type MatrixStep = {
  kind: 'initial' | 'unchanged' | 'changed' | 'duplicate' | 'added' | 'removed'
  sources: string[]
  text: string
}

type ImageEventCounts = {
  load: number
  error: number
}

type QueryRoot = HTMLElement | ShadowRoot

const imageSources = {
  stable: '/api/v1/images/8eca2a69-43a7-4db7-892a-015ad20792fb',
  removedByChange: '/api/v1/images/46c15853-b0e7-4b2f-bb9c-079ee0fb9da5',
  changed: '/api/v1/images/84030598-8b27-4c16-89c0-2b5ce27e91ce',
  added: '/api/v1/images/f11878b5-8c0f-4c3d-9f4f-f3a25fc5ec96',
} as const

const generatedSequence: MatrixStep[] = [
  ['initial', [imageSources.stable, imageSources.removedByChange]],
  ['unchanged', [imageSources.stable, imageSources.removedByChange]],
  ['changed', [imageSources.stable, imageSources.changed]],
  ['duplicate', [imageSources.stable, imageSources.stable, imageSources.changed]],
  ['added', [imageSources.stable, imageSources.stable, imageSources.changed, imageSources.added]],
  ['removed', [imageSources.stable, imageSources.added]],
].map(([kind, sources], index) => ({
  kind: kind as MatrixStep['kind'],
  sources: sources as string[],
  text: `stream token ${index}`,
}))

function chunkHtml(step: MatrixStep): string {
  const images = step.sources.map((src) => `<img class="roundedImage" src="${src}">`).join('')
  return `<div class="container">${images}<span data-token="${step.kind}">${step.text}</span></div>`
}

function imagesBySrc(root: QueryRoot, src: string): HTMLImageElement[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))
    .filter((image) => image.getAttribute('src') === src)
}

async function runImageIdentityMatrix(
  root: QueryRoot,
  renderStep: (step: MatrixStep, isFinal: boolean) => Promise<void>,
): Promise<Map<MatrixStep['kind'], HTMLImageElement[]>> {
  const eventCounts = new WeakMap<HTMLImageElement, ImageEventCounts>()
  const trackedImages: HTMLImageElement[] = []
  const snapshots = new Map<MatrixStep['kind'], HTMLImageElement[]>()

  const trackLifecycle = (image: HTMLImageElement) => {
    if (eventCounts.has(image)) return
    const counts = { load: 0, error: 0 }
    eventCounts.set(image, counts)
    trackedImages.push(image)
    image.addEventListener('load', () => { counts.load++ })
    image.addEventListener('error', () => { counts.error++ })
  }

  let previousImages = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))
  previousImages.forEach(trackLifecycle)
  snapshots.set('initial', previousImages)

  for (const [index, step] of generatedSequence.slice(1).entries()) {
    const previousBySrc = new Map<string, HTMLImageElement[]>()
    for (const image of previousImages) {
      const src = image.getAttribute('src')
      if (!src) continue
      previousBySrc.set(src, [...(previousBySrc.get(src) ?? []), image])
    }
    const countsBefore = new Map(previousImages.map((image) => [image, { ...eventCounts.get(image)! }]))

    await renderStep(step, index === generatedSequence.length - 2)

    const currentImages = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))
    expect(currentImages.map((image) => image.getAttribute('src'))).toEqual(step.sources)
    expect(root.querySelector('[data-token]')?.getAttribute('data-token')).toBe(step.kind)
    expect(root.querySelector('[data-token]')?.textContent).toBe(step.text)

    const allSources = new Set([...previousBySrc.keys(), ...step.sources])
    for (const src of allSources) {
      const previousMatches = previousBySrc.get(src) ?? []
      const currentMatches = imagesBySrc(root, src)

      if (previousMatches.length > 0 && currentMatches.length > 0) {
        expect(currentMatches[0]).toBe(previousMatches[0])
        expect(eventCounts.get(previousMatches[0])).toEqual(countsBefore.get(previousMatches[0]))
        for (const duplicate of currentMatches.slice(1)) {
          expect(previousMatches).not.toContain(duplicate)
          expect(duplicate).not.toBe(currentMatches[0])
        }
      } else if (previousMatches.length === 0) {
        for (const addedImage of currentMatches) {
          expect(previousImages).not.toContain(addedImage)
        }
      } else {
        expect(currentMatches).toHaveLength(0)
        for (const removedImage of previousMatches) {
          expect(removedImage.isConnected).toBe(false)
        }
      }
    }

    currentImages.forEach(trackLifecycle)
    snapshots.set(step.kind, currentImages)
    previousImages = currentImages
  }

  for (const image of trackedImages) {
    expect(eventCounts.get(image)).toEqual({ load: 0, error: 0 })
  }

  return snapshots
}

test('generated streaming image matrix preserves exact reusable identities and final content', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })

  const mountedHosts: HTMLElement[] = []
  const mountedRoots: Array<{ unmount: () => void }> = []

  try {
    const module = await server.ssrLoadModule('/src/components/chat/MessageContent.tsx') as {
      ProseHtml: (props: { html: string; className?: string }) => unknown
      IsolatedHtml: (props: { html: string; isStreaming: boolean }) => unknown
    }
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')

    const mount = () => {
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      mountedHosts.push(host)
      mountedRoots.push(root)
      return { host, root }
    }

    const initialStep = generatedSequence[0]

    const prose = mount()
    await act(async () => {
      prose.root.render(createElement(module.ProseHtml as never, {
        className: 'prose',
        html: chunkHtml(initialStep),
      } as never))
    })

    const proseRoot = prose.host.firstElementChild as HTMLElement
    const initialProseImage = imagesBySrc(proseRoot, imageSources.stable)[0]
    const initialChangedImage = imagesBySrc(proseRoot, imageSources.removedByChange)[0]
    const initialRootRect = { width: 320, height: 180 }
    Object.defineProperties(proseRoot, {
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ ...initialRootRect, x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 180, toJSON() {} }),
      },
    })
    Object.defineProperties(initialProseImage, {
      complete: { configurable: true, get: () => true },
      naturalWidth: { configurable: true, get: () => 640 },
      naturalHeight: { configurable: true, get: () => 360 },
      currentSrc: { configurable: true, get: () => imageSources.stable },
    })

    const proseSnapshots = await runImageIdentityMatrix(proseRoot, async (step) => {
      await act(async () => {
        prose.root.render(createElement(module.ProseHtml as never, {
          className: 'prose',
          html: chunkHtml(step),
        } as never))
      })
    })

    const unchangedProseImages = proseSnapshots.get('unchanged')!
    const changedProseImages = proseSnapshots.get('changed')!
    const duplicateProseImages = proseSnapshots.get('duplicate')!
    const addedProseImages = proseSnapshots.get('added')!
    const removedProseImages = proseSnapshots.get('removed')!
    expect(unchangedProseImages[0]).toBe(initialProseImage)
    expect(unchangedProseImages[1]).toBe(initialChangedImage)
    expect(changedProseImages[0]).toBe(initialProseImage)
    expect(changedProseImages[1]).not.toBe(initialChangedImage)
    expect(duplicateProseImages[0]).toBe(initialProseImage)
    expect(duplicateProseImages[1]).not.toBe(initialProseImage)
    expect(addedProseImages[0]).toBe(initialProseImage)
    expect(addedProseImages[3]).not.toBe(duplicateProseImages[1])
    expect(removedProseImages).toHaveLength(2)
    expect(removedProseImages[0]).toBe(initialProseImage)
    expect(initialChangedImage.isConnected).toBe(false)
    expect(initialProseImage.getAttribute('src')).toBe(imageSources.stable)
    expect(initialProseImage.currentSrc).toBe(imageSources.stable)
    expect(initialProseImage.complete).toBe(true)
    expect(initialProseImage.naturalWidth).toBe(640)
    expect(initialProseImage.naturalHeight).toBe(360)
    expect(proseRoot.getBoundingClientRect().height).toBe(initialRootRect.height)

    const island = mount()
    await act(async () => {
      island.root.render(createElement(module.IsolatedHtml as never, {
        html: `<style>.container{display:block}</style>${chunkHtml(initialStep)}`,
        isStreaming: true,
      } as never))
    })
    const islandHost = island.host.querySelector('[data-lumiverse-html-island]') as HTMLElement
    const shadowRoot = islandHost.shadowRoot!
    const initialIslandImage = imagesBySrc(shadowRoot, imageSources.stable)[0]

    const islandSnapshots = await runImageIdentityMatrix(shadowRoot, async (step, isFinal) => {
      await act(async () => {
        island.root.render(createElement(module.IsolatedHtml as never, {
          html: `<style>.container{display:block}</style>${chunkHtml(step)}`,
          isStreaming: !isFinal,
        } as never))
      })
    })

    const finalStep = generatedSequence.at(-1)!
    expect(islandHost.shadowRoot).toBe(shadowRoot)
    expect(islandSnapshots.get('unchanged')?.[0]).toBe(initialIslandImage)
    expect(islandSnapshots.get('duplicate')?.[0]).toBe(initialIslandImage)
    expect(islandSnapshots.get('duplicate')?.[1]).not.toBe(initialIslandImage)
    expect(islandSnapshots.get('removed')?.[0]).toBe(initialIslandImage)
    expect(shadowRoot.querySelector('.container')?.outerHTML).toBe(chunkHtml(finalStep))
    expect(shadowRoot.querySelector('[data-token]')?.textContent).toBe(finalStep.text)

    const nonStreaming = mount()
    const settledInitial = '<article data-preservation="non-streaming"><img src="/api/v1/images/settled"><span>settled first</span></article>'
    const settledFinal = '<article data-preservation="non-streaming"><img src="/api/v1/images/settled"><span>settled final</span></article>'
    await act(async () => {
      nonStreaming.root.render(createElement(module.IsolatedHtml as never, {
        html: settledInitial,
        isStreaming: false,
      } as never))
    })
    const nonStreamingHost = nonStreaming.host.querySelector('[data-lumiverse-html-island]') as HTMLElement
    const nonStreamingShadow = nonStreamingHost.shadowRoot!
    const settledImage = nonStreamingShadow.querySelector('img') as HTMLImageElement
    let settledLoadCount = 0
    let settledErrorCount = 0
    settledImage.addEventListener('load', () => { settledLoadCount++ })
    settledImage.addEventListener('error', () => { settledErrorCount++ })

    await act(async () => {
      nonStreaming.root.render(createElement(module.IsolatedHtml as never, {
        html: settledFinal,
        isStreaming: false,
      } as never))
    })
    expect(nonStreamingHost.shadowRoot).toBe(nonStreamingShadow)
    expect(nonStreamingShadow.querySelector('img')).toBe(settledImage)
    expect(nonStreamingShadow.querySelector('[data-preservation="non-streaming"]')?.outerHTML).toBe(settledFinal)
    expect(settledLoadCount).toBe(0)
    expect(settledErrorCount).toBe(0)

    const imageFree = mount()
    const imageFreeChunks = ['plain first', 'plain advancing', 'plain final']
    for (const text of imageFreeChunks) {
      await act(async () => {
        imageFree.root.render(createElement(module.ProseHtml as never, {
          className: 'prose',
          html: `<p data-preservation="image-free">${text}</p>`,
        } as never))
      })
      const imageFreeRoot = imageFree.host.firstElementChild as HTMLElement
      expect(imageFreeRoot.querySelectorAll('img')).toHaveLength(0)
      expect(imageFreeRoot.querySelector('[data-preservation="image-free"]')?.outerHTML)
        .toBe(`<p data-preservation="image-free">${text}</p>`)
    }
  } finally {
    const { act } = await import('react')
    for (const root of mountedRoots) {
      await act(async () => root.unmount())
    }
    mountedHosts.forEach((host) => host.remove())
    await server.close()
    dom.window.close()
  }
}, 30_000)
