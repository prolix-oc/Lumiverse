import { afterEach, beforeAll, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useEffect } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const prefetchImages = jest.fn()
mock.module('@/lib/imageDecodeCache', () => ({ prefetchImages }))

let createRoot: typeof CreateRoot
let useImagePrefetch: typeof import('./useImagePrefetch').useImagePrefetch
let root: Root
function Probe({ urls }: { urls: string[] }) {
  const prefetch = useImagePrefetch()
  useEffect(() => { prefetch(urls) }, [prefetch, urls])
  return null
}
async function render(urls: string[]) {
  await act(async () => root.render(<Probe urls={urls} />))
}
beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useImagePrefetch } = await import('./useImagePrefetch'))
})
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  prefetchImages.mockClear()
})
function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
}

test('does not resubmit unchanged neighbors when hiding, sorting, or replacing an avatar', async () => {
  mount()
  await render(['a', 'b', 'c', 'b', ''])
  expect(prefetchImages).toHaveBeenCalledWith(['a', 'b', 'c'])
  prefetchImages.mockClear()

  await render(['c', 'b'])
  expect(prefetchImages).not.toHaveBeenCalled()
  await render(['c', 'replacement-b'])
  expect(prefetchImages).toHaveBeenCalledTimes(1)
  expect(prefetchImages).toHaveBeenCalledWith(['replacement-b'])
})

test('warms images again when returning to an earlier range and clears an empty range', async () => {
  mount()
  await render(['a', 'b'])
  await render(['b', 'c'])
  await render(['a', 'b'])
  expect(prefetchImages.mock.calls).toEqual([[['a', 'b']], [['c']], [['a']]])
  prefetchImages.mockClear()

  await render([])
  await render(['a', 'b'])
  expect(prefetchImages).toHaveBeenCalledWith(['a', 'b'])
})
