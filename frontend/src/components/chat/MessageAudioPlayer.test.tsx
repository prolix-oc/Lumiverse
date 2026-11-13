import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { _resetFreshMarkers, markFreshlyAttached } from '@/lib/ttsPersistence'

let session = 0
const speak = mock(() => {})
mock.module('@/lib/ttsAudio', () => ({
  speak, stop: () => { session++ }, getPlaybackSession: () => session,
  getActiveMessageId: () => null, subscribeActiveMessage: () => () => {}, trackTTSAudioElement: () => () => {},
}))
mock.module('@/lib/toast', () => ({ toast: { error() {} } }))
const { default: MessageAudioPlayer } = await import('./MessageAudioPlayer')
let dom: JSDOM
let root: Root
let host: HTMLDivElement
let play: ReturnType<typeof mock>
const originalFetch = globalThis.fetch
const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.example/' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
  session = 0
  speak.mockClear()
  _resetFreshMarkers()
  play = mock(() => Promise.resolve())
  dom.window.HTMLMediaElement.prototype.play = play
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  dom.window.close()
  globalThis.fetch = originalFetch
  _resetFreshMarkers()
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
function mount() {
  markFreshlyAttached('message', { autoPlay: true, playbackSession: session })
  act(() => root.render(<MessageAudioPlayer src="/audio/saved" messageId="message" />))
}
function finishAnimation() {
  act(() => host.firstElementChild!.dispatchEvent(new dom.window.Event('animationend', { bubbles: true })))
}
test('current auto-play still starts after its load-in animation', () => {
  mount()
  finishAnimation()
  expect(play).toHaveBeenCalledTimes(1)
})
test('a voice preview starts immediately and pauses when its player closes', () => {
  const pause = mock(() => {})
  dom.window.HTMLMediaElement.prototype.pause = pause
  act(() => root.render(<MessageAudioPlayer src="/audio/preview" autoPlay />))
  expect(play).toHaveBeenCalledTimes(1)
  act(() => root.render(null))
  expect(pause).toHaveBeenCalledTimes(1)
})
test('a stop while the player animates prevents delayed auto-play', () => {
  mount()
  session++
  finishAnimation()
  expect(play).not.toHaveBeenCalled()
})
test('a stop before autoplay-policy rejection prevents engine fallback', async () => {
  let reject!: (error: Error) => void
  play.mockImplementation(() => new Promise<void>((_resolve, no) => { reject = no }))
  const fetch = mock(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  mount()
  finishAnimation()
  session++
  await act(async () => { reject(new DOMException('User gesture required', 'NotAllowedError')); await Bun.sleep(0) })
  expect(fetch).not.toHaveBeenCalled()
  expect(speak).not.toHaveBeenCalled()
})
test('a stop while engine fallback fetches audio discards the late buffer', async () => {
  play.mockImplementation(() => Promise.reject(new DOMException('User gesture required', 'NotAllowedError')))
  let resolve!: (response: Response) => void
  const fetch = mock(() => new Promise<Response>(yes => { resolve = yes }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  mount()
  await act(async () => { finishAnimation(); await Bun.sleep(0) })
  expect(fetch).toHaveBeenCalledTimes(1)
  session++
  await act(async () => { resolve(new Response(new Uint8Array([1, 2, 3]))); await Bun.sleep(0) })
  expect(speak).not.toHaveBeenCalled()
})
